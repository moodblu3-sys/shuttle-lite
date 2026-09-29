import { redirect } from 'next/navigation';
import { currentUser, oauthEnabled } from '../../lib/auth';

export const dynamic = 'force-dynamic';
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  if (!oauthEnabled() || (!error && (await currentUser()))) redirect('/');
  return (
    <div className="page-content" style={{ maxWidth: 560, margin: '100px auto' }}>
      <h1 className="page-title">ログイン</h1>
      {error && (
        <p role="alert">
          ログインできませんでした。組織のBoxアカウントとアプリの認可設定を確認してください。
        </p>
      )}
      <a className="new-migration-link" href="/api/auth/login">
        Boxでログイン
      </a>
    </div>
  );
}
