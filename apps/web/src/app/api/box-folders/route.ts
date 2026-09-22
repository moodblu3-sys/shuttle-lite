import { NextResponse } from 'next/server';
import { browseDestinationFolder, excludedDestinationIds } from '@shuttle-lite/box';
import { getBoxGateway, getConfig } from '../../../lib/runtime';
import { destinationError, readJobDestinations } from '../../../lib/box-destinations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  try {
    const folderId = new URL(request.url).searchParams.get('folderId') ?? '0';
    return NextResponse.json(
      await browseDestinationFolder(getBoxGateway(), folderId, excludedDestinationIds(getConfig())),
      { headers },
    );
  } catch (error) {
    return NextResponse.json(destinationError(error), { status: 400, headers });
  }
}

/** Preview only. The create-job request independently resolves and saves the subtree. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { folderId?: unknown } | null;
  try {
    const snapshot = await readJobDestinations(body?.folderId);
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
