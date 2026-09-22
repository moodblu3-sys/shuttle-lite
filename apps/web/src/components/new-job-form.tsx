'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { MigrationProfile } from '@shuttle-lite/core';

export function NewJobForm({ profiles }: { profiles: readonly MigrationProfile[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (profiles.length === 0) {
    return <p className="muted small">先にprofileを作成してください。</p>;
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profileId: form.get('profileId'),
          operatorLabel: form.get('operatorLabel'),
          autoStart: form.get('autoStart') === 'on',
        }),
      });
      const body = (await response.json()) as { job?: { id: string }; error?: string };
      if (!response.ok || !body.job) throw new Error(body.error ?? `HTTP ${response.status}`);
      router.push(`/jobs/${body.job.id}`);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      {error ? <p className="error">{error}</p> : null}
      <div className="row">
        <label>
          Profile
          <select name="profileId" defaultValue={profiles[0]?.id}>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Operator label (local)
          <input name="operatorLabel" type="text" defaultValue="local operator" required />
        </label>
        <label className="small">
          <span>
            <input name="autoStart" type="checkbox" defaultChecked /> 作成後すぐ開始する
          </span>
        </label>
      </div>
      <div className="actions">
        <button type="submit" disabled={busy}>
          {busy ? '作成中…' : 'Migration jobを作成'}
        </button>
      </div>
    </form>
  );
}
