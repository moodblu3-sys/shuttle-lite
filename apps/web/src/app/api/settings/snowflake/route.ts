import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { SnowflakeTelemetrySink } from '@shuttle-lite/telemetry';
import { getConfig, getStore } from '../../../../lib/runtime';
import { isLocalMutation } from '../../../../lib/local-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let checking = false;

export async function POST(request: Request) {
  if (!isLocalMutation(request))
    return NextResponse.json(
      { error: 'localhostの設定画面から確認してください。' },
      { status: 403 },
    );
  const body = await request.json().catch(() => null);
  const revision = getStore().getRuntimeSettings().revision;
  if (!body || typeof body !== 'object' || !('revision' in body) || body.revision !== revision)
    return NextResponse.json(
      { error: '最新の設定を保存してから確認してください。' },
      { status: 409 },
    );
  const config = getConfig();
  if (config.telemetry.sink !== 'snowflake')
    return NextResponse.json(
      { error: '処理ログをSnowflakeに設定して保存してください。' },
      { status: 400 },
    );
  if (checking) return NextResponse.json({ error: '接続確認中です。' }, { status: 409 });
  checking = true;
  const sink = new SnowflakeTelemetrySink(config);
  try {
    const eventId = `connection-test-${randomUUID()}`;
    const checkedAt = new Date().toISOString();
    await sink.deliver([
      {
        eventId,
        jobId: 'connection-test',
        payload: {
          eventId,
          jobId: 'connection-test',
          phase: 'CONNECTION_TEST',
          status: 'SUCCEEDED',
          occurredAt: checkedAt,
        },
      },
    ]);
    return NextResponse.json({ eventId, checkedAt });
  } catch {
    // Never return transport errors, SQL bindings, keys or response bodies to the browser.
    return NextResponse.json(
      {
        error:
          'テストログを送信できませんでした。接続設定・秘密鍵・テーブルのSELECTとINSERT権限・通信経路を確認してください。',
      },
      { status: 502 },
    );
  } finally {
    try {
      await sink.close();
    } catch {
      /* Delivery result remains authoritative. */
    }
    checking = false;
  }
}
