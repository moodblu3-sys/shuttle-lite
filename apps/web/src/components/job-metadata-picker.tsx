'use client';

import { useEffect, useRef, useState } from 'react';
import type { BusinessTemplate } from '@shuttle-lite/core';

const templateId = (template: BusinessTemplate) => `${template.scope}/${template.templateKey}`;

export function JobMetadataPicker({
  selected,
  onChange,
  disabled,
}: {
  selected: readonly BusinessTemplate[];
  onChange: (templates: BusinessTemplate[]) => void;
  disabled: boolean;
}) {
  const [templates, setTemplates] = useState<BusinessTemplate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const requested = useRef(false);
  useEffect(() => () => pending.current?.abort(), []);

  async function load() {
    if (pending.current || disabled) return;
    requested.current = true;
    const controller = new AbortController();
    pending.current = controller;
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
      pending.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return (
    <details
      className="migration-options metadata-options"
      onToggle={(event) => {
        if (event.currentTarget.open && !requested.current) void load();
      }}
    >
      <summary>
        使用するメタデータ
        {selected.length > 0 ? (
          <span className="metadata-selection-count">{selected.length}件</span>
        ) : null}
      </summary>
      <div className="migration-options-body">
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
              onClick={() => void load()}
            >
              再読み込み
            </button>
          </div>
        ) : null}
      </div>
    </details>
  );
}
