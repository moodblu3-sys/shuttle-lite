'use client';

import { useEffect, useState } from 'react';
import type { BusinessTemplate, TemplateMapping } from '@shuttle-lite/core';

export function MetadataSettings() {
  const [templates, setTemplates] = useState<BusinessTemplate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const id = (t: BusinessTemplate) => `${t.scope}/${t.templateKey}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/metadata-settings', { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        setLoaded(true);
        const saved = data.mappings as TemplateMapping[];
        const available = data.templates as BusinessTemplate[];
        setTemplates([
          ...available,
          ...saved
            .map((m) => m.template)
            .filter((t) => !available.some((entry) => id(entry) === id(t))),
        ]);
        setSelected(saved.map((m) => id(m.template)));
        setRevision(data.revision);
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  async function save() {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const enabled = selected.map((value) => {
        const template = templates.find((t) => id(t) === value);
        if (!template) throw new Error('テンプレートを選び直してください。');
        return { scope: template.scope, templateKey: template.templateKey };
      });
      const response = await fetch('/api/metadata-settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-shuttle-settings': '1' },
        body: JSON.stringify({ revision, templates: enabled }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setRevision(data.revision);
      setStatus('保存しました');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h2>メタデータ</h2>
      <fieldset disabled={!loaded || loading || busy} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend>使用するテンプレート</legend>
        {templates.map((template) => (
          <label
            key={id(template)}
            style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '14px 0' }}
          >
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={selected.includes(id(template))}
              onChange={(event) => {
                setSelected(
                  event.target.checked
                    ? [...selected, id(template)]
                    : selected.filter((value) => value !== id(template)),
                );
                setStatus('');
              }}
            />
            <span>{template.displayName}</span>
          </label>
        ))}
        {loaded && templates.length === 0 ? <p>利用できるテンプレートがありません。</p> : null}
        <button type="button" onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
        </button>
      </fieldset>
      {loading ? <p role="status">読み込み中…</p> : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {status ? <p role="status">{status}</p> : null}
    </section>
  );
}
