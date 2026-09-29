import { redirect } from 'next/navigation';
import { currentUser, oauthEnabled } from '../../lib/auth';
import { ShuttleBrand } from '../../components/shuttle-brand';

export const dynamic = 'force-dynamic';
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  if (!oauthEnabled() || (!error && (await currentUser()))) redirect('/');
  return (
    <section className="login-panel" aria-labelledby="login-title">
      <div className="workspace-brand login-brand">
        <ShuttleBrand />
      </div>
      <h1 id="login-title">ログイン</h1>
      {error && (
        <p className="login-error" role="alert">
          ログインできませんでした。組織のBoxアカウントとアプリの認可設定を確認してください。
        </p>
      )}
      <a className="new-migration-link login-button" href="/api/auth/login">
        Boxでログイン
      </a>
    </section>
  );
}
