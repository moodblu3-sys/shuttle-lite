# System連携 TODO

更新日: 2026-09-14

Applicationは`BOX_MODE=fake`でend-to-endに動作する。この文書は、実環境へ
接続するために残している作業だけを並べる。コードは実装済みで、実行だけが
未了である。

## 1. Box CCG application

- [ ] Box Developer Consoleで Custom App / Server Authentication (Client Credentials Grant) を作成
- [ ] Application Scopes: `Read all files and folders`, `Write all files and folders`
- [ ] Advanced Features: `Make API calls using the as-user header` は不要
- [ ] Metadata templateを作る場合のみ `Manage enterprise properties` を追加
- [ ] Admin Consoleでapplicationを承認 (Client IDで authorize)
- [ ] `.env` へ `BOX_CLIENT_ID` / `BOX_CLIENT_SECRET` / `BOX_ENTERPRISE_ID` を設定し、`BOX_MODE=real` にする

確認: `npm run check:proxy` の後、`npm run bootstrap:box` が `whoAmI` に成功すること。

## 2. Box folder layoutとmetadata template

```sh
npm run bootstrap:box
```

- [ ] `/Shuttle Lite` を作成し、そのfolder IDを `BOX_ROOT_FOLDER_ID` に設定
- [ ] `_staging` / `_needs_review` / `_reports` / `destinations/...` が作られることを確認
- [ ] 出力された folder ID を `.env` へ反映
- [ ] `shuttleLiteMigration` templateが作成されること（権限がなければ管理者へ依頼）
- [ ] Service Accountへ `/Shuttle Lite` だけをEditorで共有する。上位folderのcollaborationでstagingが想定外の利用者に見えないことをAdmin Consoleで確認

template作成をskipしたい場合は `npm run bootstrap:box -- --skip-template`。

## 3. Box AIの実応答を確認する (Q-004)

- [ ] Upload直後に `AI_NOT_READY` (202) が返る時間を計測する
- [ ] `ai/extract_structured` のresponseに `metadata.confidence` が含まれるか確認し、
      含まれない場合は review画面のconfidence表示を「取得できませんでした」のままにする
- [ ] Synthetic fixtureはtext/markdownなので、実Boxで検証する際はPDFやDOCXへ差し替える
      （`scripts/generate-fixtures.ts` の出力形式を変更する）
- [ ] CCG Service AccountでBox AIが利用できるか（Box AI の有効化状況）を確認

## 4. Metadata field型の確定 (Q-005)

- [ ] `sourceSize` を `float` で扱えるか、桁数の制限を確認
- [ ] `sourceModifiedAt` / `migratedAt` / `effectiveDate` の `date` 型がISO 8601を受けるか
- [ ] `routingReason` などstring fieldの文字数上限を確認し、`packages/routing/src/metadata.ts` の
      切り詰め長を合わせる

## 5. Snowflake (Q-007)

- [ ] Account、warehouse、database、schema、roleを用意
- [ ] Key pair認証用のprivate keyを配置し、`SNOWFLAKE_PRIVATE_KEY_PATH` を設定
- [ ] Event tableを作成する

```sql
CREATE TABLE IF NOT EXISTS shuttle_lite_events (
  event_id        STRING NOT NULL PRIMARY KEY,
  job_id          STRING NOT NULL,
  item_id         STRING,
  phase           STRING NOT NULL,
  status          STRING NOT NULL,
  size_bytes      NUMBER,
  duration_ms     NUMBER,
  retry_count     NUMBER,
  error_category  STRING,
  box_file_id     STRING,
  destination_key STRING,
  ai_used         BOOLEAN,
  human_override  BOOLEAN,
  occurred_at     TIMESTAMP_NTZ NOT NULL,
  loaded_at       TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);
```

- [ ] `event_id` で重複排除するMERGEを実装する（再送は同じevent IDで届く）
- [ ] `packages/telemetry/src/sink.ts` の `SnowflakeTelemetrySink.deliver` を実装する
- [ ] Node driverのproxy設定とcustom CAを確認する
- [ ] `TELEMETRY_SINK=snowflake` にして、Snowflake停止中もmigrationが継続することを確認

未接続の間、`TELEMETRY_SINK=jsonl` でoutboxは `.shuttle-lite/telemetry/events.jsonl`
へ配信される。送信するfieldは `packages/telemetry/src/payload.ts` のallowlistのみ。

## 6. Squid (明示的proxy) の検証

**実施済み**。Squid 7.7 (Basic認証、宛先allowlist) 経由で実Boxへ移行し、
18 / 18 件の検証項目が成功した。Dockerが無いため `brew install squid` で
直接起動している。結果と数値は [docs/acceptance.md](acceptance.md) の
「proxy経由での実測」にある。

```sh
npm run squid:start
npm run check:proxy
npm run verify -- --real
npm run squid:log
```

- [x] Basic認証ありでBox auth / API / upload / AIが通ること
- [x] Squid access logで全Box通信が説明できること（direct接続が発生していないこと）
  - 上り 51.3 MB がSquidを通っており、移行した51 MBと一致する
- [x] `PROXY_MODE=required` でproxyへ到達できないとき、direct接続へ抜けず
      `PROXY_CONNECT` で停止すること
- [x] allowlist外の宛先が `TCP_DENIED/403` になること
- [x] password誤りが `PROXY_AUTH` (407) に分類されること
- [ ] Custom CAを使う場合、`PROXY_CA_BUNDLE_PATH` を設定してTLS検証を無効化せずに通ること
  - 今回のSquidはTLS interceptしないため未確認。企業proxyでのTLS inspection時に要確認

詳細は [infra/squid/README.md](../infra/squid/README.md)。

## 7. Windows実機確認（発表後へ延期）

発表はmacOSで実演する（[D-016](decisions.md)）。Windows対応は実装済みで
`test/windows.test.ts` が通っているが、実機では未検証である。
checklistは [docs/windows.md](windows.md) にあり、PoCの次段階の最初に置く。

## 8. Box-to-Box (任意)

移行元・移行先の2 tenantとCCG applicationが用意できた場合のみ。
設計は [docs/box-to-box.md](box-to-box.md)、実装はSourceAdapterの追加のみで済む。
