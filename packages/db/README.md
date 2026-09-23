# Database

SQLiteをoperational stateの正本として扱う層。

- `migrations.ts` — schemaの正本（現行version 10）。SQLはTypeScript内に置き、bundlerから
  file読み込みに依存しない
- `sqlite.ts` — WAL、busy timeout、foreign keys、schema version
- `store.ts` — repositoryとtransaction。state更新、event、telemetry outboxを
  同一transactionで確定する`transitionItem`と、実際に作業のあるjobだけを選ぶ
  `claimJob`（worker lease）

共通設定・移行先の保存、メタデータテンプレートのスキーマと下書き、抽出状況、
承認・操作のリビジョン、分類キャッシュ、workerの稼働時刻を保持する。
新旧メタデータ方式は`job_metadata`の有無で区別し、既存の移行を勝手に新方式へ変えない。
