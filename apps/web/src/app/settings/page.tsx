import { getConfig } from '../../lib/runtime';

export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  const config = getConfig();
  return (
    <div className="page-content">
      <div className="page-head">
        <div>
          <h1 className="page-title">設定</h1>
        </div>
        <a className="linkbtn" href="/">
          移行一覧へ戻る
        </a>
      </div>

      <section className="card">
        <h2>Box接続</h2>
        <dl className="kv">
          <dt>接続先</dt>
          <dd>{config.box.mode === 'real' ? '実Box' : 'テスト環境'}</dd>
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
      </section>

      <details className="card quiet">
        <summary>
          <h2>詳細設定</h2>
        </summary>
        <div className="details-body">
          <dl className="kv">
            <dt>AI分類</dt>
            <dd>{config.ai.enabled ? '有効' : '無効'}</dd>
            <dt>ファイルの並列数</dt>
            <dd>{config.limits.fileConcurrency}</dd>
            <dt>分割転送の並列数</dt>
            <dd>{config.limits.chunkConcurrency}</dd>
            <dt>処理ログ</dt>
            <dd>
              {config.telemetry.sink === 'jsonl'
                ? 'ローカルファイル'
                : 'Snowflake（接続機能は未実装）'}
            </dd>
          </dl>
        </div>
      </details>
    </div>
  );
}
