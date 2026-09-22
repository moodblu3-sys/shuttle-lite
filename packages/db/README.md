# Database

SQLiteをoperational stateの正本として扱う層。

- `migrations.ts` — schema（10 tables）。SQLはTypeScript内に置き、bundlerから
  file読み込みに依存しない
- `sqlite.ts` — WAL、busy timeout、foreign keys、schema version
- `store.ts` — repositoryとtransaction。state更新、event、telemetry outboxを
  同一transactionで確定する`transitionItem`と、実際に作業のあるjobだけを選ぶ
  `claimJob`（worker lease）
