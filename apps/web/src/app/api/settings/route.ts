import { constants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import {
  applyRuntimeSettings,
  assertSnowflakeConfigured,
  parseRuntimeSettings,
  settingsFromConfig,
} from '@shuttle-lite/config';
import { ShuttleError } from '@shuttle-lite/core';
import { getConfig, getStore } from '../../../lib/runtime';
import { isLocalMutation } from '../../../lib/local-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    {
      settings: settingsFromConfig(getConfig()),
      revision: getStore().getRuntimeSettings().revision,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function PUT(request: Request) {
  if (!isLocalMutation(request))
    return NextResponse.json(
      { error: 'localhostの設定画面から保存してください。' },
      { status: 403 },
    );
  const body: unknown = await request.json().catch(() => null);
  if (
    !body ||
    typeof body !== 'object' ||
    !('settings' in body) ||
    !('revision' in body) ||
    !Number.isInteger(body.revision)
  ) {
    return NextResponse.json({ error: '設定値を確認してください。' }, { status: 400 });
  }
  try {
    const settings = parseRuntimeSettings(body.settings);
    const config = applyRuntimeSettings(getConfig(), settings);
    if (settings.logSink === 'snowflake') {
      assertSnowflakeConfigured(config);
      await access(config.telemetry.snowflake.privateKeyPath!, constants.R_OK).catch(() => {
        throw new ShuttleError(
          'CONFIG_INVALID',
          'Snowflakeの秘密鍵を読み取れません。Mac側の設定を確認してください。',
        );
      });
    } else {
      try {
        if (settings.logFolder === settingsFromConfig(getConfig()).logFolder)
          await mkdir(settings.logFolder, { recursive: true });
        if (!(await stat(settings.logFolder)).isDirectory()) throw new Error('Not a directory');
        await access(settings.logFolder, constants.W_OK | constants.X_OK);
        const output = join(settings.logFolder, 'events.jsonl');
        const file = await stat(output).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (file) {
          if (!file.isFile()) throw new Error('Not a file');
          await access(output, constants.R_OK | constants.W_OK);
        }
      } catch {
        throw new ShuttleError('CONFIG_INVALID', 'ログを書き込めるフォルダーを選択してください。');
      }
    }
    const store = getStore();
    if (!store.saveRuntimeSettings(settings, body.revision as number)) {
      return NextResponse.json(
        { error: '別の画面で設定が変更されました。再読み込みして確認してください。' },
        { status: 409 },
      );
    }
    return NextResponse.json({ settings, revision: (body.revision as number) + 1 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof ShuttleError ? error.message : '設定を保存できませんでした。' },
      { status: error instanceof ShuttleError ? 400 : 500 },
    );
  }
}
