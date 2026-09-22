# Telemetry

- `payload.ts` — 送信fieldのallowlist。event messageやlocal pathは含めない
- `sink.ts` — `TelemetrySink`とJSONL実装。再作成時もevent IDで重複排除
- `snowflake.ts` — SQL API・キーペア認証・MERGEによる実送信。実アカウント検証は未実施
- `configured-sink.ts` — 保存設定をバッチごとに読み込み、ログ出力先を切り替える
- `outbox-sender.ts` — transactional outboxの排出。失敗はbackoffして同じevent IDで
  再送するため、migrationは止まらず二重計上も起きない
- `progress.ts` — SSEへ渡すjob snapshotの射影
- `report.ts` — source-to-target mappingのrowとCSV生成
