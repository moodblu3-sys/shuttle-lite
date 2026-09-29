import {
  assertBusinessTemplate,
  ShuttleError,
  templateId,
  type TemplateMapping,
} from '@shuttle-lite/core';
import { getBoxGateway } from './runtime';

/** Resolve the selected IDs with the current user's Box access; never accept client schemas. */
export async function readJobMetadata(
  input: unknown,
  migrationMode: string,
): Promise<TemplateMapping[]> {
  if (!Array.isArray(input) || input.length > 100 || (migrationMode === 'AS_IS' && input.length))
    throw new ShuttleError('CONFIG_INVALID', '使用するメタデータを選び直してください。');
  const ids = new Set<string>();
  const selected = input.map((entry: unknown) => {
    const value = entry as { scope?: unknown; templateKey?: unknown } | null;
    if (
      !value ||
      typeof value.scope !== 'string' ||
      !/^enterprise(?:_\d+)?$/.test(value.scope) ||
      typeof value.templateKey !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_-]*$/.test(value.templateKey)
    )
      throw new ShuttleError('CONFIG_INVALID', '使用するメタデータを選び直してください。');
    const id = templateId({ scope: value.scope, templateKey: value.templateKey });
    if (ids.has(id)) throw new ShuttleError('CONFIG_INVALID', '同じテンプレートが重複しています。');
    ids.add(id);
    return { scope: value.scope, templateKey: value.templateKey };
  });
  if (!selected.length) return [];
  const gateway = await getBoxGateway();
  const mappings: TemplateMapping[] = [];
  for (const entry of selected) {
    const template = await gateway.getMetadataTemplate(entry);
    assertBusinessTemplate(template);
    if (mappings.some((mapping) => templateId(mapping.template) === templateId(template)))
      throw new ShuttleError('CONFIG_INVALID', '同じテンプレートが重複しています。');
    mappings.push({ template });
  }
  return mappings;
}
