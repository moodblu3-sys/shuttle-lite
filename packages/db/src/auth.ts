import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { AuthUser, OAuthRepository, OAuthTokens } from '@shuttle-lite/core';
import { ShuttleError } from '@shuttle-lite/core';
import type { SqliteDatabase } from './sqlite';

export const authDigest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('hex');

/** Tokens are encrypted at rest; session and state secrets are stored only as hashes. */
export class AuthStore implements OAuthRepository {
  constructor(
    readonly db: SqliteDatabase,
    private readonly key: string,
  ) {
    if (!/^[a-f0-9]{64}$/i.test(key))
      throw new ShuttleError('CONFIG_INVALID', '認証暗号鍵が不正です。');
  }

  getUser(id: string): AuthUser | null {
    return (
      (this.db
        .prepare('SELECT id, name, login, enterprise_id AS enterpriseId FROM auth_users WHERE id=?')
        .get(id) as AuthUser | undefined) ?? null
    );
  }

  saveUser(user: AuthUser, tokens: OAuthTokens): void {
    this.db
      .prepare(
        `INSERT INTO auth_users (id,name,login,enterprise_id,tokens,expires_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,login=excluded.login,
      enterprise_id=excluded.enterprise_id,tokens=excluded.tokens,expires_at=excluded.expires_at,
      refresh_lock=NULL,refresh_lock_until=0`,
      )
      .run(
        user.id,
        user.name,
        user.login,
        user.enterpriseId,
        this.encrypt(user.id, tokens),
        tokens.expiresAt,
      );
  }

  private encrypt(id: string, tokens: OAuthTokens): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(this.key, 'hex'), iv);
    cipher.setAAD(Buffer.from(id));
    const data = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64')).join('.');
  }

  getTokens(id: string): OAuthTokens | null {
    const row = this.db.prepare('SELECT tokens FROM auth_users WHERE id=?').get(id) as
      { tokens: string | null } | undefined;
    if (!row?.tokens) return null;
    try {
      const [iv, tag, data] = row.tokens.split('.').map((part) => Buffer.from(part, 'base64'));
      const cipher = createDecipheriv('aes-256-gcm', Buffer.from(this.key, 'hex'), iv!);
      cipher.setAAD(Buffer.from(id));
      cipher.setAuthTag(tag!);
      return JSON.parse(
        Buffer.concat([cipher.update(data!), cipher.final()]).toString('utf8'),
      ) as OAuthTokens;
    } catch {
      throw new ShuttleError(
        'BOX_AUTH',
        '認証情報を復元できません。Boxにログインし直してください。',
      );
    }
  }

  claimRefresh(id: string, claim: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE auth_users SET refresh_lock=?,refresh_lock_until=?
      WHERE id=? AND tokens IS NOT NULL AND (refresh_lock IS NULL OR refresh_lock_until<?)`,
        )
        .run(claim, Date.now() + 120_000, id, Date.now()).changes === 1
    );
  }

  finishRefresh(id: string, claim: string, tokens: OAuthTokens | null): boolean {
    return (
      this.db
        .prepare(
          `UPDATE auth_users SET tokens=?,expires_at=?,refresh_lock=NULL,refresh_lock_until=0
      WHERE id=? AND refresh_lock=?`,
        )
        .run(tokens ? this.encrypt(id, tokens) : null, tokens?.expiresAt ?? 0, id, claim)
        .changes === 1
    );
  }

  createSession(userId: string): string {
    const token = secret();
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now());
    this.db
      .prepare('INSERT INTO auth_sessions VALUES (?,?,?)')
      .run(authDigest(token), userId, Date.now() + 12 * 60 * 60 * 1000);
    return token;
  }

  session(token: string | undefined): AuthUser | null {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const row = this.db
      .prepare('SELECT user_id FROM auth_sessions WHERE digest=? AND expires_at>?')
      .get(authDigest(token), Date.now()) as { user_id: string } | undefined;
    return row ? this.getUser(row.user_id) : null;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE digest=?').run(authDigest(token));
  }

  createState(): string {
    const state = secret();
    this.db.prepare('DELETE FROM auth_states WHERE expires_at <= ?').run(Date.now());
    this.db
      .prepare('INSERT INTO auth_states VALUES (?,?)')
      .run(authDigest(state), Date.now() + 5 * 60 * 1000);
    return state;
  }

  consumeState(state: string, cookie: string | undefined): boolean {
    if (!cookie || !/^[a-f0-9]{64}$/.test(state) || state !== cookie) return false;
    return (
      this.db
        .prepare('DELETE FROM auth_states WHERE digest=? AND expires_at>?')
        .run(authDigest(state), Date.now()).changes === 1
    );
  }
}
