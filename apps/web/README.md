# Web application

localhost専用のNext.js UI。Route Handlerはcommandのinsertと読み取りだけを行い、
long-running処理を持たない。

- `/` — profileとjobの作成、destination catalogの表示
- `/jobs/[jobId]` — SSEによる進捗（phase、bytes、throughput、ETA、retry、
  error category、review backlog、Snowflake delivery backlog）
- `/jobs/[jobId]/review` — 抽出結果、提案、confidence、承認とmanual入力
- `/api/...` — profile、job、command、snapshot、SSE、review、report
