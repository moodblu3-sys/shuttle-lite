# Shuttle Lite 要件

更新日: 2026-09-13

## 1. 背景

Box JapanのSolution Architect向け卒業制作として、Box Platformを利用した
動作するPoCを2026年9月30日までに一人で構築する。

重視すること:

- 実在する顧客課題を扱う
- Box Platformをプロダクトの中心に置く
- Network、transfer、metadata、AI、approval、telemetryを一連の設計として説明する
- 架空データを使い、再現可能なdemoを作る
- 実装済み、検証済み、将来構想を明確に分ける

## 2. プロダクト定義

Shuttle Liteは、Box Shuttleの内部を変更する製品ではない。Box Shuttleが標準対応
しにくい制約環境向けに、Box Platform APIで限定的なmigration pathを実装するPoC
である。

> local fileをBoxへ移行し、同一job内でprovenance metadata、Box AIによる
> 配置先提案、人による承認、最終配置、検証、進捗表示、Snowflake loggingまで行う。
> 外部接続は直接でも、企業が許可した非透過型（明示的）proxy経由でも動作する。

proxyは前提条件ではなく、対応する接続形態の一つである。既定は直接接続
（`PROXY_MODE=off`）で、proxyが必要な環境では設定で切り替える。proxyを必須と
する環境向けに、直接接続へfallbackしない`required` modeを用意する。

## 3. 想定利用者

- Box Administrator
- Migration担当Solution Architect
- Box ConsultingまたはSIer
- 非透過型proxy経由でしか外部接続できない企業のIT部門
- 部門・拠点単位の限定migrationを担当する利用者

## 4. 基本版に含める機能

### 4.1 Migration profile

以下の設定を保存できる。

- Profile name
- Source root path
- Target staging folder ID
- Destination catalog
- Proxy profile
- Metadata template key
- File concurrency
- Chunk concurrency
- AI routingの有効・無効
- Snowflake loggingの有効・無効

Credentialとproxy passwordはprofileへ平文保存しない。

### 4.2 Source scan

macOS上のlocal folderを再帰的にscanし、fileごとに以下を記録する。

- Stable migration item ID
- Relative source path
- File name
- Size
- Content modified time
- File type
- SHA-1
- Scan time

絶対pathをBox metadataやSnowflakeへ無条件に送らず、原則としてsource rootからの
relative pathを利用する。

### 4.3 Proxy connectivity

接続形態は3つから選ぶ。

| `PROXY_MODE` | 挙動 | 想定 |
|---|---|---|
| `off`（既定） | 直接接続する | proxyのない環境 |
| `preferred` | proxyが設定されていれば経由し、無ければ直接接続する | どちらでも動かしたい環境 |
| `required` | proxy経由のみ。使えなければ直接接続へfallbackせず停止する | proxy経由が義務付けられた環境 |

非透過型（明示的）HTTP/HTTPS proxyを設定した場合、migration開始前に以下を確認する。

- Proxy hostへの到達
- Proxy認証
- TLS certificate validation
- `account.box.com`へのCCG token request
- `api.box.com`へのAPI request
- `upload.box.com`へのupload
- Snowflake endpointへの接続

MVPのproxy認証は認証なしまたはBasicとする。NTLM、Kerberos、PACは対象外。
TLS検証を無効化してcustom CA問題を回避しない。

### 4.4 Preflight

upload前に以下を確認する。

- Source fileが読み取り可能
- Source fileがscan時から変わっていない
- Target staging folderが存在する
- Service Accountがwrite可能
- File名がBoxで利用可能
- File sizeがBox account上限以内
- 同名itemの有無
- Box upload preflight結果

### 4.5 Upload

- 50MB以下はDirect Upload
- 50MB超はChunked Upload
- file全体をmemoryへ読み込まない
- source streamからBoxへ送る
- upload中のbyte進捗を記録する
- Direct Upload失敗時はfile全体を再送する
- Chunked Upload失敗時は該当partから復旧する
- 429では`Retry-After`を守る
- 一時errorには上限付きbackoffを行う
- 恒久的4xxを無限にretryしない

### 4.6 Pause、resume、reconciliation

- 新規処理の開始を止めるpause
- application再起動後のresume
- 完了済みitemのskip
- unknown outcomeとなったAPI requestのBox側照会
- source file変更の再確認
- Chunked Upload session、expiry、uploaded parts、commit結果の保存

Box upload成功後、SQLite保存前にprocessが停止してもduplicateを作らないこと。
即時反映を保証しないSearch APIだけに依存して復旧しない。

### 4.7 Transfer verification

stagingへのupload後、以下を確認する。

- Box file ID
- Box上のsize
- Box上のSHA-1
- source sizeおよびsource SHA-1との一致
- source fileが転送中に変更されていない

検証前のitemを転送完了として扱わない。

### 4.8 Provenance metadata

共通のmigration metadata templateへ以下を保存する。

- `migrationJobId`
- `migrationItemId`
- `sourceRelativePath`
- `sourceFileName`
- `sourceModifiedAt`
- `sourceSize`
- `sourceSha1`
- `migratedAt`
- `migrationStatus`

Extract結果の受領とMetadata APIへの書き込みは別工程とする。metadataだけ失敗した
場合はuploadを再実行しない。

### 4.9 Box AI extraction and routing suggestion

Box AI Structured Extractで、MVPでは以下のgeneric fieldsを取得する。

- `documentType`
- `businessDomain`
- `businessIdentifier`
- `effectiveDate`
- `suggestedDestinationKey`
- `suggestedTags`
- `reason`

利用できる場合だけconfidence scoreとreferenceを保存し、取得できない値を生成しない。
抽出field confidenceとdestination提案の正解確率を同一視しない。

### 4.10 Destination catalog

AIへ任意のfolder IDを生成させない。事前に許可したkeyとBox folder IDを
application側で対応付ける。

例:

```text
LEGAL_CONTRACTS  → /Shuttle Lite/destinations/Legal/Contracts
FINANCE_INVOICES → /Shuttle Lite/destinations/Finance/Invoices
HR_RECORDS       → /Shuttle Lite/destinations/HR/Employee Records
IT_RUNBOOKS      → /Shuttle Lite/destinations/IT/Runbooks
SALES_PROPOSALS  → /Shuttle Lite/destinations/Sales/Proposals
NEEDS_REVIEW     → /Shuttle Lite/_needs_review
```

### 4.11 Human approval

画面に以下を表示する。

- Source file
- Box file IDまたはPreview/link
- Extracted values
- Suggested destination
- Reason
- Confidenceとreference（取得できた場合）
- Proposed metadata

利用者はapprove、destination変更、metadata修正、skip、needs reviewを選べる。
MVPではhigh confidenceでも自動moveしない。

承認recordは少なくとも以下へ結び付ける。

- Box file ID
- File version IDまたはSHA-1
- 採用metadata
- Final destination folder ID
- Approval time
- Local operator label

MVPのlocal UIにはenterprise identity保証がないため、local operatorを検証済みBox
userとして表示しない。

### 4.12 Final placement and verification

承認後にBox内Move APIでstagingからfinal folderへ移動する。再uploadせずBox file
IDを維持する。

move直前に承認対象のfile ID、version/SHA-1、metadata、destinationが変わって
いないことを確認する。変更されていた場合は再承認を求める。

move後に以下を確認する。

- Final parent folder ID
- Size
- SHA-1
- 必須provenance metadata
- 採用したbusiness metadata
- Approval record

### 4.13 Progress UI

次のphaseを分けて表示する。

- Scan
- Preflight
- Upload
- Transfer verification
- Metadata
- AI extraction
- Review
- Move
- Final verification
- Snowflake delivery

表示項目:

- Total/processed file count
- Total/processed bytes
- Current file
- Transfer throughput
- Upload ETA
- Retry count
- Error category
- Review backlog
- Snowflake outbox backlog

uploadとAI処理は別queueとし、AI待ちが別fileのtransferを止めない。

### 4.14 Snowflake logging

SQLiteをoperational stateの正本とする。状態更新とoutbox event追加を同じSQLite
transactionで確定する。

Snowflakeへ送る候補:

- Job ID
- Item ID
- Event ID
- Phase
- Status
- Size
- Duration
- Retry count
- Error category
- Box file ID
- Destination key
- AI利用有無
- Human override有無

送らない情報:

- File content
- Access token
- Client secret
- Proxy credential
- AI response全文
- 文書引用
- 不要なabsolute path

Snowflake停止中もmigrationを継続し、復旧後にidempotentに再送する。

### 4.15 Report

CSVまたはJSONで以下を出力し、Boxの`_reports` folderへuploadする。

- Source-to-target mapping
- Source relative path
- Box file IDとlink
- Final destination
- Size/SHA-1 verification
- Metadata status
- Routing suggestionとhuman override
- Retry count
- Final statusとerror reason

## 5. Rate limitとparallelism

- MVPは1 CCG applicationと1 Service Account
- File concurrency初期値は3
- Chunk concurrency初期値は3
- Box公式が推奨する3〜5 part並列を上限の目安とする
- File並列とpart並列を一つのglobal controllerで制御する
- 429の`Retry-After`を守る
- SDK retryとapplication retryを重複させない
- API制限回避を目的に複数Service Accountを作らない

一般API 1,000回/分、upload 240回/分という公開値を常に得られる性能保証として
扱わない。Quality-of-service制限とenterpriseのlicensed API allocationを考慮する。

## 6. Non-functional requirements

### Reliability

- 各state transitionはidempotent
- Unknown outcomeをreconcile可能
- process restart後にduplicateを作らない
- metadata、AI、move、Snowflakeを段階別にretry可能
- Snowflake障害がtransferを止めない

### Security

- Sourceをread-onlyとして扱う
- Source fileを削除しない
- Target既存fileを無断上書きしない
- Mirror deleteを実装しない
- AIだけでfinal moveしない
- Credentialをrepository、UI、logへ出さない
- Box Service Accountにはmigration rootだけを共有する
- Staging accessを必要な担当者に限定する
- Synthetic dataだけを使用する

### Portability

- MVP実証環境はmacOS
- Node.jsによるcross-platform設計
- 未検証のWindows/Linux対応を表明しない
- SQLite WAL fileをSMBや同期folderへ置かない

### Operability

- Error codeだけでなく原因categoryと推奨対応を表示
- Failed phaseから再実行可能
- Upload完了とjob完了を区別
- Snowflake delivery待ちをtransfer failureと区別

## 7. MVP demo data

約30件のsynthetic documentsを用意する。

- Contract
- Invoice
- Employee record
- IT runbook
- Sales proposal
- 分類が曖昧なdocument
- 同名file
- 同一内容だが別itemとして扱うfile
- 50MBを超えるfile
- Box AI対象外または手動補完が必要なfile

## 8. MVP acceptance criteria

1. proxyを設定した場合、非透過型proxy経由で必要なBox通信が成功する
2. `PROXY_MODE=required`のとき、proxy停止時にdirect接続へfallbackしない
3. Direct UploadとChunked Uploadが動く
4. Box成功後・SQLite保存前の停止からduplicateなしで復旧する
5. Chunked途中停止からBox側partsと照合して復旧する
6. 同名競合を無断上書きしない
7. metadata失敗時にfileを再uploadしない
8. AI無効・対象外・失敗時も手動で完了できる
9. 承認前にfinal folderへmoveしない
10. 承認後に対象が変われば再承認する
11. Size、SHA-1、destination、必須metadata不一致を完了扱いにしない
12. Snowflake停止中もtransferを継続する
13. Snowflake再送でeventを二重計上しない
14. 429で`Retry-After`を守る
15. ReportからBox fileを特定できる

## 9. 対象外

- Permission migration
- Ownership migration
- Full version history migration
- Source削除
- Mirror sync
- Realtime sync
- NTLM、Kerberos、PAC
- Multiple source connectors
- Box-to-Box migration
- Multiple Service Accountによるrate limit回避
- Petabyte-scale保証
- Box Shuttle内部との直接連携

## 10. 追加目標

基本版と発表練習が完成した場合だけ、状態を観察して計画・調査・再計画する
AI Agent Orchestratorを検討する。通常のretry、upload、hash verification、
idempotencyはAgentではなくdeterministic Workerが担当する。
