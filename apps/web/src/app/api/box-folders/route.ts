import { guard, browsingConfig } from '../../../lib/auth';
import { NextResponse } from 'next/server';
import { browseDestinationFolder, excludedDestinationIds } from '@shuttle-lite/box';
import { getBoxGateway } from '../../../lib/runtime';
import { destinationError, readJobDestinations } from '../../../lib/box-destinations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  const denied = await guard(request, undefined, false);
  if (denied) return denied;
  try {
    const folderId = new URL(request.url).searchParams.get('folderId') ?? '0';
    return NextResponse.json(
      await browseDestinationFolder(
        await getBoxGateway(),
        folderId,
        excludedDestinationIds(await browsingConfig()),
      ),
      { headers },
    );
  } catch (error) {
    return NextResponse.json(destinationError(error), { status: 400, headers });
  }
}

/** Preview only. The create-job request independently resolves and saves the subtree. */
export async function POST(request: Request) {
  const denied = await guard(request, undefined, false);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as {
    folderId?: unknown;
    migrationMode?: unknown;
  } | null;
  try {
    const snapshot = await readJobDestinations(body?.folderId, body?.migrationMode);
    return NextResponse.json(
      {
        folderId: snapshot.rootFolderId,
        name: snapshot.rootFolderName,
        folderCount: snapshot.entries.length,
      },
      { headers },
    );
  } catch (error) {
    return NextResponse.json(destinationError(error), { status: 400, headers });
  }
}
