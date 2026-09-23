'use client';

import { useEffect, useState } from 'react';
import type { BusinessTemplate, TemplateMapping } from '@shuttle-lite/core';

export function MetadataSettings() {
  const [templates, setTemplates] = useState<BusinessTemplate[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
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
        setTemplates(data.templates);
        setSelected(
          Object.fromEntries(
            (data.mappings as TemplateMapping[]).map((m) => [m.documentType, id(m.template)]),
          ),
        );
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
      const mappings = Object.entries(selected)
        .filter(([, value]) => value)
        .map(([documentType, value]) => {
          const template = templates.find((t) => id(t) === value);
          if (!template) throw new Error('テンプレートを選び直してください。');
          return { documentType, scope: template.scope, templateKey: template.templateKey };
        });
      const response = await fetch('/api/metadata-settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-shuttle-settings': '1' },
        body: JSON.stringify({ revision, mappings }),
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
      <fieldset disabled={!loaded || loading || busy}>
        {(['契約書', '請求書'] as const).map((kind) => (
          <label className="settings-row" key={kind}>
            <span>{kind}</span>
            <select
              value={selected[kind] ?? ''}
              onChange={(event) => {
                setSelected({ ...selected, [kind]: event.target.value });
                setStatus('');
              }}
            >
              <option value="">未選択</option>
              {selected[kind] && !templates.some((t) => id(t) === selected[kind]) ? (
                <option value={selected[kind]}>取得できないテンプレート</option>
              ) : null}
              {templates.map((t) => (
                <option key={id(t)} value={id(t)}>
                  {t.displayName}
                </option>
              ))}
            </select>
          </label>
        ))}
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
