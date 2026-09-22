import { collectJobDestinations, excludedDestinationIds, validFolderId } from '@shuttle-lite/box';
import { ShuttleError } from '@shuttle-lite/core';
import { getBoxGateway, getConfig } from './runtime';

export async function readJobDestinations(folderId: unknown) {
  if (!validFolderId(folderId))
    throw new ShuttleError('CONFIG_INVALID', 'Boxの移行先フォルダーを選択してください。');
  const config = getConfig();
  return collectJobDestinations(
    getBoxGateway(),
    folderId,
    config.box.mode,
    excludedDestinationIds(config),
  );
}

export function destinationError(error: unknown): { error: string } {
  if (error instanceof ShuttleError) {
    if (error.category === 'CONFIG_INVALID' || error.category === 'BOX_NOT_FOUND')
      return { error: error.message };
    if (error.category === 'BOX_AUTH')
      return { error: 'Boxに接続できません。認証設定を確認してください。' };
  }
  return {
    error: 'Boxフォルダーを取得できません。接続・アクセス権を確認して、もう一度お試しください。',
  };
}
