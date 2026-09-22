import { getConfig } from '../../lib/runtime';

export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  const config = getConfig();
  return (
    <div className="page-content">
      <div className="page-head">
        <div>
          <h1 className="page-title">設定</h1>
          <p className="page-desc">すべての移行で使う、Box接続の設定を確認します。</p>
        </div>
        <a className="linkbtn" href="/">
          移行一覧へ戻る
        </a>
      </div>
      <p className="small muted">
        移行名・移行元・Boxの移行先は、移行一覧の「新しい移行」で指定します。
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
          </p>
        </div>
      </details>
    </div>
  );
}
