import { NextResponse } from 'next/server';
import {
  assertBusinessTemplate,
  ShuttleError,
  templateId,
  type TemplateMapping,
} from '@shuttle-lite/core';
import { getBoxGateway, getStore } from '../../../lib/runtime';
import { isLocalMutation } from '../../../lib/local-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const templates = (await getBoxGateway().listMetadataTemplates()).filter((template) => {
      try {
        assertBusinessTemplate(template);
        return true;
      } catch {
        return false;
      }
    });
    return NextResponse.json(
      { ...getStore().getMetadataSettings(), templates },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json(
      { error: 'Boxのテンプレートを取得できません。認証・権限を確認してください。' },
      { status: 502 },
    );
  }
}

export async function PUT(request: Request) {
  if (!isLocalMutation(request))
    return NextResponse.json({ error: 'localhostから保存してください。' }, { status: 403 });
  const body = (await request.json().catch(() => null)) as {
    revision?: number;
    templates?: Array<{ scope?: string; templateKey?: string }>;
    mappings?: Array<{ documentType?: string; scope?: string; templateKey?: string }>;
  } | null;
  // Accept old clients during rolling updates; new clients send only template IDs.
  const selected = body?.templates ?? body?.mappings;
  if (
    !body ||
    !Number.isInteger(body.revision) ||
    body.revision! < 0 ||
    !Array.isArray(selected) ||
    selected.length > 100
  )
    return NextResponse.json({ error: 'テンプレートの設定を確認してください。' }, { status: 400 });
  try {
    const mappings: TemplateMapping[] = [];
    for (const entry of selected) {
      if (
        !entry ||
        !/^enterprise(?:_\d+)?$/.test(entry.scope ?? '') ||
        !/^[A-Za-z][A-Za-z0-9_-]*$/.test(entry.templateKey ?? '')
      )
        throw new ShuttleError('CONFIG_INVALID', 'テンプレートの設定を確認してください。');
      const template = await getBoxGateway().getMetadataTemplate({
        scope: entry.scope!,
        templateKey: entry.templateKey!,
      });
      assertBusinessTemplate(template);
      if (mappings.some((m) => templateId(m.template) === templateId(template)))
        throw new ShuttleError('CONFIG_INVALID', '同じテンプレートが重複しています。');
      mappings.push({
        template,
      });
    }
    if (!getStore().saveMetadataSettings(mappings, body.revision!))
      return NextResponse.json(
        { error: '設定が更新されています。再読み込みしてください。' },
        { status: 409 },
      );
    return NextResponse.json({ mappings, revision: body.revision! + 1 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof ShuttleError ? error.message : 'テンプレートを保存できませんでした。',
      },
      { status: 400 },
    );
  }
}
