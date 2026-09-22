# Telemetry

- `payload.ts` — 送信fieldのallowlist。event messageやlocal pathは含めない
- `sink.ts` — `TelemetrySink`。JSONL実装と、未接続を明示するSnowflake placeholder
- `outbox-sender.ts` — transactional outboxの排出。失敗はbackoffして同じevent IDで
  再送するため、migrationは止まらず二重計上も起きない
- `progress.ts` — SSEへ渡すjob snapshotの射影
- `report.ts` — source-to-target mappingのrowとCSV生成
