import { fromRepoRoot } from '@shuttle-lite/config';
import { NewProfileForm } from '../../components/new-profile-form';
import { getCatalog, getConfig, getStore } from '../../lib/runtime';

export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  const profiles = getStore().listProfiles();
  const config = getConfig();
  const catalog = getCatalog();
  return (
    <div className="page-content">
      <div className="page-head">
        <div>
          <h1 className="page-title">設定</h1>
          <p className="page-desc">移行元と配置先、実行環境を確認します。</p>
        </div>
        <a className="linkbtn" href="/">
          移行一覧へ戻る
        </a>
      </div>
      <details className="card" open id="profiles">
        <summary>
          <h2>移行元の設定 ({profiles.length})</h2>
        </summary>
        <div className="details-body">
          {profiles.length > 0 ? (
            <table style={{ marginBottom: 16 }}>
              <thead>
                <tr>
                  <th>名前</th>
                  <th>移行元フォルダー</th>
                  <th>並列</th>
                  <th>AI</th>
                  <th>ログ記録</th>
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

      <details className="card">
        <summary>
          <h2>配置先の一覧 ({catalog.entries.length})</h2>
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
            <dt>Boxモード</dt>
            <dd>
              {config.box.mode === 'fake'
                ? 'fake — local diskのfake Box。credentialなしでpipelineを実行します。'
                : 'real — 設定されたBox enterpriseへ接続します。'}
            </dd>
            <dt>プロキシ</dt>
            <dd>
              {config.proxy.mode === 'required'
                ? 'required — proxyが使えない場合はdirect接続へfallbackせず停止します。'
                : config.proxy.mode}
            </dd>
            <dt>ログの出力先</dt>
            <dd>
              {config.telemetry.sink === 'jsonl'
                ? 'jsonl — local fileへ配信。Snowflake接続は未実施です。'
                : 'snowflake'}
            </dd>
            <dt>AI分類</dt>
            <dd>{config.ai.enabled ? '有効' : '無効'}</dd>
            <dt>承認者の記録</dt>
            <dd>local operator labelはenterpriseで本人確認されたBox userではありません。</dd>
          </dl>
        </div>
      </details>
    </div>
  );
}
