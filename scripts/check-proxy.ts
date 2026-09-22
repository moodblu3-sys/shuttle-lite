/**
 * Proxy connectivity check (docs/requirements.md 4.3). Run before a migration:
 *
 *   npm run check:proxy
 *
 * It proves which route the traffic takes. In `required` mode a missing proxy
 * is a hard failure, never a direct connection.
 */
import { request } from 'undici';
import { mapTransportError } from '@shuttle-lite/box';
import {
  createDispatcher,
  loadConfig,
  proxyCheckTargets,
  redactProxyUrl,
} from '@shuttle-lite/config';
import { toShuttleError } from '@shuttle-lite/core';

const config = loadConfig();

process.stdout.write(
  [
    'Shuttle Lite proxy check',
    `  PROXY_MODE      ${config.proxy.mode}`,
    `  PROXY_URL       ${config.proxy.url ? redactProxyUrl(config.proxy.url) : '(unset)'}`,
    `  PROXY_AUTH_MODE ${config.proxy.authMode}`,
    `  CA bundle       ${config.proxy.caBundlePath ?? '(system default)'}`,
    `  NO_PROXY        ${config.proxy.noProxy.join(', ') || '(none)'}`,
    '',
  ].join('\n'),
);

let failures = 0;

for (const target of proxyCheckTargets(config.box)) {
  const label = `${target.label} (${target.method} ${target.url})`;
  try {
    const bundle = createDispatcher(config.proxy, target.url);
    const response = await request(target.url, {
      method: target.method,
      dispatcher: bundle.dispatcher,
      headersTimeout: 15_000,
    });
    await response.body.dump();
    const expected = target.expectStatuses.includes(response.statusCode);
    process.stdout.write(
      `${expected ? 'OK  ' : 'WARN'} ${label}\n       route=${bundle.describe} status=${response.statusCode}\n`,
    );
    if (!expected) failures += 1;
    await bundle.dispatcher.close();
  } catch (error) {
    // worker本体と同じ分類器を通す。ここだけUNKNOWNになると、proxyの
    // 認証失敗と到達不能の区別がつかず、対処が分からなくなる。
    const shuttleError = toShuttleError(
      mapTransportError(error, config.proxy.mode !== 'off', target.url),
    );
    failures += 1;
    process.stdout.write(
      `FAIL ${label}\n       ${shuttleError.category}: ${shuttleError.message}\n       対応: ${shuttleError.operatorAction}\n`,
    );
  }
}

if (config.telemetry.sink === 'snowflake' && config.telemetry.snowflake.account) {
  process.stdout.write(
    `\nSnowflake endpointの確認は driver 接続と合わせて実施してください (docs/integration-todo.md)\n`,
  );
}

process.stdout.write(
  `\n${failures === 0 ? 'すべて期待どおりです' : `${failures} 件の問題があります`}\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
