import { afterEach, describe, expect, it } from 'vitest';
import { AuthStore, migrate, openDatabase } from '../src/index';

const db = openDatabase({ path: ':memory:' });
migrate(db);
const key = 'ab'.repeat(32);
const auth = new AuthStore(db, key);
const user = { id: '11', name: '山田', login: 'yamada@example.test', enterpriseId: '99' };
const tokens = {
  accessToken: 'secret-access',
  refreshToken: 'secret-refresh',
  expiresAt: Date.now() + 3600_000,
};
afterEach(() => {
  db.exec('DELETE FROM auth_sessions; DELETE FROM auth_states; DELETE FROM auth_users;');
});

describe('authenticated identity storage', () => {
  it('encrypts tokens and authenticates the user binding, rejecting another encryption key', () => {
    auth.saveUser(user, tokens);
    expect(JSON.stringify(db.prepare('SELECT * FROM auth_users').all())).not.toContain(
      'secret-access',
    );
    expect(JSON.stringify(db.prepare('SELECT * FROM auth_users').all())).not.toContain(
      'secret-refresh',
    );
    expect(auth.getTokens(user.id)).toEqual(tokens);
    expect(() => new AuthStore(db, 'cd'.repeat(32)).getTokens(user.id)).toThrow('ログイン');
    auth.saveUser({ ...user, id: '22' }, tokens);
    db.exec(
      "UPDATE auth_users SET tokens=(SELECT tokens FROM auth_users WHERE id='11') WHERE id='22'",
    );
    expect(() => auth.getTokens('22')).toThrow('ログイン');
  });

  it('stores only session hashes, expires and revokes sessions', () => {
    auth.saveUser(user, tokens);
    const session = auth.createSession(user.id);
    expect(JSON.stringify(db.prepare('SELECT * FROM auth_sessions').all())).not.toContain(session);
    expect(auth.session(session)).toEqual(user);
    expect(auth.session('forged')).toBeNull();
    auth.deleteSession(session);
    expect(auth.session(session)).toBeNull();
    const expired = auth.createSession(user.id);
    db.exec('UPDATE auth_sessions SET expires_at=0');
    expect(auth.session(expired)).toBeNull();
  });

  it('binds one-use OAuth state to the browser and enforces its expiry', () => {
    const state = auth.createState();
    expect(auth.consumeState(state, undefined)).toBe(false);
    expect(auth.consumeState(state, 'wrong-browser')).toBe(false);
    expect(auth.consumeState(state, state)).toBe(true);
    expect(auth.consumeState(state, state)).toBe(false);
    const expired = auth.createState();
    db.exec('UPDATE auth_states SET expires_at=0');
    expect(auth.consumeState(expired, expired)).toBe(false);
  });

  it('fences concurrent refreshes and never overwrites a newly authorized grant', () => {
    auth.saveUser(user, tokens);
    expect(auth.claimRefresh(user.id, 'first')).toBe(true);
    expect(auth.claimRefresh(user.id, 'second')).toBe(false);
    expect(auth.finishRefresh(user.id, 'second', null)).toBe(false);
    auth.saveUser(user, { ...tokens, accessToken: 'new-login' });
    expect(auth.finishRefresh(user.id, 'first', null)).toBe(false);
    expect(auth.getTokens(user.id)?.accessToken).toBe('new-login');
  });
});
