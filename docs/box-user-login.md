# Boxログインで利用する

一般ユーザーが操作するときは `BOX_AUTH_MODE=oauth` を使用する。
共通のSAではなく、ログインしたBoxユーザーの権限で転送・AI・メタデータ・配置を実行する。
追加の外部npm依存はない。OAuth通信も既存のHTTPクライアントを使い、プロキシ設定を維持する。

## Box側の準備

1. 開発者コンソールで **User Authentication (OAuth 2.0)** のPlatformアプリを新規作成する。
   既存のCCGアプリは残す。認証方式の変更には新しいアプリが必要。
2. Redirect URIに `http://localhost:3000/api/auth/callback` を登録する。
3. ファイル・フォルダーの読み取り／書き込みと、Box AIを使用するスコープを設定する。
   組織でアプリ利用を制限している場合は、管理者が利用を承認する。
   このアプリのためのユーザー管理権限・as-user権限は不要。
4. ログインするユーザーが、配置先に対して必要な作成・移動・メタデータ更新権限を持つことを確認する。
   Box AIの利用も組織・アプリ・ユーザーの設定に従う。

## Macの設定

Cursorは `.env` の値をチャット・ログ・コミットへ出さない。新アプリのID・シークレットは管理者がローカルで設定する。

```dotenv
BOX_MODE=real
BOX_AUTH_MODE=oauth
SHUTTLE_APP_URL=http://localhost:3000
BOX_CLIENT_ID=<新しいOAuthアプリのClient ID>
BOX_CLIENT_SECRET=<新しいOAuthアプリのClient Secret>
BOX_ENTERPRISE_ID=<ログインを許可する組織のEnterprise ID>
BOX_ACCESS_TOKEN=
SHUTTLE_ADMIN_USER_IDS=<管理者として扱うBoxユーザーID。複数ならカンマ区切り>
SHUTTLE_AUTH_KEY=<ランダムな32バイトを64桁の16進数で指定>
```

暗号鍵はMacで生成し、`.env`へ保存する。作り直すと保存済みトークンを読めなくなるため、再ログインが必要。

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex') + '\n')"
```

プロキシ・Snowflakeの既存設定は維持する。webとworkerを両方再起動し、
**http://localhost:3000** を開く。管理者がログインしてログ出力先などの共通設定を行い、
各ユーザーは本人のBoxアカウントでログインして「新しい移行」を作成する。
使用するメタデータは新しい移行の画面で選択し、管理者以外も自分の移行用に選べる。

OAuth方式では、以前のSA用 `BOX_ROOT_FOLDER_ID` / `BOX_STAGING_FOLDER_ID` などは使用しない。
本人のBoxルート配下の `Shuttle Lite` に作業領域を用意する。ジョブごとに一時フォルダーを分け、
ローカルのレイアウトキャッシュもユーザーIDごとに分離する。配置後のID維持・競合方針は変わらない。

## 操作と権限

- セッションは12時間。HttpOnly Cookieを使用し、トークンをブラウザーへ渡さない。
- 他の組織のユーザーはログインできない。管理者は設定したBoxユーザーIDだけ。
- 一覧・詳細・承認・プレビュー・レポート・差分・操作APIは本人のジョブだけを扱う。
  管理者も他人のBox権限で承認・再実行できない。全体監視はSnowflake側で行う。
- 設定変更とSnowflakeの接続テストは管理者に限定する。
- 操作者名／承認者名の手入力はOAuth方式では表示せず、認証済み情報を使う。
- ログアウトは画面のセッションを終了する。すでに依頼済みのバックグラウンド処理は継続する。
  転送を止める場合はログアウト前に一時停止する。
- アクセストークンは自動更新。更新用トークンの同時使用をweb/worker間で排他する。
  更新が失敗した場合は共通SAへ切り替えず停止する。「Boxに再ログイン」後に再開／失敗分の再試行を行う。
- SAで作成した旧ジョブは自動で本人へ割り当てない。OAuth方式では新規ジョブを作成する。
  旧Boxファイル・DB履歴は削除しない。OAuthジョブをCCGへ切り替えて実行することも拒否する。

## 監査ログ

OAuthジョブでは、既存のイベントID・時刻・成否・BoxファイルIDに次の項目を追加する。

| 項目 | 内容 |
| --- | --- |
| requestedByUserId | ジョブを作成した認証済みBoxユーザーID |
| actorUserId | 開始・承認・キャンセル等の操作を依頼したユーザーID。自動処理ではnull |
| executorUserId | 処理に使用するBoxユーザーID。操作受付だけのイベントではnull |
| action | START_JOB、APPROVE_ITEMなどの操作種別 |
| fileName | ファイル単位のイベントに元ファイル名を記録 |
| destinationFolderId | 確定した配置先のBoxフォルダーID |

操作受付と結果を別イベントで残す。ログと状態変更は既存outboxを通して保存・配信する。
Snowflakeの既存PAYLOAD（VARIANT）に入るため、テーブルの列追加は不要。
Box実接続の既定はSnowflakeへの自動送信。接続未設定・送信失敗時はSQLiteのoutboxに保持して再送し、ローカルJSONLへ自動で切り替えない。既存の保存済み設定や明示したローカル出力は維持する。トークン・本文・絶対パスは送信しない。

```sql
SELECT
  PAYLOAD:occurredAt::TIMESTAMP_TZ AS occurred_at,
  PAYLOAD:requestedByUserId::STRING AS requested_by,
  PAYLOAD:actorUserId::STRING AS actor,
  PAYLOAD:executorUserId::STRING AS executor,
  PAYLOAD:action::STRING AS action,
  PAYLOAD:fileName::STRING AS file_name,
  PAYLOAD:boxFileId::STRING AS box_file_id,
  PAYLOAD:destinationFolderId::STRING AS destination_folder_id,
  PAYLOAD:status::STRING AS status
FROM SHUTTLE_LITE_EVENTS
ORDER BY occurred_at DESC;
```

## 確認すること

1. 未ログインで一覧・ジョブURL・APIを開いても履歴を取得できない。
2. ユーザーAで合成ファイルを移行し、承認・配置まで確認する。
3. ユーザーBでログインし、AのジョブURL・操作・レポートを取得できない。
4. 非管理者に共通設定の編集が表示されず、直接APIを呼んでも拒否される。
5. ログに認証済みユーザーIDとファイル名が入り、秘密情報が入らない。
6. プロキシ必須環境では認証・更新・転送がプロキシ経由で動作する。

自動テストは合成ユーザーとHTTPモック／fake Boxで行う。実BoxのOAuthログイン・AI権限・
実Snowflakeへの送信はMac側で検証する。

これは引き続きローカルアプリ。認証追加だけで共有サーバーへの配備や全社員への安全な配布を保証しない。
移行元へのアクセスはアプリを起動したOSユーザーの権限に従い、ファイルサーバーの個人認証を代理しない。
Client Secret・暗号鍵・DBは管理対象として保護する。監査ログの保持期間・書き換え防止・閲覧権限は導入時に設計する。

## 公式仕様

- [OAuthの設定](https://developer.box.com/guides/authentication/oauth2/oauth2-setup/)
- [現在のユーザーの取得](https://developer.box.com/reference/get-users-me/)
- [Box APIの権限](https://developer.box.com/guides/security/)
