# 9/30 発表までの計画

更新日: 2026-09-15

[実装順序](implementation-plan.md) のPhase 0〜10は完了している。この文書は、
残り期間で**実環境に接続して主張を証明する**ための計画である。新機能の開発計画
ではない。

## 現在地

| 項目 | 状況 |
|---|---|
| Application | 実Boxでscanからfinal placementとreportまで通る。`BOX_MODE=fake` でも同じpipelineが動く |
| 自動テスト | 16 file / 124 件 pass、`typecheck` pass |
| 独立検証 | `npm run verify` がfixture 32件を移行して照合する（fake 22項目 / 実Box 18項目） |
| 受け入れ基準15項目 | 13項目が検証済み（自動11 + 実機2）。残りはSnowflakeの2項目 |
| 実Box接続 | 実施済み。fixture 32件 / 51 MB を移行し、18項目の検証が成功 |
| 明示的proxy | 実施済み。Squid経由でも同じ18項目が成功（[acceptance.md](acceptance.md)） |
| Snowflake | `SnowflakeTelemetrySink.deliver` が意図的なstub。**唯一のcode未実装** |
| Windows実機 | 発表後へ延期（[D-016](decisions.md)）。発表はmacOSで実演する |

つまり残っている作業は、ほぼすべて「繋いで確かめる」であり、「書く」ではない。
例外はSnowflake sinkだけである。

### `npm run verify` を実機検証の物差しにする

`scripts/verify-migration.ts` は現在 `BOX_MODE: 'fake'` 固定で、`FakeBoxGateway`
へ直接castしている。ここを実Boxでも動くようにすると、M1とM2の完了判定が
「Box上を目視で確認する」から「21項目のassertionが通る」に変わる。**残り期間で
最も費用対効果が高い投資**なので、M1の中で先に済ませる。

`BoxGateway` portに`downloadFile`は無い。追加すると`dl.boxcloud.com`という新しい
hostがproxy allowlistに必要になり、本来のmigration経路には無い依存を持ち込む。
そこで実機modeでは次の範囲に絞る。

- source fileのSHA-1はlocalで再計算する（pipelineの記録値を使わない）
- Box側は`getFile`を別sessionで引き直し、`sha1`、`size`、親folder、file名、必須
  metadataを照合する
- 重複file、staging残骸、reportからの特定可能性はAPIで確認できるのでそのまま使う

Box側のbyteそのものを引いて突き合わせないため、fake modeより検証は弱い。
その差は発表で明示する。

## 使える日数

締切は [要件 section 1](requirements.md) の 2026-09-30。9/19〜9/23はSilver Week
（9/19土、9/20日、9/21敬老の日、9/22国民の休日、9/23秋分の日）で5連休になる。

```text
9/14 月 ── 9/18 金   平日5日   ← ここが本番
9/19 土 ── 9/23 水   5連休     ← 予備日。外部依存は動かない
9/24 木 ── 9/25 金   平日2日
9/26 土 ── 9/27 日
9/28 月 ── 9/30 水   平日3日   ← 発表準備
```

実質10営業日。**外部の人に依頼が必要な作業は9/18までに完了させる**。連休中は
Admin対応もaccount発行も進まない。

## 着手前に潰れていたリスク

計画時点で確認した結果、[integration-todo](integration-todo.md) が想定していた
外部依存の多くは実際には存在しない。

- **Box CCG applicationのAdmin承認は自分でできる。** 利用するdemo tenant
  (`boxdemo.com`) のaccountはadmin roleである。Developer Consoleでのapp作成と
  Admin Consoleでのauthorizeが同一人物で完結するため、承認待ちのlead timeはない
- **Snowflakeのaccountは既に存在する。** `BOX_SNOWFLAKE_DEMO` と `BOX_INGEST`
  へ到達できる。Q-007はaccount調達ではなく、key pair認証の設定とtable作成、
  `deliver()` の実装に絞られる
- **Windows VMの土台はある。** VMware Fusionで構築する。ただしhostがarm64のため
  guestはWindows 11 ARMになる（後述の注意点あり）

残る真のブロッカーは次の2つだけである。

1. Dockerがない（M2の前提）
2. Box AIがdemo tenantで有効か、かつCCG Service Accountから呼べるか未確認（M1で最優先に潰す）

> 2026-09-15: 両方解消した。Dockerは入れず `brew install squid` で代替したため
> M2の前提ではなくなった。Box AIはCCG Service Accountから呼べており、
> `AI_NOT_READY` も発生しない。

## 9/15時点の見通し

M1〜M3が9/15に完了し、M4は発表後へ回した（[D-016](decisions.md)）。**「9/18を発表
可能な最小ライン」という当初の目標は9/15に達成している。**

そのため9/16〜9/23が空く。この余剰の使い方は次の順で考える。

1. **デモの通しリハーサル**を早めに1回やる。10分に収まるか、UIで詰まる箇所が
   あるかは実際に通すまで分からない。遅く見つけると直す時間が無い
2. **M5 Snowflake**。唯一のcode未実装。カット可能だが、余剰があるなら着手する
3. **M6 発表準備**。固定コストなので前倒しできるぶんだけ前倒しする

## 進め方の原則

**未知を2つ同時に繋がない。** proxyと実Boxを初見で同時に繋ぐと、失敗したときに
どちらが原因か切り分けられない。まずdirect接続で実Boxを通し（M1）、その上で
proxyを挟んで同じ経路を再実行する（M2）。差分が出たらproxyが原因と断定できる。

**9/18を「発表可能な最小ライン」に置く。** M1〜M3が終われば「明示的proxy制約下で
実Box enterpriseへ、provenance metadataとAI提案と人の承認を挟んで移行できる」が
実証済みになる。これが製品の主張そのものである。以降のM4〜M5が全部倒れても発表は
成立する構成にしておく。

## M1: 実Boxでend-to-endを通す（9/14〜9/15、完了）

最初に着手する。以降のすべてがこれに依存する。

- [x] Developer ConsoleでCustom App / CCGを作成し、Admin Consoleでauthorizeする
- [x] **Box AIをCCG Service Accountから呼べることを最小callで確認する**
- [x] `.env` を作成（`BOX_MODE=real`、`PROXY_MODE=off`）
- [x] `npm run bootstrap:box` でfolder layoutとmetadata templateを作成し、folder IDを `.env` へ反映
- [x] Service Accountへ `/Shuttle Lite` だけをEditorで共有し、staging可視範囲をAdmin Consoleで確認
- [x] まず1件だけ通す（`npm run verify:box`）。次にfixture 32件を通す
- [x] `npm run verify` を実機modeへ対応させる（`--real` で実Boxへ、run毎に隔離folderを作る）
- [x] `npm run verify` を実Boxに対して通す（18項目が成功）

Box AI確認を最優先に置くのは、ここがNGだと[D-007](decisions.md)のAI提案という
筋書き自体を組み替える必要があり、判明が遅いほど手当ての時間が減るためである。

Exit criteria: `BOX_MODE=real` / `PROXY_MODE=off` で `npm run verify` が通る。**達成**。
実機でしか出ない不具合5件を修正した（[README](../README.md) の「実測でわかったこと」）。

## M2: 明示的proxy経路を実証する（9/15、完了）

製品の存在理由であり、受け入れ基準1と2に対応する。**最も価値の高い検証**。

- [x] proxy runtimeを入れる。**Dockerは入れず `brew install squid` で直接動かした**
      （Docker Desktopは企業規模により有償subscriptionの対象になり、調達の寄り道が
      発生しうる。colimaも検討したが、Squid単体ならbrewで足りる）
- [x] Squidを起動し、`npm run check:proxy` を通す（`npm run squid:start`）
- [x] `PROXY_MODE=required` でM1と同じ32件を再実行し、`npm run verify -- --real` を通す
- [x] Squid access logで全Box通信が説明できること（direct接続が1件もないこと）を確認する
      — 上り51.3 MBがproxyを通っており、移行した51 MBと一致する
- [x] proxyへ到達できないとき、分類済みerrorで停止すること（direct fallbackしないこと）
- [ ] Custom CAを使う場合、`PROXY_CA_BUNDLE_PATH` でTLS検証を無効化せずに通ること
      — 今回のSquidはTLS interceptしないため未確認。顧客環境で必要になったら実施する

Exit criteria: 受け入れ基準1と2を実機で満たし、proxy経由で `npm run verify` が通る。
**達成**。結果は[acceptance.md](acceptance.md)の「proxy経由での実測」に記録した。
検証でproxy failureの分類漏れ2件を見つけて修正した。

## M3: Box AIとmetadataの実仕様を確定する（9/15、完了）

- [x] fixtureをPDFへ差し替える（`npm run fixtures:pdf`、headless Chromeで生成）
- [x] Q-004: upload直後に `AI_NOT_READY` が返る時間を計測する — **0回**。representation
      待ちは発生せず、extractが通るまで平均6.6秒
- [x] Q-004: responseに `metadata.confidence` が含まれるか確認し、review画面の表示を
      実態に合わせる — **返らない**（9件すべてnull）
- [x] Q-005: `sourceSize` のfloat桁数、`date` 型のISO 8601受理、string fieldの文字数上限
      — date fieldは `YYYY-MM-DD` を拒否し、RFC 3339のsecond精度を要求する
- [x] Q-005の結果を `packages/routing/src/metadata.ts` の切り詰め長へ反映する

fixture差し替えを先に置く理由は、当初のsynthetic dataがtext/markdownであり、
Box AIの実応答を見る前提を満たさないためである。

Exit criteria: [decisions.md](decisions.md) のQ-004とQ-005をConfirmed decisionsへ移す。
**達成**。実測結果はQ-004の「実測結果 (2026-09-15)」にある。

## M4: Windows実機検証（発表後へ延期）

2026-09-15に延期を決めた（[D-016](decisions.md)）。発表はmacOS上で実演する。

延期の理由は、証明すべき主張がOS非依存だからである。proxy制約下での移行可否、
provenance、AI提案と承認、telemetryはいずれもmacOSで証明できており、Windows VM
構築にSilver Weekを使っても新たに証明できる主張が無い。

発表では「Windows固有の失敗は分類済みerrorとして実装し、`test/windows.test.ts`
で検証している。実機検証は未実施」と述べる。実機で動くとは言わない。

以下はPoCの次段階の最初の作業として残す。

- [ ] VMware FusionでWindows 11 ARMを構築する
- [ ] **x64版のNode.jsを入れる。** Windows 11 ARMのx64 emulation上で動かせば
      `better-sqlite3` の `win32-x64` prebuiltが使える。ARM64版Node.jsだとprebuiltが
      無くVS Build Toolsからのsource buildになり、時間を取られる
- [ ] macOS側のFile Sharingで共有を作り、guestから `\\<host>\share` としてUNC scanする
      （実際のfile server構成に近い検証になる）
- [ ] `SQLITE_PATH` をlocal diskに置き、UNC指定時に起動を拒否することを確認する
- [ ] 260文字超のpathで `PATH_TOO_LONG` になることを確認する
- [ ] lock検証はExcelを入れずPowerShellの排他openで代替する
      （`[System.IO.File]::Open($p,'Open','ReadWrite','None')` で `SOURCE_LOCKED` を誘発）
- [ ] `npm ci` / `npm test` / `npm run typecheck` が通ること

Exit criteria（次段階）: [windows.md](windows.md) の「未検証であること」を実施結果へ
置き換える。

## M5: Snowflake接続（9/24〜9/25、2日でtimebox）

唯一のcode実装。既存のdemo accountを使う。

- [ ] Key pair認証用のprivate keyを配置し、`SNOWFLAKE_*` を設定する
- [ ] `shuttle_lite_events` tableを作成する（DDLは[integration-todo](integration-todo.md)）
- [ ] `event_id` で重複排除するMERGEを実装する
- [ ] `SnowflakeTelemetrySink.deliver` を実装する
- [ ] Node driverのproxy設定とcustom CAを確認する（Q-007）
- [ ] Snowflake停止中もmigrationが継続すること、復旧後に再送されることを確認する

**カット判断: 9/25 EOD で通らなければ `TELEMETRY_SINK=jsonl` のまま発表する。**
Transactional Outbox、allowlist、idempotent再送はいずれも自動テストで実証済みで
あり（受け入れ基準12と13）、「設計は検証済み、実sinkへの接続は未了」と明示すれば
主張は成立する。ここで時間を溶かしてM6を削るのが最悪の選択である。

Exit criteria: 実Snowflakeで受け入れ基準12と13を満たす。またはカット判断を実行する。

## M6: 発表準備（9/26、9/28〜9/30）

固定コストであり、削れない。M5のカット判断はこの時間を守るために置いている。

- [ ] `docs/demo.md` に10分のdemo台本を書く
- [ ] 検証エビデンスを1箇所へ集約する（Squid access log、Box上のfile、Snowflakeクエリ結果。
      Windows結果は[D-016](decisions.md)で発表後へ回した）
- [ ] **「実装済み / 実機検証済み / 将来構想」の3分類を1枚にする。** [要件 section 1](requirements.md) が
      重視すると宣言している区別であり、ここを曖昧にすると全体の信頼度が落ちる
- [ ] `npm run demo:reset` からの通しリハーサルを行い、10分に収まることを確認する
- [ ] 余裕があればGitHub Actionsで111件のtestをCIに載せる

live demoに乗せるもの: proxy connectivity、multi-file転送の進捗、AI提案と人の修正、
Box上の最終結果。crash recovery、chunked resume、429、Snowflake outageは事前検証の
結果を見せる（liveで起こすと時間が読めない）。

Exit criteria: 通しで10分に収まる。

## 明示的に切るもの

- **AI Agent Orchestrator**（[要件 section 10](requirements.md) の追加目標）を切る。
  着手条件は「基本版と発表練習の完了」だが、10営業日で5領域の実機検証と発表準備を
  抱える状況で条件は満たされない。[decisions.md](decisions.md) のdeferredに残す
- **Box-to-Box** は[D-015](decisions.md)のまま設計のみ。`SourceAdapter` のseamがある
  ことを示すだけにする
- **Snowflake** は条件付き（M5のカット判断）

## 進捗の記録方法

看板を増やさない。既存の2ファイルを正本とする。

- 実機検証の実施状況は [integration-todo.md](integration-todo.md) のcheckboxを日次で更新する
- 受け入れ基準の状況は [acceptance.md](acceptance.md) の「実機（未実施）」を結果へ置き換える
- 実機で判明した事実は [decisions.md](decisions.md) のQ-00xをConfirmed decisionsへ移す

## 安全面の申し送り

- demo tenantのsynthetic dataのみを使う。顧客の実データは一切持ち込まない
- credentialは `.env` にのみ置き、commitしない。log、event payload、profileへ残さない
- Service Accountへ共有するのは `/Shuttle Lite` だけに限定する
