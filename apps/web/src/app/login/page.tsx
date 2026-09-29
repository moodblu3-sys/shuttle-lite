import { BoxLabel } from '../../components/box-label';
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
      <div className="login-mark">
        <ShuttleBrand showName={false} />
      </div>
      <h1 id="login-title">Shuttle Liteにログイン</h1>
      {error && (
        <p className="login-error" role="alert">
          ログインできませんでした。組織のBoxアカウントとアプリの認可設定を確認してください。
        </p>
      )}
      <a className="login-button" href="/api/auth/login">
        <BoxLabel inverse>Boxでログイン</BoxLabel>
      </a>
    </section>
  );
}
