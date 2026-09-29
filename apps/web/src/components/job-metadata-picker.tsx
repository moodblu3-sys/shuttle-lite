'use client';

import { useEffect, useState } from 'react';
import type { BusinessTemplate } from '@shuttle-lite/core';

const templateId = (template: BusinessTemplate) => `${template.scope}/${template.templateKey}`;

export function JobMetadataPicker({
  active,
  selected,
  onChange,
  disabled,
}: {
  active: boolean;
  selected: readonly BusinessTemplate[];
  onChange: (templates: BusinessTemplate[]) => void;
  disabled: boolean;
}) {
  const [templates, setTemplates] = useState<BusinessTemplate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError('');
      try {
        const response = await fetch('/api/metadata-settings', {
          signal: controller.signal,
          cache: 'no-store',
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? 'テンプレートを取得できませんでした。');
        if (!controller.signal.aborted) setTemplates(data.templates);
      } catch (cause) {
        if (!controller.signal.aborted) setError((cause as Error).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [active, retry]);

  return (
    <section className="metadata-options" aria-label="使用するメタデータテンプレート">
      <div className="metadata-options-title">
        使用するメタデータテンプレート
        {selected.length > 0 ? (
          <span className="metadata-selection-count">{selected.length}件</span>
        ) : null}
      </div>
      <fieldset
        className="metadata-template-options"
        disabled={disabled || loading}
        aria-label="メタデータテンプレート"
      >
        {templates?.map((template) => (
          <label key={templateId(template)}>
            <input
              type="checkbox"
              checked={selected.some((entry) => templateId(entry) === templateId(template))}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, template]
                    : selected.filter((entry) => templateId(entry) !== templateId(template)),
                )
              }
            />
            <span>{template.displayName}</span>
          </label>
        ))}
      </fieldset>
      {loading ? <p role="status">読み込み中…</p> : null}
      {templates?.length === 0 ? <p>利用できるテンプレートがありません。</p> : null}
      {error ? (
        <div>
          <p className="error" role="alert">
            {error}
          </p>
          <button
            type="button"
            className="secondary"
            disabled={disabled || loading}
            onClick={() => setRetry((value) => value + 1)}
          >
            再読み込み
          </button>
        </div>
      ) : null}
    </section>
  );
}
