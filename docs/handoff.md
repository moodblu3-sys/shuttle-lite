# Handoff — ChatGPTで開発を続けるための1枚

ChatGPTを設計・実装・自動テストの主担当とし、GitHub経由で社用Macに受け渡す。
社用Macでは実Boxでの確認と発表リハーサルを行う。**このfileを最初に読ませる。**

設計レビューで合意した次の開発範囲と受け渡し方針は
[development-plan.md](development-plan.md) を参照する。新しい設計は未実装の項目を含む。

更新日 2026-09-22

## このプロダクトは何か

macOSのlocal folderからBoxへfileを移し、移行元のpathと検証結果をBox metadataとして
残す移行tool。Box AIが配置先を提案し、人が承認してから初めてBox内でmoveする。
Box Shuttleが届きにくい制約環境（明示proxy、file server）を埋めるPoC。

詳細は `README.md`、判断の理由は `docs/decisions.md`。

## いまの状態

- 元のMVPは129テスト・fake Box検証18項目で引き継ぎ済み。以降の変更はdevelopment-plan.md参照。
- 現在は「新しい移行」でMacの移行元とBoxの既存移行先を選ぶ。配置先はjobごとに保存する。
- 設定画面に共通の配置先候補は置かない。実Boxでサンプルの分類先を自動作成しない。
- schema 4へ更新する。過去の実Boxジョブで移行先未設定のものは開始・再開できない。
  Box上のファイルとローカル履歴は保持する。新しい移行で移行先を選ぶ。
- 実Boxへの移行は成功済み。Squid（明示proxy）経由も検証済み
- 検証環境はmacOS。**Windows実機検証は発表後**（D-016）
- 設定画面でAI分類・並列数・処理ログを保存できる（schema 5）。
- Snowflake SQL API sinkを実装。JSONLと切り替え可能。実Snowflake検証は未実施。設定はdocs/settings.md参照。
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
npm run verify           # fake Boxで18項目の独立検証
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

1. デモ通しのリハーサル（「新しい移行」で名前を入力・Macの移行元とBoxの移行先を選択 → 開始 → 承認 → report）
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
