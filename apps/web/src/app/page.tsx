import { fromRepoRoot } from '@shuttle-lite/config';
import { buildJobSnapshot } from '@shuttle-lite/telemetry';
import { JobCard } from '../components/job-card';
import { NewJobForm } from '../components/new-job-form';
import { NewProfileForm } from '../components/new-profile-form';
import { getCatalog, getConfig, getStore } from '../lib/runtime';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  const store = getStore();
  const config = getConfig();
  const catalog = getCatalog();
  const profiles = store.listProfiles();
  const jobs = store.listJobs(20).map((job) => ({
    job,
    snapshot: buildJobSnapshot(store, job.id),
    profile: store.getProfile(job.profileId),
  }));

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">移行ジョブ</h1>
          <p className="page-desc">
            作成済みの移行ジョブの一覧です。進捗の確認、承認、reportの取得はここから行います。
          </p>
        </div>
        {/* Admin Consoleと同じく、新規作成は右上のprimary actionに置く。 */}
        <details className="newjob">
          <summary className="newjob-trigger">新しい移行</summary>
          <div className="newjob-panel">
            {profiles.length === 0 ? (
              <p className="muted small">
                まずmigration profileを作成してください。移行元のlocal folderを指定します。
              </p>
            ) : (
              <NewJobForm profiles={profiles} />
            )}
          </div>
        </details>
      </div>

      {jobs.length === 0 ? (
        <p className="empty">まだ移行ジョブはありません。右上の「新しい移行」から作成します。</p>
      ) : (
        <div className="jobcards">
          {jobs.map(({ job, snapshot, profile }) => (
            <JobCard key={job.id} job={job} snapshot={snapshot} profile={profile} />
          ))}
        </div>
      )}

      <details className="card" open={profiles.length === 0}>
        <summary>
          <h2>Migration profile ({profiles.length})</h2>
        </summary>
        <div className="details-body">
          {profiles.length > 0 ? (
            <table style={{ marginBottom: 16 }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Source root</th>
                  <th>並列</th>
                  <th>AI</th>
                  <th>Snowflake</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((profile) => (
                  <tr key={profile.id}>
                    <td>{profile.name}</td>
                    <td className="mono small">{profile.sourceRootPath}</td>
                    <td className="small">
                      file {profile.fileConcurrency} / chunk {profile.chunkConcurrency}
                    </td>
                    <td className="small">{profile.aiRoutingEnabled ? 'on' : 'off'}</td>
                    <td className="small">{profile.snowflakeLoggingEnabled ? 'on' : 'off'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <NewProfileForm
            defaultSourceRoot={fromRepoRoot('fixtures/source')}
            defaultFileConcurrency={config.limits.fileConcurrency}
            defaultChunkConcurrency={config.limits.chunkConcurrency}
          />
        </div>
      </details>

      <details className="card quiet">
        <summary>
          <h2>配置先catalog ({catalog.entries.length})</h2>
        </summary>
        <div className="details-body">
          <p className="small muted">
            AIはこのkeyのみを提案できます。任意のfolder IDを生成させません。
          </p>
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Box path</th>
                <th>説明</th>
              </tr>
            </thead>
            <tbody>
              {catalog.entries.map((entry) => (
                <tr key={entry.key}>
                  <td className="mono">{entry.key}</td>
                  <td className="small mono">{entry.boxPath}</td>
                  <td className="small muted">{entry.description ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <details className="card quiet">
        <summary>
          <h2>この環境の前提</h2>
        </summary>
        <div className="details-body">
          <dl className="kv">
            <dt>Box mode</dt>
            <dd>
              {config.box.mode === 'fake'
                ? 'fake — local diskのfake Box。credentialなしでpipelineを実行します。'
                : 'real — 設定されたBox enterpriseへ接続します。'}
            </dd>
            <dt>Proxy mode</dt>
            <dd>
              {config.proxy.mode === 'required'
                ? 'required — proxyが使えない場合はdirect接続へfallbackせず停止します。'
                : config.proxy.mode}
            </dd>
            <dt>Telemetry</dt>
            <dd>
              {config.telemetry.sink === 'jsonl'
                ? 'jsonl — local fileへ配信。Snowflake接続は未実施です。'
                : 'snowflake'}
            </dd>
            <dt>承認identity</dt>
            <dd>local operator labelはenterpriseで本人確認されたBox userではありません。</dd>
          </dl>
        </div>
      </details>
    </>
  );
}
