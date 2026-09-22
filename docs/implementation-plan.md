# Implementation Order

この文書は実装順序を定める。Requirementsを削除するものではなく、早期に
end-to-end riskを発見するための順番である。

## Phase 0: Documentation and toolchain

現在のscope:

- Requirements、architecture、decision logをrepoへ保存
- Planned directory boundaryを作る
- Application dependencyはまだ導入しない

次のscope:

- Node.js/npm/Docker version確認
- npm workspaces
- TypeScript、Zod、Vitest、lint/format
- Next.jsとWorkerのempty startup
- SQLite local file
- `.env.example`

Exit criteria:

- WebとWorkerを別processで起動できる
- Unit testとlintを実行できる
- Credentialなしでdry-run startupできる

## Phase 1: One-file vertical slice

```text
UIでJob作成
→ SQLite保存
→ Workerがclaim
→ local fileを読む
→ Boxへupload
→ size/SHA-1検証
→ UIに結果表示
```

このphaseではAI、Snowflake、複数file、resumeを入れない。

Exit criteria:

- UI refreshに関係なくWorkerが処理を完了する
- Box file IDとverification resultがSQLiteに残る
- UIがterminal logではなくSQLiteから結果を表示する

## Phase 2: Proxy path

- 共通ProxyProfile
- Squid Basic proxy
- Box CCG、API、uploadをproxy経由にする
- Proxy connectivity check
- Proxy停止時にdirect fallbackしない
- Squid access logで経路を確認する

Exit criteria:

- Proxy稼働時のみupload成功
- Proxy停止時は分類されたerrorで停止
- TLS verificationを無効にしていない

## Phase 3: Multi-file state and recovery

- Recursive scan
- Migration manifest
- Stable migrationItemId
- Worker lease
- Pause/resume
- Retry policy
- Direct Upload unknown-outcome reconciliation
- 同名conflict handling

Exit criteria:

- Process強制終了後にduplicateなしでresume
- Completed itemを再送しない
- Conflictを無断上書きしない

## Phase 4: Chunked Upload

- 50MB超file
- Session/expiry persistence
- Part persistence
- 3〜5 part parallel queue
- List parts reconciliation
- Commit unknown-outcome handling
- Global concurrency budget

Exit criteria:

- Part途中停止後に復旧
- Session expiry時にduplicateなしで再開
- File並列とpart並列が設定上限を超えない

## Phase 5: Metadata

- `ShuttleLiteMigration` template contract
- Provenance metadata
- Metadata upsert/idempotency
- Metadata-only retry
- Final routing metadata

Exit criteria:

- Metadata failure時にfile bodyを再uploadしない
- Required metadata不足をCOMPLETEDにしない

Box上のtemplate/folder作成は、利用するenterpriseとdestinationを確認してから行う。

## Phase 6: Box AI and manual fallback

- Structured Extract schema
- AI readiness retry
- Destination enum
- Extracted result persistence
- AI disabled/unsupported/failure path
- Manual metadata/destination input

Exit criteria:

- AI成功時にsuggestionとreasonを表示
- AI失敗時もmanualにreviewへ進める
- Unknown destinationをmoveしない

## Phase 7: Approval and placement

- Review UI
- Approval snapshot
- Stale approval check
- Box Move API
- Original name restoration
- Final verification

Exit criteria:

- Approval前にmoveしない
- Approval対象が変わった場合は再承認
- Final parent、size、SHA-1、metadataを検証

## Phase 8: Progress UX

- SSE
- Phase counters
- Byte progress
- Throughput
- Upload ETA
- Review backlog
- Error categories
- Failed phase retry

Exit criteria:

- Page reload後も正しいstateを復元
- Upload、AI、Snowflakeのbacklogを混同しない

## Phase 9: Snowflake outbox

- Transactional Outbox
- Payload allowlist
- Batch sender
- Stable event ID
- Retry/backoff
- Snowflake idempotent load/merge

Exit criteria:

- Snowflake停止中もmigration継続
- 復旧後に送信
- 同一eventを二重計上しない

## Phase 10: Report and demo hardening

- CSV/JSON report
- Box report upload
- Synthetic 30-file dataset
- Failure injection
- Demo reset script
- Verification evidence
- 10-minute demo script

Live demo候補:

1. Proxy connectivity
2. Multi-file transfer progress
3. AI suggestionとhuman correction
4. Final Box content/metadata
5. Snowflake summary

Crash recovery、Chunked resume、429、Snowflake outageは、すべてをliveで行わず、
事前検証結果を使う選択肢を持つ。

## Stretch: AI Agent Orchestrator

基本版、重要failure test、発表練習が完了した場合だけ着手する。

- Observe
- Plan
- Request approval
- Invoke deterministic tools
- Verify
- Re-plan or escalate

Agentに自由なshell、arbitrary Box operation、approval bypassを与えない。
