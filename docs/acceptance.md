# 検証状況と旧MVPの実測記録

更新日: 2026-09-23

## 現行版の検証範囲

承認・完了画面の改善を含めて自動テスト423件、fake Box検証22項目、型チェック・lint・本番ビルドが成功。
自動テストには候補テンプレートの受け渡し、不正なAI回答の不採用、自動抽出、抽出失敗と再抽出、
詳細を開かない一括承認、旧DBの更新を含む。
UI改善では全件検索・状態フィルター、205件のページング、手動配置先の下書き、
非表示の選択解除、処理中・要対応の一括承認除外、プレビュー維持、履歴操作、通信タイムアウト、
SSEによる完了切り替え、部分失敗・除外・対象なしの表示を確認した。
操作テストはjsdom。ブラウザー実行は環境のsocket権限制限で失敗し、実際の画面描画の確認は未実施。
独立した22項目の`verify`は旧共通メタデータ方式のfixtureによる転送検証。
新方式は`test/business-metadata.test.ts`などの自動テストとMac側の実Box確認で検証する。

最新のテンプレート自動選択の精度と実Boxでの通し確認、実Snowflakeへの送信、Windows実機、
TLS interception環境は未検証。fake Boxは決定的な合成応答であり、Box AIの分類精度の証拠にはしない。

以下の実Box・Squidの成功記録は旧共通メタデータ方式のMVPで取得したもの。
最新仕様の操作確認は[メタデータの確認項目](metadata-templates.md)に従う。

[要件 section 8](requirements.md) の15項目に対して、どこで検証しているかを示す。
`npm test` で実行できるものを「自動」、実Box/実proxyが必要なものを「実機」と区別する。

## 3つの検証レイヤ

```sh
npm test                    # 現行のunit・UI・pipelineの自動テスト
npm run verify -- --faults  # 22項目。fake Boxへ全件移行し、保存されたbyteと照合
npm run verify -- --real    # 18項目。実Box enterpriseへ全件移行し、Box側と照合
npm run verify:box          # 8項目。1 fileだけの疎通確認（API単位の確認用）
```

`--real` は実行ごとに `/Shuttle Lite/_verify/<実行時刻>/` を作り、その下に本番と
同じlayout（`_staging` / `_needs_review` / `_reports` / `destinations`）を組む。
本番のdestinationsを汚さず、何度流しても同名衝突しない。

### 実Boxでの実行結果（2026-09-15）

2回連続で **18 / 18 項目成功**。fixture 32件 / 51.0 MB を移行し、52MBのfileは
chunked uploadで転送された。

fake Boxでは全項目通っていたが、実Boxでは初回に全32件が失敗した。実機でしか
見つからなかった問題は次の4件で、いずれも修正済みである。

| 症状 | 原因 | 対処 |
|---|---|---|
| 全32件がupload時に400 | `content_modified_at` にミリ秒付きISOを渡していた。Boxは `not a valid rfc 3339 formatted date` を返す | 秒精度とoffset形式へ正規化 |
| metadata書き込みが400 | Box AIが返す `2026-04-01` を date fieldが受け付けない | 日付のみの値に `T00:00:00+00:00` を補完 |
| AI対象外fileがFAILED | 実Boxは対象外形式にも汎用の `Bad request` を返す。fakeのように `AI_UNSUPPORTED` は返らない | AI endpointの400を `AI_UNSUPPORTED` へ翻訳し、手動fallbackへ回す |
| 長時間uploadが即FAILED | `ERR_HTTP2_STREAM_ERROR` をUNKNOWN扱いにしていた | 一時障害としてretryとreconcileの対象へ |

加えて、uploadが409を返したときに自分の以前のuploadを照合せずreviewへ送っていた
問題を修正した。結果不明のuploadをretryした際に実際に発生し、deterministicな
staging名で照合して重複なく採用するようにした。

`npm run verify` は `.shuttle-lite/verify/<実行時刻>/` に専用のSQLiteとfake Boxを作り、
fixture 32件を最後まで移行してから検証する。重要なのは、pipelineが記録したSHA-1を
信用せず、**source fileとBox側に保存されたobjectの両方からその場でSHA-1を再計算して
突き合わせる**点である。pipelineの自己申告とは独立した確認になっている。

直近の実行結果（32件 / 51.0 MB、承認まで0.4秒）:

```text
1. 全fixtureの移行と独立検証     17項目すべて成功
   Box上のbyteがsourceとSHA-1で一致する   32件 / 51.0 MB を再計算して照合
   必須provenance metadataが揃っている     8 field × 32件
   重複したBox fileが無い                  Box file ID 32個 / item 32件
   telemetryが許可fieldだけを送っている     481 event / 14 field
2. 障害シナリオ                   4項目すべて成功
   429でRetry-Afterの待ち時間を守る        8件が待機、最大 973 ms
   429を挟んでも全件が転送を完了した        backoff解除3回、retry合計11回
   結果不明のuploadを重複なく復旧した       staging 32 -> 32件（同名1件）
   metadata失敗でfile本体を再uploadしない   upload回数 31 のまま
```

この検証で、retryの試行回数がstepごとではなくitemの生涯で累積する問題を発見して
修正した（uploadで2回retryしたfileが、AI stepで使える試行回数を失っていた）。

| # | 受け入れ基準 | 状況 | 根拠 |
|---|---|---|---|
| 1 | proxyを設定した場合、非透過型proxy経由でBox通信が成功する | 実機（成功） | Squid 7.7 経由で実Boxへ 32 件 / 51 MB を移行。下記「proxy経由での実測」 |
| 2 | `PROXY_MODE=required` でproxy停止時にdirect接続へfallbackしない | 自動（unit）+ 実機（成功） | `packages/config/test/config.test.ts` の「refuses to fall back to a direct connection」、`packages/box/test/transport-errors.test.ts`。実機は下記 |
| 3 | Direct UploadとChunked Uploadが動く | 自動 | `test/e2e.test.ts`「carries a file from scan to final placement」「uses the chunked path for a large file」 |
| 4 | Box成功後・SQLite保存前の停止からduplicateなしで復旧 | 自動 | `test/recovery.test.ts`「adopts an upload whose outcome was never recorded」 |
| 5 | Chunked途中停止からBox側partsと照合して復旧 | 自動 | `test/recovery.test.ts`「resumes a chunked upload from the parts Box already has」 |
| 6 | 同名競合を無断上書きしない | 自動 | `test/e2e.test.ts`「keeps two files with the same name apart」「skips a name conflict when the job asks for it」「never renames behind an operator who typed the name」、`test/recovery.test.ts`「stops at review rather than completing」、`packages/box/test/fake-gateway.test.ts` |
| 7 | metadata失敗時にfileを再uploadしない | 自動 | `test/recovery.test.ts`「retries only the metadata write when metadata fails」 |
| 8 | AI無効・対象外・失敗時も手動で完了できる | 自動 | `test/e2e.test.ts`「lets an operator finish a file the AI could not read」 |
| 9 | 承認前にfinal folderへmoveしない | 自動 | `test/e2e.test.ts`「only after a human approval」、`packages/core/test/state.test.ts`「never moves an unapproved item」 |
| 10 | 承認後に対象が変われば再承認する | 自動 | `test/e2e.test.ts`「asks for another decision when the file changed after approval」、`packages/routing/test/routing.test.ts` |
| 11 | Size、SHA-1、destination、必須metadata不一致を完了扱いにしない | 自動 | `packages/core/test/state.test.ts`「refuses to skip verification」、`packages/routing/test/routing.test.ts`「detects missing provenance」、`finalVerify` の実装 |
| 12 | Snowflake停止中もtransferを継続する | 自動 | `packages/telemetry/test/telemetry.test.ts`「keeps the backlog and does not lose events when the sink is down」 |
| 13 | Snowflake再送でeventを二重計上しない | 自動 | `packages/telemetry/test/telemetry.test.ts`「writes each event once, even if a batch is redelivered」 |
| 14 | 429で`Retry-After`を守る | 自動 | `packages/core/test/retry.test.ts`、`test/recovery.test.ts`「honours Retry-After from a 429」 |
| 15 | ReportからBox fileを特定できる | 自動 | `test/e2e.test.ts`「produces a report and delivers allowlisted telemetry」 |

## proxy経由での実測（基準1、2）

非透過型proxy (Squid 7.7、Basic認証、宛先allowlist) を立て、`PROXY_MODE=required`
で実Box enterpriseへ移行した。手順は [infra/squid/README.md](../infra/squid/README.md)。

```
npm run squid:start
npm run verify -- --real     18 / 18 件の検証項目が成功（32 件、51 MB、177 秒）
npm run squid:log            tunnel 7 本 / 上り 51.3 MB / 下り 0.5 MB
                             全行 TCP_TUNNEL/200 user=shuttle
```

移行した51 MBがそのままSquidの上り方向に出ている。つまりBox通信のすべてが
proxyを通っており、direct接続へ抜けた通信は無い。CONNECT tunnelは1本で複数の
requestを多重化するため、log行数はrequest数ではなくtunnel数になる。

proxyが働いていることを、成功以外の経路でも確認した。

| 条件 | 結果 | 分類 |
|---|---|---|
| allowlist外の宛先 (example.com) | Squidが拒否 | `TCP_DENIED/403` |
| `PROXY_PASSWORD` を誤った値にする | Box通信は成立しない | `PROXY_AUTH` (407) |
| proxyへ到達できない (port閉) | direct接続へ抜けず停止 | `PROXY_CONNECT` (ECONNREFUSED) |

この検証で2つの問題を見つけて修正した。

1. undiciはCONNECTの失敗を `RequestAbortedError` で返し、statusをmessageにしか
   入れない。そのため407が `UNKNOWN` に分類され、「proxyが認証を要求している」
   ことが運用者に伝わらなかった。messageからstatusを復元して `PROXY_AUTH` /
   `PROXY_CONNECT` に分類するようにした（`packages/box/src/http/errors.ts`）。
2. `npm run check:proxy` がworkerと別のerror処理を使っており、同じ失敗でも
   分類が出なかった。workerと同じ分類器を通すようにした。

proxy経由では `ERR_HTTP2_STREAM_ERROR` が直接接続時より起きやすい。1件で発生し、
retry後に409を受け、staging上の既存fileと照合して重複なく完了した。proxyを挟むと
長時間uploadのstreamが切れやすくなるという想定は、この結果と一致する。

## 自動テストで押さえている追加の性質

- Job scheduling: review待ちのjobが後続jobをstarveさせない (`test/scheduling.test.ts`)
- Worker lease: 同一jobを2 workerが同時に処理しない (`packages/db/test/store.test.ts`)
- Telemetry allowlist: event messageやlocal pathがSnowflake payloadへ入らない (`packages/telemetry/test/telemetry.test.ts`)
- Windows特有の失敗: 共有違反、Office lock file、MAX_PATH、state fileの配置 (`test/windows.test.ts`)

## 実機でのみ確認できる項目

1. Box AI Structured Extractの実際のresponse shapeとconfidence有無 ([Q-004](decisions.md))
3. Metadata templateのfield型と文字数制限 (Q-005)
4. Snowflake driverのproxy設定とidempotent load (Q-007)

これらは [docs/integration-todo.md](integration-todo.md) の手順で実施する。
