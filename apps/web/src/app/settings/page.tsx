import { requirePageUser, isAdmin } from '../../lib/auth';
import { platform } from 'node:os';
import { assertSnowflakeConfigured, settingsFromConfig } from '@shuttle-lite/config';
import { SettingsForm } from '../../components/settings-form';
import { getConfig, getStore } from '../../lib/runtime';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const user = await requirePageUser();
  const config = getConfig();
  const snow = config.telemetry.snowflake;
  const usesSnowflake = config.telemetry.sink === 'snowflake';
  let snowflakeConfigured = false;
  try {
    assertSnowflakeConfigured(config);
    snowflakeConfigured = true;
  } catch {
    // Configuration presence is not proof of a successful delivery.
  }
  return (
    <div className="page-content">
      <div className="page-head">
        <h1 className="page-title">設定</h1>
        <a className="linkbtn" href="/">
          移行一覧へ戻る
        </a>
      </div>
      <section className="card">
        <h2>認証情報</h2>
        <dl className="kv">
          <dt>Box</dt>
          <dd>
            {config.box.mode === 'fake'
              ? 'テスト用（認証不要）'
              : user
                ? `Boxログイン（${user.name}）`
                : config.box.accessToken
                  ? 'アクセストークン'
                  : 'アプリ認証（CCG）'}
          </dd>
        </dl>
      </section>
      <section className="card" aria-label="処理ログの設定状態">
        <h2>処理ログ</h2>
        <dl className="kv">
          <dt>送信先</dt>
          <dd>{usesSnowflake ? 'Snowflake' : 'ローカルフォルダー'}</dd>
          {usesSnowflake && (
            <>
              <dt>格納先</dt>
              <dd>
                {snow.database && snow.schema
                  ? `${snow.database}.${snow.schema}.${snow.table ?? 'SHUTTLE_LITE_EVENTS'}`
                  : '未設定'}
              </dd>
              <dt>接続設定</dt>
              <dd>
                {snowflakeConfigured
                  ? '設定済み（接続確認は管理者が実施）'
                  : '未設定・管理者の設定が必要'}
              </dd>
              <dt>送信方法</dt>
              <dd>自動送信</dd>
            </>
          )}
        </dl>
      </section>
      {isAdmin(user) && (
        <>
          <section className="card">
            <h2>管理者設定</h2>
            <SettingsForm
              initial={settingsFromConfig(config)}
              revision={getStore().getRuntimeSettings().revision}
              folderPickerAvailable={platform() === 'darwin'}
              snowflakeKeyConfigured={Boolean(config.telemetry.snowflake.privateKeyPath)}
            />
          </section>
        </>
      )}
    </div>
  );
}
