# 設定画面と処理ログ

## 設定の保存

「設定」の「詳細設定」で変更し、「保存」を押す。

- AI分類: オン／オフ。移行ごとにオフにした設定は優先する。すでに出た提案は消さず、未処理分から反映する。
- ファイルの並列数: 1〜5。
- 分割転送の並列数: 1〜4。全ファイルで共通の上限であり、ファイル数との掛け算ではない。
- 処理ログ: ローカルフォルダー／Snowflake。

並列数はBox APIの仕様上の最大値ではなく、このアプリの運用上限。
画面・API・環境変数で検証する。実行中の転送は中断せず、ワーカーの次の処理単位から反映する。
画面の保存後にアプリを再起動する必要はない。秘密鍵など環境変数を変えた場合は再起動する。

保存値はSQLite schema 5のruntime_settingsに保存され、再起動後も維持される。
未保存時は.envの初期値を利用する。画面で保存後は保存値を優先する。
同時に複数の画面から保存した場合は、古い画面からの上書きを拒否する。
認証情報は方式だけを表示し、秘密鍵・トークンは画面やSQLiteに保存しない。

## ローカルフォルダー

「フォルダーを選択」でMacのフォルダー選択画面を開く。
選択先のevents.jsonlへ処理イベントを追記する。読み書き可能な専用フォルダーを選ぶ。
移行元ファイル・SQLite・ワーカーの標準出力ログの保存場所は変わらない。
フォルダーを選ぶだけでは保存されない。キャンセルでは現在の選択を保持する。

出力先の変更は次のログ送信バッチから適用する。未送信のログも新しい出力先へ送る。
送信中のバッチは変更前の出力先へ送信する。送信済みのログは移動・再送・削除しない。
ディスク障害やSnowflakeの停止時はSQLiteのoutboxに残して再試行し、移行は継続する。
クラッシュ中の送信は2分のリース失効後に再取得し、長時間の送信中はリースを更新する。

## Snowflakeの準備

SQL APIとRSAキーペア認証を利用する。追加のnpm依存はない。
Snowflakeのアカウント、ユーザー、ウェアハウス、データベース、スキーマを準備し、
ユーザーに公開鍵を登録する。秘密鍵はこのリポジトリ外でMacに保持する。

Macの.envで指定する値:

```dotenv
SNOWFLAKE_PRIVATE_KEY_PATH=/absolute/path/to/rsa_key.p8
SNOWFLAKE_PRIVATE_KEY_PASSPHRASE=
```

パスフレーズは暗号化済み秘密鍵を利用するときに指定する。チャットやGitHubへ送らない。
アプリを再起動後、「処理ログ」でSnowflakeを選び、次を入力する。

| 項目 | 入力 |
| --- | --- |
| アカウント | org-account形式（ホストの.snowflakecomputing.comは除く）。従来のlocator.region.cloud形式にも対応 |
| ユーザー | 公開鍵を登録したユーザー名 |
| ウェアハウス | 利用可能なウェアハウス名 |
| データベース／スキーマ | ログ用テーブルがある場所 |
| テーブル | SHUTTLE_LITE_EVENTS、または下記の列を持つ専用テーブル |
| ロール | 必要なら実行ロール |

識別子は引用符なしの名前に対応する。データベース・スキーマ・ウェアハウス・ロールは
SnowflakeのSHOW結果と同じ大文字・小文字で指定する。JWTのユーザー名は大文字にする。
.global接続や特殊な引用符付き識別子は対象外。

Snowflake側で次のテーブルを用意する（アプリは自動作成・削除しない）。
ユーザーの実行ロールにウェアハウス・データベース・スキーマのUSAGEと、対象テーブルの
SELECT・INSERT権限を付与する。

```sql
CREATE TABLE IF NOT EXISTS SHUTTLE_LITE_EVENTS (
  EVENT_ID VARCHAR NOT NULL,
  JOB_ID VARCHAR NOT NULL,
  PAYLOAD VARIANT NOT NULL,
  LOADED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP()
);
```

以前のintegration-todo.mdにあった列ごとのテーブル案とは異なる。
既存テーブルを上書きせず、必要なら別名の専用テーブルを作って画面から指定する。
イベントはPAYLOADの中に格納する。

```sql
SELECT EVENT_ID, JOB_ID,
       PAYLOAD:phase::VARCHAR AS PHASE,
       PAYLOAD:status::VARCHAR AS STATUS,
       PAYLOAD:occurredAt::TIMESTAMP_TZ AS OCCURRED_AT
FROM SHUTTLE_LITE_EVENTS
ORDER BY LOADED_AT DESC;
```

送信対象は既存allowlistの処理イベントのみ。ファイル本文・ファイル名・ローカルパス・
AI回答原文・認証情報は送らない。EVENT_IDによるMERGEと再送時に安定したrequestIdを利用する。
SnowflakeのHTTP 202は実行完了まで確認し、未完了・通信失敗時は送信済みにしない。
Box用と同じプロキシ設定・CA設定を利用し、必須プロキシを迂回しない。

保存時は必須項目と秘密鍵ファイルの読み取り可否を検証する。
画面の「設定済み」は鍵のパスが設定されている意味で、接続成功を示すものではない。
接続先と権限の実機確認はMac側で実施する。自動テストは合成RSA鍵・模擬HTTP応答であり、
実Snowflakeにログが保存されたことは未確認。

公式仕様（実装時に確認）:

- [SQL API認証](https://docs.snowflake.com/en/developer-guide/sql-api/authenticating)
- [リクエスト・バインド変数・再送](https://docs.snowflake.com/en/developer-guide/sql-api/submitting-requests)
- [非同期応答の扱い](https://docs.snowflake.com/en/developer-guide/sql-api/handling-responses)
