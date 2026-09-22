import { describe, expect, it } from 'vitest';
import { mapTransportError } from '@shuttle-lite/box';

/**
 * Squidでの検証時、proxyが返した407が UNKNOWN に落ちて「proxyが拒否した」と
 * 読み取れなかった。undiciはCONNECTの失敗を RequestAbortedError で返し、
 * statusはmessageにしか入らないため、messageから復元する必要がある。
 */
function tunnelError(status: number): Error {
  const error = new Error(`Proxy response (${status}) !== 200 when HTTP Tunneling`);
  // undiciの RequestAbortedError と同じcode。これだけでは通常の中断と区別できない。
  (error as NodeJS.ErrnoException).code = 'UND_ERR_ABORTED';
  return error;
}

const URL = 'https://api.box.com/2.0/users/me';

describe('proxy経由の通信failureの分類', () => {
  it('CONNECTへの407をPROXY_AUTHにする', () => {
    const mapped = mapTransportError(tunnelError(407), true, URL);
    expect(mapped.category).toBe('PROXY_AUTH');
    expect(mapped.details).toMatchObject({ proxyStatus: 407 });
  });

  it('CONNECTへの403はallowlist拒否としてPROXY_CONNECTにする', () => {
    const mapped = mapTransportError(tunnelError(403), true, URL);
    expect(mapped.category).toBe('PROXY_CONNECT');
    expect(mapped.message).toMatch(/allowlist/);
  });

  it('その他のCONNECT失敗もPROXY_CONNECTにする', () => {
    expect(mapTransportError(tunnelError(502), true, URL).category).toBe('PROXY_CONNECT');
  });

  it('proxyへ到達できない場合をPROXY_CONNECTにする', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3128'), {
      code: 'ECONNREFUSED',
    });
    const mapped = mapTransportError(error, true, URL);
    expect(mapped.category).toBe('PROXY_CONNECT');
    // 宛先がBoxではなくproxyであることが分かる文面にする
    expect(mapped.message).toMatch(/proxy/);
  });

  it('proxyとのTLS失敗をBox自身のTLS失敗と区別せずPROXY_TLSにする', () => {
    const error = Object.assign(new Error('Secure proxy connection failed'), {
      code: 'UND_ERR_PRX_TLS',
    });
    expect(mapTransportError(error, true, URL).category).toBe('PROXY_TLS');
  });

  it('中断されただけのrequestは407の判定に巻き込まない', () => {
    const error = Object.assign(new Error('Request aborted'), { code: 'UND_ERR_ABORTED' });
    expect(mapTransportError(error, true, URL).category).toBe('BOX_TIMEOUT');
  });
});
