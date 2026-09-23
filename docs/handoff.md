# Handoff — ChatGPTで開発を続けるための1枚

ChatGPTを設計・実装・自動テストの主担当とし、GitHub経由で社用Macに受け渡す。
社用Macでは実Boxでの確認と発表リハーサルを行う。**このfileを最初に読ませる。**

設計レビューで合意した次の開発範囲と受け渡し方針は
[development-plan.md](development-plan.md) を参照する。新しい設計は未実装の項目を含む。

更新日 2026-09-23

## このプロダクトは何か

macOSのローカルフォルダーからBoxへファイルを移し、書類に合う業務メタデータを付けるツール。
Box AIが配置先とテンプレートを選択して項目を抽出し、人の承認後に付与・Box内moveを行う。
移行元の情報や検証結果はローカルDBとレポートに残し、新しい移行では共通の管理用メタデータを付けない。
Box Shuttleが届きにくい制約環境（明示proxy、file server）を埋めるPoC。

詳細は `README.md`、判断の理由は `docs/decisions.md`。

## いまの状態

- 現行の実装基準は`cff6760`（2026-09-23）。自動テスト410件、fake Box検証22項目、型チェック・lint・本番ビルド成功。現行schemaは10。
- 通常の画面フローは「アップロード → AI分類 → 確認・承認 → 配置」。配置はBox内moveで、再アップロードではない。
- 最新のテンプレート自動選択の精度・抽出結果・承認画面の実Box通し確認はMac側で行う。下記の過去の実Box成功記録とは区別する。

- メタデータ設定は使用するテンプレートの複数選択式。分類時に文書本文と候補テンプレートの名前・項目をBox AIへ渡し、テンプレートIDを選ばせて自動抽出する。候補外・曖昧・該当なしは未選択。既存の書類別移行の承認画面にも有効な候補を反映する。
- schema 10: メタデータの抽出状況を保存する。承認一覧にテンプレート名・抽出状況を表示し、項目は「項目を確認・編集」の中に折りたたむ。手動選択後もAI有効なら自動抽出する。抽出失敗は対応が必要なファイルとして表示し、詳細から再抽出・手入力できる。
- schema 9: AI分類の成功結果を保存し、メタデータ抽出だけの再試行では分類APIを再実行しない。ファイルID・バージョン・SHA-1・分類条件が変われば再分類する。
- 承認の下書きは同じブラウザーで復元する（有効期間7日）。ファイル・テンプレートの変更や操作完了後は古い下書きを使わない。選択チェックは復元しない。
- 承認一覧は100件ずつ表示し、検索は全件対象。進捗は件数上限なしで集計する。
- ワーカーの稼働を5秒ごとに記録し、処理待ちがある状態で15秒間応答がなければ進捗画面に表示する。
- 新しいメタデータ方式のテスト削除は、転送成功記録・ファイルID・SHA-1・サイズ・バージョン・所在を照合する。旧方式は従来のメタデータ照合を維持する。

- 転送・AI分類・配置の待ち合わせをなくし、空いた並列枠へ逐次投入する。ファイル・分割転送の上限は維持。
- 操作・設定変更時は実行中のステップを待って反映する。長時間処理中のジョブ実行権を定期更新する。
- schema 8: 新規ジョブは書類別のBoxメタデータテンプレートを使用する。設定画面の「メタデータ」で使用するテンプレートを選ぶ。
- AIによるテンプレート選択・抽出→一覧で確認・承認→Boxへ付与。抽出値の確認・修正は必要な場合だけ詳細を開く。新規ジョブには旧Shuttle Lite Migrationを付けない。
- 移行前の設定とCursorへのBox CLI依頼は [metadata-templates.md](metadata-templates.md)。旧共通メタデータ方式で作成済みのジョブだけは旧方式を維持する。

- 元のMVPは129テスト・fake Box検証18項目で引き継ぎ済み。以降の変更はdevelopment-plan.md参照。
- 現在は「新しい移行」でMacの移行元とBoxの既存移行先を選ぶ。配置先はjobごとに保存する。
- 設定画面に共通の配置先候補は置かない。実Boxでサンプルの分類先を自動作成しない。
- schema 4以降、過去の実Boxジョブで移行先未設定のものは開始・再開できない。
  Box上のファイルとローカル履歴は保持する。新しい移行で移行先を選ぶ。
- 旧メタデータ方式で実Boxへの移行とSquid（明示proxy）経由の通信を検証済み
- 検証環境はmacOS。**Windows実機検証は発表後**（D-016）
- 設定画面でAI分類・並列数・処理ログを保存できる（schema 5）。
- Snowflake SQL API sinkを実装。JSONLと切り替え可能。実Snowflake検証は未実施。設定はdocs/settings.md参照。
- 操作の回復と結果表示を追加（schema 6）。開始・承認などのローカル変更と操作完了は同時に保存する。
  中断した操作は実行権の期限（120秒）後に回復する。旧版で中断した操作は再実行せず、確認を求める。
- レポートのBox保存はCSV・JSONの両方が成功したときだけ成功と表示する。
  中断して保存結果が不明な操作は自動再送しない。Boxのレポートを確認して再操作する。
  レポート保存失敗で移行結果は変更しない。CSV・JSONの取得は引き続き利用できる。
- Box AI routingは有効。15件のPDF fixtureで測定済み

## 触ってはいけないもの

- `.env` — 実Boxのcredentialが入っている。zipにもgitにも含めない
- `.shuttle-lite/` — jobのstate（SQLite）とlog。手で編集しない
- Box上の配置先folderの削除 — 実データを消す操作は人が判断する
- `D-006`（uploadしてからmove、file IDを保つ）と `D-017`（同名は上書きしない）は
  設計の前提。変えるなら先に `docs/decisions.md` を更新する

## 動かし方

```bash
npm ci
npm run fixtures        # fresh cloneでは先に合成データを生成する
npm test                 # 現行の全テスト
npm run verify -- --faults # fake Boxで22項目の独立検証（障害ケースを含む）
npm run demo             # web(:3000) + worker を production buildで起動
npm run demo:reset       # local stateを消す（Box側は消えない）
```

`.env` は `.env.example` からコピーして作る。fake modeなら `BOX_MODE=fake` で
credential無しで全pipelineが動く。

## GitHubでの開発と受け渡し

1. ChatGPTが作業ブランチで実装し、対応するテストとfake Box検証を実行する。
2. 変更内容、検証結果、取得すべきブランチまたはコミットを共有する。
3. 社用Macでは公開リポジトリをcloneし、以後はfetchして確認対象のコミットを取得する。
4. `.env`は社用Macで用意し、認証情報や実Boxの設定をGitHubへ送らない。
5. 実Boxの確認結果を共有し、必要な修正を同じ手順で取り込む。

新しい変更のbaseは、着手時に確認したGitHub上のコミットとする。
開発先は [moodblu3-sys/shuttle-lite](https://github.com/moodblu3-sys/shuttle-lite)。
2026-09-22にPublicへの変更を確認済み。

### Boxデモ環境への接続

現行コードにはCCG認証と実Box用のGatewayが実装されている。
認証方式は [Box公式のCCG仕様](https://developer.box.com/guides/authentication/client-credentials/)
を参照する。接続処理の実装とfake Boxによる検証はChatGPT側で担当する。

実Boxへの接続は社用Macで行う。以前の検証に使った`.env`をローカルで保持し、
`BOX_MODE=real`と接続対象の設定を確認する。認証情報をチャットやGitHubに載せない。
このChatGPTの開発環境には実Boxの認証は設定されておらず、実Box疎通は未実行。

`npm run verify:box`は認証確認だけでなく、検証用のfolder、metadata template、
合成fileを作成・更新する。新しい移行コードの実Box確認では、専用のデモ領域を使う。

## パッチで受け渡す場合の補助手順

ChatGPTはこのMacのfileを直接編集できない。**diffをもらって、ここで当てる。**

1. zipを渡す（`npm run pack` で最新版を作る。tracked fileだけなので秘密は入らない）
2. 依頼のしかた:
   > このrepoを読んで。変更は `git apply` で当てられる unified diff で出して。
   > file全文の貼り直しはしない。1つの変更に1つのdiff。
3. 受け取ったdiffを `patch.diff` に保存して当てる:

```bash
git apply --check patch.diff   # 先に当たるか確認
git apply patch.diff
npm test && npm run lint
git commit -am "..."           # 通ったらcommit
git apply -R patch.diff        # 当てたものを戻したいとき
```

4. `git apply --check` が失敗したら、zipが古い。`npm run pack` で作り直して渡す

### ChatGPT側に守らせること

- 変更は小さく。1回のdiffは1つの関心事だけ
- `package.json` のdependency追加は理由を添える。勝手にlibraryを増やさない
- commentは「なぜ」を書く。「何をしているか」はcodeが語る
- 日本語のUI文言を勝手に英語化しない
- testを一緒に出す。`test/e2e.test.ts` と `packages/*/test/` が既存の書き方

## 残作業（発表まで）

1. 最新仕様の実Box通し確認（使用テンプレートを設定 → 新しい移行 → 自動選択・抽出 → 一括承認 → Boxの配置先と業務メタデータを確認）
2. 発表資料（5W1H。progressや検証詳細は入れない）
3. 発表後: Windows実機検証、Snowflake実機検証、TLS interception下の検証

## 構成の地図

```
apps/web        Next.js。移行jobのdashboard、承認画面
apps/worker     移行を進めるloop。scan→hash→upload→AI→承認待ち→move→検証
packages/core   state machine、error分類、file名の規則
packages/box    BoxGateway（http実装とfake実装）
packages/db     SQLite。state、event、outboxを1 transactionで書く
packages/routing AI抽出の正規化、承認の検証
packages/telemetry JSONL sink、report生成
docs/           判断の記録と受け入れ基準
```
