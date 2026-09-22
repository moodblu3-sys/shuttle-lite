import { NextResponse } from 'next/server';
import { getCatalog, getConfig, getStore } from '../../../lib/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ profiles: getStore().listProfiles() });
}

export async function POST(request: Request) {
  const body = (await request.json()) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const sourceRootPath = typeof body.sourceRootPath === 'string' ? body.sourceRootPath.trim() : '';
  if (name.length === 0 || sourceRootPath.length === 0) {
    return NextResponse.json({ error: 'name と sourceRootPath は必須です' }, { status: 400 });
  }

  const config = getConfig();
  const store = getStore();
  if (store.getProfileByName(name)) {
    return NextResponse.json({ error: `同名のprofileが既にあります: ${name}` }, { status: 409 });
  }

  // Credentials and the proxy password are never stored on the profile row.
  const profile = store.createProfile({
    name,
    sourceRootPath,
    targetStagingFolderId: config.box.stagingFolderId ?? 'resolved-at-runtime',
    destinationCatalogId: getCatalog().id,
    proxyProfileName: config.proxy.mode === 'off' ? 'none' : config.proxy.mode,
    metadataTemplateKey: config.box.metadataTemplateKey,
    fileConcurrency: numberOr(body.fileConcurrency, config.limits.fileConcurrency),
    chunkConcurrency: numberOr(body.chunkConcurrency, config.limits.chunkConcurrency),
    aiRoutingEnabled: body.aiRoutingEnabled !== false,
    snowflakeLoggingEnabled: body.snowflakeLoggingEnabled !== false,
    // 既定は上書きしないRENAME。Box Shuttleと同じ答えを返す。
    conflictPolicy: body.conflictPolicy === 'SKIP' ? 'SKIP' : 'RENAME',
  });
  return NextResponse.json({ profile }, { status: 201 });
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 16 ? parsed : fallback;
}
