# データモデルと処理の流れ

更新日: 2026-09-23（schema 10）

[architecture.md](architecture.md) は設計意図を書いた文書である。この文書は
**実装されたコードから起こした**もので、SQLiteのtable構成と、workerが実際に
何をどの順で動かしているかを示す。

- schemaの正本: `packages/db/src/migrations.ts`
- state機械の正本: `packages/core/src/state.ts`
- 実行loopの正本: `apps/worker/src/runtime.ts` と `apps/worker/src/pipeline.ts`

## ER図

以下は転送・承認の中心となるテーブルと主要列の関係を示す。全列を網羅する図ではない。
後から追加した設定・メタデータ・復旧用テーブルは次の一覧に示す。完全な定義は`migrations.ts`を参照する。

```mermaid
erDiagram
  migration_profiles ||--o{ migration_jobs : "profile_id"
  migration_jobs ||--o{ migration_items : "job_id"
  migration_jobs ||--o{ job_commands : "job_id"
  migration_jobs ||--o{ migration_events : "job_id"
  migration_items ||--o{ upload_sessions : "item_id"
  upload_sessions ||--o{ upload_parts : "session_id"
  migration_items ||--o{ extraction_results : "item_id"
  migration_items ||--|| routing_decisions : "item_id (UNIQUE)"
  migration_items ||..o{ migration_events : "item_id (FKなし)"

  migration_profiles {
    TEXT id PK
    TEXT name UK
    TEXT source_root_path
    TEXT target_staging_folder_id
    TEXT metadata_template_key
    INTEGER file_concurrency
    INTEGER chunk_concurrency
    INTEGER ai_routing_enabled
    INTEGER snowflake_logging_enabled
  }

  migration_jobs {
    TEXT id PK
    TEXT profile_id FK
    TEXT state
    TEXT operator_label
    TEXT staging_folder_id
    INTEGER pause_requested
    TEXT lease_owner
    TEXT lease_expires_at
    INTEGER total_items
    INTEGER total_bytes
  }

  migration_items {
    TEXT id PK
    TEXT job_id FK
    TEXT source_relative_path UK
    INTEGER source_size
    TEXT source_sha1
    TEXT state
    TEXT resume_state
    TEXT staging_name
    TEXT upload_strategy
    TEXT box_file_id
    TEXT box_sha1
    INTEGER bytes_transferred
    TEXT final_folder_id
    INTEGER attempts
    INTEGER retry_count
    TEXT next_attempt_at
    TEXT last_error_category
  }

  upload_sessions {
    TEXT id PK
    TEXT item_id FK
    TEXT box_session_id UK
    INTEGER part_size
    INTEGER total_parts
    TEXT expires_at
    TEXT state
  }

  upload_parts {
    TEXT session_id PK
    INTEGER part_index PK
    INTEGER part_offset
    INTEGER size
    TEXT sha1
    TEXT box_part_json
    TEXT state
  }

  extraction_results {
    TEXT id PK
    TEXT item_id FK
    INTEGER attempt
    TEXT provider
    TEXT raw_fields
    TEXT document_type
    TEXT suggested_destination_key
    REAL confidence
    TEXT refs
  }

  routing_decisions {
    TEXT id PK
    TEXT item_id FK
    TEXT state
    TEXT suggested_destination_key
    TEXT suggestion_source
    TEXT approved_destination_key
    TEXT approved_metadata
    TEXT approved_box_file_id
    TEXT approved_sha1
    INTEGER human_override
    TEXT operator_label
    TEXT approved_at
  }

  job_commands {
    TEXT id PK
    TEXT job_id FK
    TEXT type
    TEXT payload
    TEXT state
    TEXT rejection_reason
  }

  migration_events {
    TEXT id PK
    TEXT job_id FK
    TEXT item_id
    TEXT phase
    TEXT status
    INTEGER retry_count
    TEXT error_category
    TEXT box_file_id
    TEXT destination_key
    INTEGER ai_used
    INTEGER human_override
  }

  snowflake_outbox {
    TEXT event_id PK
    TEXT job_id
    TEXT payload
    TEXT state
    INTEGER attempts
    TEXT next_attempt_at
    TEXT delivered_at
  }
```

`snowflake_outbox` は外部keyを持たない。中身は送信用に
allowlistで整形済みのJSON payloadで、migration本体が消えても配信の記録として
独立に残る必要がある。`event_id` は `migration_events.id` と同じ値を使うので、
送信先で重複を識別できる。配信は再送を含み、SnowflakeではEVENT_IDによるMERGE、
ローカルJSONLではeventIdを使った重複識別を前提とする。

## 各tableの役割

| Table | 役割 |
|---|---|
| `migration_profiles` | 移行元folder、staging先、並列数、AI有無の設定。credentialは持たない |
| `migration_jobs` | 1回の移行。worker leaseとpause要求もここ |
| `migration_items` | file 1件。**stateの正本**。ここを見れば1 fileがどこまで進んだか分かる |
| `upload_sessions` | 50MB超のchunked upload session。process再起動をまたいで再利用する |
| `upload_parts` | chunkごとの記録。途中停止時にBox側のlist partsと突き合わせる |
| `extraction_results` | Box AIの応答。attemptごとに追記するので、何回目の抽出かが残る |
| `routing_decisions` | AIの提案と**人の承認**。item 1件に1行（UNIQUE制約） |
| `job_commands` | UIからの操作要求。claim tokenと期限を持ち、処理中断から回復する |
| `migration_events` | 進捗と失敗の履歴。UI表示とreportの元 |
| `snowflake_outbox` | ローカルJSONLまたはSnowflakeへ送る整形済みpayloadの待ち行列 |
| `job_destinations` | 移行ごとに選んだBoxの既存配置先候補 |
| `runtime_settings` | 共通のAI分類・並列数・ログ出力先と保存revision |
| `metadata_settings` | アプリで使用するテンプレートの一覧と保存revision |
| `job_metadata` | 移行で使うテンプレート定義。行なしは旧方式、空の一覧は新方式の未設定 |
| `item_metadata` | ファイルごとのテンプレート・抽出値・revision・抽出状況 |
| `business_metadata_writes` | この移行がBoxへ書き込んだテンプレートの記録。書き込み結果不明からの回復に使う |
| `test_deleted_files` | テスト終了で削除したファイルの記録 |
| `worker_heartbeats` | ワーカーの最終応答時刻 |

分類応答の`raw_fields`には選択された`metadataTemplateId`も保持する。`classification_key`は
ファイル同一性と分類条件を含むキャッシュキー。項目抽出の再試行で分類APIを重複実行しない。
`item_metadata.extraction_status`は抽出成功・空・失敗・手動入力を区別する。

## 誰が何を書くか

**書き込む主体が分かれている。** 次の図は移行処理の状態更新について示す。
設定・移行の作成時にはWeb側も対応する設定テーブル・profile・jobを保存する。

```mermaid
flowchart LR
  ui["Web UI<br/>Next.js"]
  cmd[("job_commands")]
  worker["Worker"]
  items[("migration_items<br/>routing_decisions<br/>migration_events")]
  outbox[("snowflake_outbox")]
  sender["Outbox sender"]

  ui -->|"insertのみ"| cmd
  ui -.->|"読むだけ"| items
  worker -->|"claim / 実行"| cmd
  worker -->|"同一transactionで更新"| items
  worker -->|"同一transactionでinsert"| outbox
  sender -->|"読んで配信、既読に更新"| outbox
```

UIから `migration_items.state` を書き換える経路は存在しない。承認ボタンを押すと
`job_commands` に `APPROVE_ITEM` が1行入るだけで、実際にBox内moveするのはworkerで
ある。workerは現在のファイル状態と承認revisionを照合して古い操作を拒否する。

## Workerのloop

`apps/worker/src/runtime.ts` のジョブ処理の概略は次のとおり。実行中はleaseと稼働時刻も更新する。

```mermaid
flowchart TB
  start["tick開始"] --> cmds["processCommands()<br/>job_commandsを処理"]
  cmds --> claim{"claimJob()<br/>leaseを取れたか"}
  claim -->|"いいえ"| sleep["500ms待つ"]
  claim -->|"はい"| pause{"pause_requested?"}
  pause -->|"はい"| paused["PAUSEDにして終了"]
  pause -->|"いいえ"| queued{"state = QUEUED?"}
  queued -->|"はい"| wait["何もしない<br/>START_JOB commandを待つ"]
  queued -->|"いいえ"| staging["staging folderを確保"]
  staging --> rec{"このprocessで<br/>reconcile済みか"}
  rec -->|"未"| reconcile["reconcileJob()<br/>Box側と突き合わせ"]
  rec -->|"済"| scanq
  reconcile --> scanq{"state = SCANNING?"}
  scanq -->|"はい"| scan["scanSource() して RUNNING へ"]
  scanq -->|"いいえ"| drain["空いた処理枠へ逐次投入"]
  drain --> fin{"1件も進まなかったか"}
  fin -->|"はい"| maybe["maybeFinishJob()"]
  fin -->|"いいえ"| sleep
  sleep --> start
```

`claimJob` はSQLite上のleaseで、既定30秒。**1 workerが同時に扱うjobは1つ**。lease
があるので、workerを2つ起動しても同じjobを二重に処理しない。

## 3つのqueue

ここが「uploadとAI処理は別queue」の実体である。`pipeline.ts` がstateを3つの
scopeに分けていて、`runtime.ts` が各scopeの空いた枠へ逐次投入する。
分類や配置が遅くても、転送枠が空けば次のファイルを進める。ファイル並列数は1〜5、
分類と配置は各2。分割転送の1〜4枠は全ファイルで共有する。
操作・設定変更時は投入を止め、実行中のステップの終了を待って反映する。

```mermaid
flowchart LR
  subgraph T ["TRANSFER_SCOPE (並列 = file_concurrency)"]
    t1["DISCOVERED / HASHING"] --> t2["PREFLIGHT / READY"] --> t3["UPLOADING / STAGED"] --> t4["TRANSFER_VERIFIED<br/>PROVENANCE_PENDING"]
  end
  subgraph R ["ROUTING_SCOPE (並列 2)"]
    r1["PROVENANCE_APPLIED"] --> r2["AI_PENDING"]
  end
  gate["REVIEW_REQUIRED / NEEDS_REVIEW<br/>どのqueueにも属さない"]
  subgraph P ["PLACEMENT_SCOPE (並列 2)"]
    p1["APPROVED"] --> p2["MOVING"] --> p3["FINAL_VERIFY"]
  end

  T --> R --> gate --> P
```

**`REVIEW_REQUIRED` はどのscopeにも入っていない。** つまりworkerは構造的にこの状態
のitemを拾えない。`APPROVE_ITEM` commandが `REVIEW_REQUIRED → APPROVED` に動かして
初めて、PLACEMENT queueが拾えるようになる。「承認前にmoveしない」がコメントや
if文ではなく、queueの定義そのもので保証されている。

## stateとstepの対応

`pipeline.ts` の `STEPS` がそのままこの表である。

| state | 実行される関数 | queue |
|---|---|---|
| `DISCOVERED` / `HASHING` | `hashItem` | TRANSFER |
| `PREFLIGHT` | `preflightItem` | TRANSFER |
| `READY` / `UPLOADING` | `uploadItem` | TRANSFER |
| `STAGED` | `verifyTransfer` | TRANSFER |
| `TRANSFER_VERIFIED` / `PROVENANCE_PENDING` | `applyProvenance` | TRANSFER |
| `PROVENANCE_APPLIED` / `AI_PENDING` | `runRouting` | ROUTING |
| `AI_COMPLETED` | （なし。`runRouting` 内でREVIEW_REQUIREDへ） | — |
| `REVIEW_REQUIRED` | （なし。人の承認待ち） | — |
| `APPROVED` | `placeItem` | PLACEMENT |
| `MOVING` / `FINAL_VERIFY` | `finalVerify` | PLACEMENT |
| `COMPLETED` | （終端） | — |

同じ関数が2つのstateに紐づいているのは、途中で落ちた場合にそのstepの手前から
やり直せるようにするためである。新方式の`applyProvenance`はBoxへ書き込まず、
互換性のため残した状態を通過する。業務メタデータの付与は承認後の`placeItem`で行う。
その書き込みに失敗しても、アップロード工程へ戻さず配置工程から回復する。
旧方式だけは`applyProvenance`で共通メタデータを付与する。

## 失敗したときの寄り道

pipeline stateが16個、その外にside stateが6個ある。失敗すると
`handleStepFailure` がerror categoryを見て3つに振り分ける。

```mermaid
stateDiagram-v2
  direction LR
  state "pipeline state" as P
  P --> RETRY_WAIT: 一時的 (429 / 5xx / lock)
  P --> UNKNOWN_OUTCOME: 結果不明 (timeout)
  P --> NEEDS_REVIEW: 人の判断が必要
  P --> FAILED: 恒久的 (認証 / 権限)
  RETRY_WAIT --> P: next_attempt_at 経過後
  UNKNOWN_OUTCOME --> P: Box側と照合後
  NEEDS_REVIEW --> P: 操作者のcommand
```

side stateに逃げるとき、**元のstateを `resume_state` 列に書き残す**。復帰時は
`effectiveState()` がそれを読んで、落ちたstepだけをやり直す。`RETRY_WAIT` と
`UNKNOWN_OUTCOME` を分けているのは、結果が不明な通信はretryの前にBox側を
listingして照合しないと重複を作りうるからである。

`attempts` はstepごとにリセットされ、`retry_count` は通算で残る。前者はretry
予算、後者は指標という使い分けである。

## commandの一生

```mermaid
sequenceDiagram
  autonumber
  participant H as 操作者
  participant W as Web (Route Handler)
  participant D as SQLite
  participant K as Worker

  H->>W: 承認ボタン
  W->>D: job_commands へ PENDING でinsert
  W-->>H: 202（受付。実行はまだ）
  K->>D: PENDING を CLAIMED にして取得
  K->>D: claimを検証し、承認内容・APPROVED・DONEを同一transactionで保存
  Note over K: 以降は PLACEMENT queue が拾う
```

command typeは10種類（`START_JOB` `PAUSE_JOB` `RESUME_JOB` `RESCAN_JOB`
`RETRY_FAILED` `RETRY_ITEM` `APPROVE_ITEM` `SKIP_ITEM` `SEND_TO_REVIEW`
`GENERATE_REPORT`）。実行できない状態のcommandは `REJECTED` になり、
`rejection_reason` が残る。

## telemetryが失われない理由

`migration_items` のstate更新と `snowflake_outbox` へのinsertを、**同一の
SQLite transaction**で確定している（`packages/db/src/store.ts` の
`transitionItem`）。そのため次の2つが同時に成り立つ。

- Snowflakeが停止していてもmigrationは進む（outboxが伸びるだけ）
- migrationが進んだのにeventが記録されていない、という状態が起きない

送信はworkerとは別のloop（`OutboxSender`）が担当し、`event_id` で冪等に配信する。
送る項目は `packages/telemetry/src/payload.ts` のallowlistだけで、file名、
絶対path、credential、AI応答の全文は入らない。
