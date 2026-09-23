# Decisions and Open Questions

## Confirmed decisions

### D-001: Product and priority

- Working name: Shuttle Lite
- Box Shuttleを置き換えず、標準範囲外の限定migration pathを実証する
- 基本版を最優先し、常駐AI Agent Orchestratorは追加目標とする

### D-002: Development environment

- MVPはmacOSで実証する
- TypeScript/Node.jsを採用する
- Cross-platformを意識するが、未検証OSをsupportedと表明しない

### D-003: Process separation

- Next.jsは操作と表示を担当する
- Long-running transferは別Workerが担当する
- Route Handler内でmigrationを実行しない

### D-004: Operational state

- SQLiteを正本とする
- WALはlocal diskだけで利用する
- Snowflakeをjob stateの正本にしない

### D-005: Content path

- Browser経由でfile bodyを送らない
- Workerがsource fileをstreamとして読む
- 独自cloudへfile bodyを中継しない

### D-006: Box staging

- Box AI実行前にaccess-limited stagingへuploadする
- staging upload後にsize/SHA-1を検証する
- approval後はBox内moveを使い、再uploadしない

### D-007: AI authority

- AIはextractとdestination suggestionを担当する
- AIへ任意のfolder IDを生成させない
- 2026-09-22: 配置先は「新しい移行」で選んだBoxフォルダーと配下の既存フォルダーに限定する。
  Webは読み取りAPIで選択範囲を取得し、jobと同一transactionでsnapshotを保存する。
  Workerと承認画面はそのjobのsnapshotを使い、共通サンプルへfallbackしない。
  AIには不透明なkeyとフォルダー名・階層を渡す。key→folder IDの対応付けはアプリ側で行う。
  最終配置前にfolderの存在・階層・名前を確認し、変わっていれば確認待ちに戻す。
  `config/destinations.json` はfake Box専用。実Boxでは分類先を自動作成しない。
- MVPでは全件human approvalを必須とする
- AI無効・失敗・対象外でもmanualに完了できる

### D-008: Metadata scope

2026-09-23 更新（利用者合意）:

- 新規の移行は文書種別ごとの既存Boxテンプレートを利用する。初期対象は契約書・請求書。
- 設定画面で文書種別とテンプレートを対応づけ、Boxから取得した項目定義をジョブごとに固定する。
- Box AIで文書種別を判定し、該当テンプレートを指定して値を抽出する。未判定は自動選択しない。
- 人がテンプレート・値を確認し、配置先とともに承認する。空欄にした値をAI値で補完しない。
- Boxへは業務テンプレートだけを付与する。移行ID、SHA-1、元パスなどの管理情報はSQLite・レポートに保持する。
- 承認前にBoxの業務メタデータは書き込まない。書き込み前に項目定義の変化を確認し、最終検証で値を照合する。
- 対応するフィールドは文字列・数値・日付・単一選択。テンプレートの作成や企業全体の定義変更はアプリから行わない。
- schema 8以前から存在するジョブは従来方式のまま完了できる。既存Boxメタデータを一括削除しない。
- 再承認でテンプレートを変えた場合、当該ジョブが付与を記録した旧インスタンスだけを除去する。

以下は既存ジョブの互換動作:

- 共通provenance/routing templateを一つ用意する
- MVPのbusiness fieldsはdocument type共通のgeneric fieldsに限定する
- Domain固有templateとfolder metadata/cascadeは自動的にscopeへ追加しない
- 2026-09-22: 新規の実Box用templateは配置先keyをstringにする。既存templateは変更しない。
  既存templateがサンプル固定enumの場合、未定義のkeyをenumへ書かず、既存のroutingReasonに
  配置先pathとkeyを記録する。最終検証ではその記録・承認者・実際の親folder IDを照合する。
  SQLiteの承認記録とreportには引き続き正確なkey・folder IDを保持する。

### D-009: Approval identity

- MVPのlocal operatorはenterpriseで本人確認済みとは扱わない
- Service Accountの実行identityとlocal operator labelを区別する
- 本番化時のBox OAuth/SSO/Box Taskは将来検討とする

### D-010: Rate limits

- MVPは1 Service Account
- Boxの`Retry-After`を守る
- 複数Service Accountでrate limitを回避しない
- File/part parallelismをglobalに制御する

### D-011: Snowflake

- Transactional Outboxを使う
- Snowflake停止時もmigrationを継続する
- Allowlistされたtelemetryのみ送る

### D-012: Safety

- Sourceを削除しない
- Mirror deleteを実装しない
- 同名fileを無断上書きしない
- Unknown outcomeをreconcileしてからretryする

### D-013: Box API client (Q-001の結論)

- 公式SDKではなく`undici`ベースの薄いREST clientを採用する
- 理由: proxy dispatcher、custom CA、`Retry-After`、request ID、abort/timeout、
  chunked uploadのpart復旧を、SDKの抽象に隠されずに制御できる
- Q-002とQ-003の懸念が、そのまま実装で解消される
- `BoxGateway` portの裏に置くため、後からSDKへ差し替えることもできる
- 実装は`packages/box/src/http/`。未接続の実enterprise検証は
  [integration-todo](integration-todo.md)

### D-014: 対象platform

- Codeはcross-platformを維持し、**検証と発表はWindowsを主**とする
- 理由: Box Shuttleのfile server移行は
  [Windows Agent](https://docs.box.com/en/box-shuttle/configuring-source-systems/box-shuttle-windows-agent)
  であり、対応OSはWindows 8/10/11とWindows Server 2012 R2〜2022。
  明示的proxy制約のある顧客のfile serverはWindows上にある
- Windows専用化はしない。専用化で得られるVSS、NTFS ACL、NTLM/Kerberosは
  いずれも対象外の領域である
- Windows固有の失敗（共有違反、Office lock file、MAX_PATH、UNC、state file配置）
  を分類済みerrorとして実装する。詳細は[windows.md](windows.md)
- 未検証OSをsupportedと表明しない方針は維持する
- **検証と発表の主軸については[D-016](#d-016-発表時点の検証環境はmacosにする)で見直した**

### D-015: Box-to-Box migration

- MVPでは実装しない。ただしsourceを差し替えられる`SourceAdapter` portを切る
- `LocalSourceAdapter`のみ実装し、`BoxSourceAdapter`は設計として残す
- Box Shuttleのself-service対応sourceにBox-to-Boxは含まれず、gapは実在する
- Download APIの`range` header対応とfile objectの`sha1`により、
  移行元Boxと移行先BoxのSHA-1照合で完全性検証が成立する
- Version history、ownership、permission、retention、shared link URLは
  API経由では運べない。対象外として明示する
- 詳細は[box-to-box.md](box-to-box.md)

### D-016: 発表時点の検証環境はmacOSにする

2026-09-15。[D-014](#d-014-対象platform)の「検証と発表はWindowsを主とする」を、
発表までの期間について見直した。

- 9/30の発表はmacOS上で実演する。Windows実機検証は発表後に回す
- 理由: 残り期間で証明すべき主張はproxy制約下での移行可否、provenance、AI提案と
  承認、telemetryであり、いずれもOS非依存である。Windows VM構築（[M4](plan-to-demo.md)）
  はSilver Weekを丸ごと使うが、それで新たに証明できる主張は無い
- Windows対応は実装済みのまま維持する。共有違反、Office lock file、MAX_PATH、UNC、
  state file配置は分類済みerrorとして実装し、`test/windows.test.ts` で
  errorコードとpathを注入して検証している
- ただし**実機未検証をsupportedと表明しない**方針は変えない。発表では
  「Windows固有の失敗は実装済み、実機検証は未実施」と述べる。実機で動くとは言わない
- 顧客のfile serverがWindows上にあるという[D-014](#d-014-対象platform)の前提は
  変わっていない。PoCの次段階でWindows実機検証を最初に置く

### D-017: 同名衝突はjob単位のpolicyで解決する

2026-09-16。配置先に同名fileがあるときの扱いを、Box Shuttleの実仕様に合わせた。

Box Shuttleが同じ問いにどう答えているか:

- 「[Box Shuttle does not overwrite any updated data in
  Box](https://docs.box.com/en/box-shuttle/about-box-shuttle/introducing-box-shuttle#content-migration)」。
  delta syncを繰り返しても、Box側で更新された内容を上書きしない
- source側に同名itemがあるときは[一意のIDを付けて改名し、両方を運ぶ](https://docs.box.com/en/box-shuttle/configuring-source-systems/google-drive#duplicated-names)。
  `Content1` と `Content1 (abcdefg12345)` のようになる
- 衝突をjob設定で一括処理する。permission衝突では
  [Expand / Restrict / Skip files that have conflicts](https://docs.box.com/en/box-shuttle/about-box-shuttle/box-shuttle-standard-and-advanced-tooling#permissions-mapping)
  の3択を先に選ばせ、1件ずつ人に触らせない

決定:

- `migration_profiles.conflict_policy` を追加し、`RENAME`（既定）と`SKIP`から選ぶ
- `RENAME`: `report.pdf` → `report (2).pdf` と連番を付けて両方残す。Shuttleは
  一意IDを使うが、Lite は移行規模が小さく `findFileByName` で空きを確認できるため、
  人が読める連番を選ぶ。20回試して空きが無ければ人の判断へ回す
- `SKIP`: 配置せずSKIPPEDにしてreportに残す。Shuttleの
  "Skip files that have conflicts" と同じく、後で回収する運用を想定する
- **上書き（新version追加）は実装しない**。Box APIの「上書き」は
  `POST /files/:id/content` による新version追加で、moveでは実現できない。
  再uploadが必要になり、file IDも移行先の既存fileのものへ変わるため、
  「file IDを保存したままmoveする」という[D-006](#d-006-box-staging)の
  前提が崩れる。加えてShuttleの明文化された方針とも反する
- 操作者がreview画面で名前を入力した場合は、policyを適用せず衝突をreviewへ戻す。
  衝突を見たうえでの判断を、裏で書き換えないため
- 名前を確認してからmoveするまでの間に別のitemが同じ名前を取りうる。Boxが返す
  衝突をもう一度policyへ通して解決する

## Decisions to validate with a spike

### Q-001: Box SDK package

> 2026-09-14: D-013で決着。以下は判断に使った条件として残す。

2026年9月時点の公式資料には、新規開発向け`box` package (`box/sdk`)と
`box-node-sdk@10`を使うtutorialの両方がある。

選定条件:

- CCG
- Direct Upload
- Manual Chunked Upload
- Box AI Structured Extract
- Metadata
- Move
- Proxy/custom CA
- Abort/timeout
- Request IDとresponse headers

両方を同時にinstallしない。最小spikeで一方を固定する。
Deprecatedな`box-typescript-sdk-gen`は新規採用しない。

### Q-002: Proxy support

- Box auth/API/upload/AIが同じdispatcher/agentで動くか
- Basic proxy auth
- Custom CA
- Proxy停止時のdirect fallback防止
- SDK retryとapplication retryの境界

### Q-003: Chunked resume

- SDK helperでprocess restart後にsessionを再利用できるか
- Manual REST/SDK callsが必要か
- List partsとcommit resultをどう照合するか
- Expired session時に安全に再作成できるか

### Q-004の実測結果 (2026-09-15)

`npm run measure:ai` でPDF 15件を実Boxへuploadし、extractを計測した。
（初回は9件で計測。demo用にfixtureを15件へ増やして再計測した結果が下である）

| 項目 | 実測 |
|---|---|
| 成功 | 15 / 15 |
| upload後extractが通るまで | 最小 2.6秒 / 最大 6.8秒 / 平均 3.3秒 |
| `AI_NOT_READY` (202) | **0回**。representation待ちは発生しなかった |
| `confidence` | **返らない**（15件すべてnull） |
| catalog外のkeyを返した件数 | 0 |
| 配置先の提案 | 判断した14件はすべて正解。1件は判断を断った |
| model | `google__gemini_3_1_flash_lite` |

抽出精度は高い。契約番号 `LEG-2026-1001`、請求番号 `FIN-2026-2001`、社員番号
`HR-2026-3001`、文書番号 `IT-2026-4002` をいずれも正しく取得し、日付も正確だった。
判断が難しい「契約に基づくご請求のご案内」には `FINANCE_INVOICES` を、手掛かりの
ない「打ち合わせ覚書」には `NEEDS_REVIEW` を選んでいる。

同名fileの扱いも正しい。`legal/contracts/keiyakusho.pdf` と
`sales/proposals/keiyakusho.pdf` は同じfile名だが、前者を `LEGAL_CONTRACTS`、
後者を `SALES_PROPOSALS` と中身で振り分けた。

残る注意点は3つ。

- `documentType` は**日本語で返る**（「業務委託契約書」「請求書」）。fakeは英語の
  "Contract" を返すため、集計軸に使うなら正規化が必要。
- **字体が揺れる。** 「従業員記録」が繁体字の「從業員記錄」で返った。field descriptionへ
  「日本語の常用漢字で答え、繁体字や簡体字は使わない」と書いたところ解消した。
  自由記述をそのままmetadataへ書く場合、言語だけでなく字体まで指定する必要がある。
- `AI_NOT_READY` のretry経路は実機で一度も発火していない。実装はしてあるが、
  大きいPDFやOffice文書では発生しうるため、未検証のまま残る。

#### NEEDS_REVIEW は提案ではない

AIが判断できないときは、catalogの `needsReviewKey` (`NEEDS_REVIEW`) を返す。これは
`/Shuttle Lite/_needs_review` という実在folderのkeyであり、提案として数えると
「全件に提案があった」と読めてしまう。判断が付いたかどうかは
`hasRoutingDecision()` で判定する（`packages/routing/src/approval.ts`）。
承認画面と測定scriptの両方が同じ規則を使う。

#### PDF fixtureの作り方

`cupsfilter` は日本語フォントを埋め込むが `/ToUnicode` を出力しないため、
**見た目は正しいのにテキスト抽出ができないPDF**になる。headless Chromeで
HTMLを印刷する方式に変更した（`npm run fixtures:pdf`）。Chromeは `/ToUnicode`
を出力するため、Box AIがテキスト層を読める。

### Q-004: Box AI readiness

- Upload完了後、Structured Extract可能になるまでの時間
- Representation pending時のerror
- Supported synthetic file formats
- Confidence/referenceの実際のresponse shape
- CCG Service AccountでのAI access

### Q-005: Metadata schema

MVPのgeneric business fields候補:

```text
documentType
businessDomain
businessIdentifier
effectiveDate
suggestedTags
suggestedDestinationKey
approvedDestinationKey
routingReason
```

Box Metadata field typeと文字数制限に合わせて確定する。

### Q-006: Staging identity

Unknown outcome復旧用のdeterministic staging nameを確定する。

候補:

```text
{migrationItemId}__{originalName}
```

最終rename/move時の409とoriginal name復元を検証する。

### Q-007: Snowflake proxy and idempotency

- Node driverのproxy設定
- Custom CA
- Event batch size
- Event IDの重複排除方法
- Snowflake unavailable時のlocal backlog

## Explicitly deferred

- NTLM/Kerberos/PAC
- Permission/ownership/full version history
- Box-to-Box
- Multiple source connectors
- Verified enterprise approver identity
- Multiple uploader identities
- UPDATE/delta mode
- Bandwidth schedule
- Box Automate integration
- AI Agent Orchestrator
