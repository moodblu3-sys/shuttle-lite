# Handoff — ChatGPTで開発を続けるための1枚

Cursorのtoken残量が尽きた場合に、ChatGPT（web）を主な作業場にして、このMacを
「patchを当ててtestを通す場」にするための手順。**このfileを最初に読ませる。**

更新日 2026-09-22

## このプロダクトは何か

macOSのlocal folderからBoxへfileを移し、移行元のpathと検証結果をBox metadataとして
残す移行tool。Box AIが配置先を提案し、人が承認してから初めてBox内でmoveする。
Box Shuttleが届きにくい制約環境（明示proxy、file server）を埋めるPoC。

詳細は `README.md`、判断の理由は `docs/decisions.md`。

## いまの状態

- 実装はMVP完了。`npm test` 129件green、`npm run verify`（fake Box）18項目green
- 実Boxへの移行は成功済み。Squid（明示proxy）経由も検証済み
- 検証環境はmacOS。**Windows実機検証は発表後**（D-016）
- Snowflake sinkは未実装。telemetryはJSONLに出している
- Box AI routingは有効。15件のPDF fixtureで測定済み

## 触ってはいけないもの

- `.env` — 実Boxのcredentialが入っている。zipにもgitにも含めない
- `.shuttle-lite/` — jobのstate（SQLite）とlog。手で編集しない
- Box上の配置先folderの削除 — 実データを消す操作は人が判断する
- `D-006`（uploadしてからmove、file IDを保つ）と `D-017`（同名は上書きしない）は
  設計の前提。変えるなら先に `docs/decisions.md` を更新する

## 動かし方

```bash
npm install
npm test                 # 129件
npm run verify           # fake Boxで18項目の独立検証
npm run demo             # web(:3000) + worker を production buildで起動
npm run demo:reset       # local stateを消す（Box側は消えない）
```

`.env` は `.env.example` からコピーして作る。fake modeなら `BOX_MODE=fake` で
credential無しで全pipelineが動く。

## ChatGPTとの往復（これを守れば壊れない）

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

1. デモ通しのリハーサル（profile作成 → job開始 → 承認 → report）
2. 発表資料（5W1H。progressや検証詳細は入れない）
3. 発表後: Windows実機検証、Snowflake sink、TLS interception下の検証

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
