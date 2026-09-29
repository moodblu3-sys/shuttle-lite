export interface AuthUser {
  id: string;
  name: string;
  login: string;
  enterpriseId: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface OAuthRepository {
  getUser(id: string): AuthUser | null;
  saveUser(user: AuthUser, tokens: OAuthTokens): void;
  getTokens(id: string): OAuthTokens | null;
  claimRefresh(id: string, claim: string): boolean;
  finishRefresh(id: string, claim: string, tokens: OAuthTokens | null): boolean;
}
