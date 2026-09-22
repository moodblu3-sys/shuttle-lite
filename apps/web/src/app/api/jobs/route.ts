import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { NextResponse } from 'next/server';
import { getConfig, getStore } from '../../../lib/runtime';
import { destinationError, readJobDestinations } from '../../../lib/box-destinations';
import type { JobDestinations } from '@shuttle-lite/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ jobs: getStore().listJobs() });
}

/**
 * Creates the job row and appends a START_JOB command. The scan and every
 * transfer happen in the worker process, never in this request.
 */
export async function POST(request: Request) {
  const input: unknown = await request.json().catch(() => null);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return NextResponse.json({ error: '移行の設定を確認してください。' }, { status: 400 });
  }
  const body = input as Record<string, unknown>;
  const operatorLabel =
    typeof body.operatorLabel === 'string' && body.operatorLabel.trim().length > 0
      ? body.operatorLabel.trim()
      : 'ローカル操作者';
  if (body.autoStart !== undefined && typeof body.autoStart !== 'boolean') {
    return NextResponse.json({ error: '開始方法を確認してください。' }, { status: 400 });
  }

  // Existing scripts can still create jobs from a previously registered profile.
  if (body.profileId !== undefined) {
    if (
      typeof body.profileId !== 'string' ||
      !body.profileId ||
      body.name !== undefined ||
      body.sourceRootPath !== undefined
    ) {
      return NextResponse.json({ error: '移行元の指定を確認してください。' }, { status: 400 });
    }
    if (typeof body.operatorLabel !== 'string' || !body.operatorLabel.trim()) {
      return NextResponse.json({ error: '操作者名を入力してください。' }, { status: 400 });
    }
    const store = getStore();
    const profile = store.getProfile(body.profileId);
    if (!profile) {
      return NextResponse.json({ error: '登録済みの移行元が見つかりません。' }, { status: 404 });
    }
    let destinations: JobDestinations | null = null;
    if (body.destinationFolderId !== undefined || getConfig().box.mode === 'real') {
      try {
        destinations = await readJobDestinations(body.destinationFolderId);
      } catch (error) {
        return NextResponse.json(destinationError(error), { status: 400 });
      }
    }
    const job = store.transaction(() => {
      const created = store.createJob({ profileId: profile.id, operatorLabel });
      if (destinations) store.saveJobDestinations(created.id, destinations);
      if (body.autoStart !== false) store.enqueueCommand(created.id, 'START_JOB');
      return created;
    });
    return NextResponse.json({ job }, { status: 201 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const sourceRootPath = typeof body.sourceRootPath === 'string' ? body.sourceRootPath : '';
  if (!name || name.length > 100) {
    return NextResponse.json({ error: '移行名を1〜100文字で入力してください。' }, { status: 400 });
  }
  if (!isAbsolute(sourceRootPath) || sourceRootPath.includes('\0')) {
    return NextResponse.json({ error: '移行元フォルダーを選び直してください。' }, { status: 400 });
  }
  if (
    (body.aiRoutingEnabled !== undefined && typeof body.aiRoutingEnabled !== 'boolean') ||
    (body.conflictPolicy !== undefined &&
      body.conflictPolicy !== 'RENAME' &&
      body.conflictPolicy !== 'SKIP')
  ) {
    return NextResponse.json(
      { error: '詳細オプションの設定を確認してください。' },
      { status: 400 },
    );
  }
  try {
    if (!(await stat(sourceRootPath)).isDirectory()) {
      return NextResponse.json(
        { error: '移行元にはフォルダーを指定してください。' },
        { status: 400 },
      );
    }
    await access(sourceRootPath, constants.R_OK | constants.X_OK);
  } catch {
    return NextResponse.json(
      {
        error:
          '選択したフォルダーが見つからないか、読み取れません。アクセス権を確認するか、選び直してください。',
      },
      { status: 400 },
    );
  }

  let destinations: JobDestinations;
  try {
    destinations = await readJobDestinations(body.destinationFolderId);
  } catch (error) {
    return NextResponse.json(destinationError(error), { status: 400 });
  }
  const config = getConfig();
  const store = getStore();
  // Each job retains its own settings; an incomplete creation must leave no profile or job behind.
  const job = store.transaction(() => {
    const profile = store.createProfile({
      name: `migration-${randomUUID()}`,
      sourceRootPath,
      targetStagingFolderId: config.box.stagingFolderId ?? 'resolved-at-runtime',
      destinationCatalogId: 'job:' + destinations.rootFolderId,
      proxyProfileName: config.proxy.mode === 'off' ? 'none' : config.proxy.mode,
      metadataTemplateKey: config.box.metadataTemplateKey,
      fileConcurrency: config.limits.fileConcurrency,
      chunkConcurrency: config.limits.chunkConcurrency,
      aiRoutingEnabled: config.ai.enabled && body.aiRoutingEnabled !== false,
      snowflakeLoggingEnabled: true,
      conflictPolicy: body.conflictPolicy === 'SKIP' ? 'SKIP' : 'RENAME',
    });
    const created = store.createJob({ name, profileId: profile.id, operatorLabel });
    store.saveJobDestinations(created.id, destinations);
    if (body.autoStart !== false) store.enqueueCommand(created.id, 'START_JOB');
    return created;
  });
  return NextResponse.json({ job }, { status: 201 });
}
