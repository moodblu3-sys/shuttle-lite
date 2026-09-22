import { getCatalog, getConfig } from '../../lib/runtime';

export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  const config = getConfig();
  const catalog = getCatalog();
  return (
    <div className="page-content">
      <div className="page-head">
        <div>
          <h1 className="page-title">設定</h1>
          <p className="page-desc">すべての移行で使う、Box接続と配置先の設定を確認します。</p>
        </div>
        <a className="linkbtn" href="/">
          移行一覧へ戻る
        </a>
      </div>
      <p className="small muted">
        移行名と移行元フォルダーは、移行一覧の「新しい移行」で指定します。
      </p>

      <section className="card">
        <h2>Box接続</h2>
        <dl className="kv">
          <dt>接続先</dt>
          <dd>{config.box.mode === 'real' ? '実Box' : 'テスト環境（このMac内）'}</dd>
          {config.box.mode === 'real' ? (
            <>
              <dt>認証方式</dt>
              <dd>{config.box.accessToken ? 'アクセストークン' : 'アプリ認証（CCG）'}</dd>
            </>
          ) : null}
          <dt>通信経路</dt>
          <dd>
            {config.proxy.mode === 'off'
              ? '直接接続'
              : config.proxy.mode === 'required'
                ? 'プロキシ経由のみ'
                : config.proxy.url
                  ? 'プロキシ経由'
                  : '直接接続（プロキシ未設定）'}
          </dd>
        </dl>
        <p className="small muted">接続設定の表示です。接続テストの結果ではありません。</p>
      </section>

      <section className="card">
        <h2>配置先の候補</h2>
        <p className="small muted">
          AIはこの候補から配置先を提案します。ファイルは確認・承認してから配置されます。
        </p>
        <table>
          <thead>
            <tr>
              <th>分類先</th>
              <th>Boxフォルダー</th>
              <th>対象の文書</th>
            </tr>
          </thead>
          <tbody>
            {catalog.entries.map((entry) => (
              <tr key={entry.key}>
                <td>{entry.label}</td>
                <td className="small">{entry.boxPath}</td>
                <td className="small muted">{entry.description ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted">現在は登録済み候補の確認のみ対応しています。</p>
      </section>

      <details className="card quiet">
        <summary>
          <h2>詳細設定</h2>
        </summary>
        <div className="details-body">
          <dl className="kv">
            <dt>AI分類</dt>
            <dd>{config.ai.enabled ? '有効（移行ごとにオフにできます）' : '無効'}</dd>
            <dt>ファイルの並列数</dt>
            <dd>{config.limits.fileConcurrency}</dd>
            <dt>分割転送の並列数</dt>
            <dd>{config.limits.chunkConcurrency}</dd>
            <dt>処理ログ</dt>
            <dd>
              {config.telemetry.sink === 'jsonl'
                ? 'このMac内のファイルに記録'
                : 'Snowflake（接続機能は未実装）'}
            </dd>
          </dl>
          <p className="small muted">
            共通設定の変更は、このMacの.envで行い、アプリを再起動してください。
            配置先の候補はconfig/destinations.jsonで管理しています。
          </p>
        </div>
      </details>
    </div>
  );
}
