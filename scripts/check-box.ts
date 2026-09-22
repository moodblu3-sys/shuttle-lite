/** Read-only authentication check: does not bootstrap, upload, move or delete. */
import { createBoxGateway } from '@shuttle-lite/box';
import { loadConfig } from '@shuttle-lite/config';
import { ShuttleError, toShuttleError } from '@shuttle-lite/core';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.box.mode !== 'real') {
    throw new ShuttleError('CONFIG_INVALID', '接続確認には BOX_MODE=real を指定してください。');
  }
  const gateway = createBoxGateway(config);
  try {
    const identity = await gateway.whoAmI();
    process.stdout.write(
      [
        'Boxへの接続を確認しました（読み取りのみ）。',
        `認証方式: ${config.box.accessToken ? 'アクセストークン' : 'CCG'}`,
        `接続ユーザー: ${identity.name} (${identity.login})`,
        `ユーザーID: ${identity.userId}`,
        'ファイル操作・Box AI・メタデータの権限は、この確認には含みません。',
        '',
      ].join('\n'),
    );
  } finally {
    await gateway.close();
  }
}

main().catch((error: unknown) => {
  const failure = toShuttleError(error);
  process.stderr.write(
    `Box接続確認に失敗しました\n${failure.category}: ${failure.message}\n対応: ${failure.operatorAction}\n`,
  );
  process.exitCode = 1;
});
