import type { AppConfig } from '@shuttle-lite/config';
import type { Logger } from '@shuttle-lite/core';
import { FakeBoxGateway } from './fake/gateway';
import type { BoxGateway } from './gateway';
import { HttpBoxGateway } from './http/gateway';

/**
 * `BOX_MODE` picks the implementation. Fake mode is what makes the whole
 * pipeline runnable, testable and demonstrable before the Box enterprise
 * objects and credentials exist.
 */
export function createBoxGateway(config: AppConfig, logger?: Logger): BoxGateway {
  if (config.box.mode === 'fake') {
    return new FakeBoxGateway({
      rootDir: config.fakeBox.rootDir,
      maxFileBytes: config.limits.maxFileBytes,
      aiPendingFirstCall: config.fakeBox.aiPendingFirstCall,
      rateLimitEvery: config.fakeBox.rateLimitEvery,
      latencyMs: config.fakeBox.latencyMs,
    });
  }
  return new HttpBoxGateway({
    box: config.box,
    proxy: config.proxy,
    ...(logger ? { logger } : {}),
  });
}

/** The Box side root for a fake run is implicit; a real run needs the env value. */
/**
 * 明示指定がなければ、Service Accountのroot folderを起点にする。
 * その下へ `/Shuttle Lite` を作る（docs/architecture.md section 12）。
 */
export function rootFolderId(config: AppConfig): string {
  return config.box.rootFolderId ?? '0';
}
