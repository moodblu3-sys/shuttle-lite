import { requirePageUser, isAdmin } from '../../lib/auth';
import { platform } from 'node:os';
import { settingsFromConfig } from '@shuttle-lite/config';
import { SettingsForm } from '../../components/settings-form';
import { getConfig, getStore } from '../../lib/runtime';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const user = await requirePageUser();
  const config = getConfig();
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
      {isAdmin(user) && (
        <>
          <section className="card">
            <h2>詳細設定</h2>
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
