import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AppConfig } from '@shuttle-lite/config';
import {
  ShuttleError,
  sleep,
  type AuthUser,
  type OAuthRepository,
  type OAuthTokens,
} from '@shuttle-lite/core';
import { BoxHttpClient } from './http/client';
import { createBoxGateway } from './factory';
import type { BoxGateway } from './gateway';

const loginRequired = () =>
  new ShuttleError('BOX_AUTH', 'Boxにログインし直してから移行を再開してください。');

export class BoxOAuth {
  readonly client: BoxHttpClient;
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly gateways = new Map<string, BoxGateway>();

  constructor(
    readonly config: AppConfig,
    readonly repository: OAuthRepository,
  ) {
    this.client = new BoxHttpClient({
      box: { ...config.box, accessToken: undefined },
      proxy: config.proxy,
    });
  }

  get redirectUri(): string {
    return `${new URL(this.config.env.SHUTTLE_APP_URL).origin}/api/auth/callback`;
  }

  authorizationUrl(state: string): string {
    const url = new URL('https://account.box.com/api/oauth2/authorize');
    url.search = new URLSearchParams({
      client_id: this.config.box.clientId!,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      state,
    }).toString();
    return url.href;
  }

  private async exchange(parameters: Record<string, string>): Promise<OAuthTokens> {
    try {
      const result = await this.client.json<{
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      }>({
        method: 'POST',
        url: `${this.config.box.authBaseUrl}/token`,
        skipAuth: true,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          ...parameters,
          client_id: this.config.box.clientId!,
          client_secret: this.config.box.clientSecret!,
        }).toString(),
        timeoutMs: 30_000,
      });
      if (
        !result.access_token ||
        !result.refresh_token ||
        !Number.isFinite(result.expires_in) ||
        result.expires_in! <= 0
      )
        throw loginRequired();
      return {
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        expiresAt: Date.now() + result.expires_in! * 1000,
      };
    } catch {
      // OAuth errors can contain request details. Never expose credentials or codes.
      throw loginRequired();
    }
  }

  async authorize(code: string): Promise<AuthUser> {
    const tokens = await this.exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
    });
    const who = await this.client.json<{
      id: string;
      name: string;
      login: string;
      status: string;
      enterprise?: { id: string };
    }>({
      method: 'GET',
      url: `${this.config.box.apiBaseUrl}/users/me?fields=id,name,login,enterprise,status`,
      skipAuth: true,
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    if (
      !/^\d+$/.test(who.id) ||
      who.enterprise?.id !== this.config.box.enterpriseId ||
      who.status !== 'active'
    )
      throw new ShuttleError('BOX_AUTH', 'この組織の有効なBoxアカウントでログインしてください。');
    const user = { id: who.id, name: who.name, login: who.login, enterpriseId: who.enterprise!.id };
    this.repository.saveUser(user, tokens);
    return user;
  }

  accessToken(id: string, force = false): Promise<string> {
    if (this.repository.getUser(id)?.enterpriseId !== this.config.box.enterpriseId)
      return Promise.reject(loginRequired());
    const pending = this.inFlight.get(id);
    if (pending) return pending;
    const task = this.refresh(id, force).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, task);
    return task;
  }

  private async refresh(id: string, force: boolean): Promise<string> {
    const original = this.repository.getTokens(id);
    if (!original) throw loginRequired();
    if (!force && original.expiresAt > Date.now() + 60_000) return original.accessToken;
    const claim = randomUUID();
    for (let attempt = 0; attempt < 200; attempt++) {
      const latest = this.repository.getTokens(id);
      if (!latest) throw loginRequired();
      if (latest.accessToken !== original.accessToken && latest.expiresAt > Date.now() + 60_000)
        return latest.accessToken;
      if (this.repository.claimRefresh(id, claim)) {
        try {
          // Re-read after acquiring the cross-process lock: refresh tokens are single use.
          const current = this.repository.getTokens(id);
          if (!current) throw loginRequired();
          if (
            current.accessToken !== original.accessToken &&
            current.expiresAt > Date.now() + 60_000
          ) {
            this.repository.finishRefresh(id, claim, current);
            return current.accessToken;
          }
          const tokens = await this.exchange({
            grant_type: 'refresh_token',
            refresh_token: current.refreshToken,
          });
          if (!this.repository.finishRefresh(id, claim, tokens)) throw loginRequired();
          return tokens.accessToken;
        } catch {
          // A lost refresh response is ambiguous; require reauthentication, never replay it.
          this.repository.finishRefresh(id, claim, null);
          throw loginRequired();
        }
      }
      await sleep(200);
    }
    throw loginRequired();
  }

  userConfig(id: string): AppConfig {
    if (
      !/^\d+$/.test(id) ||
      this.repository.getUser(id)?.enterpriseId !== this.config.box.enterpriseId
    )
      throw loginRequired();
    return {
      ...this.config,
      dataDir: join(this.config.dataDir, 'users', id),
      box: {
        ...this.config.box,
        accessToken: undefined,
        rootFolderId: undefined,
        stagingFolderId: undefined,
        needsReviewFolderId: undefined,
        reportsFolderId: undefined,
        tokenProvider: (force) => this.accessToken(id, force),
      },
    };
  }

  gateway(id: string): BoxGateway {
    let gateway = this.gateways.get(id);
    if (!gateway) {
      gateway = createBoxGateway(this.userConfig(id));
      this.gateways.set(id, gateway);
    }
    return gateway;
  }

  async close(): Promise<void> {
    await this.client.close();
    await Promise.all([...this.gateways.values()].map((gateway) => gateway.close()));
  }
}
