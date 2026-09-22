# Web application

localhost専用のNext.js UI。Route Handlerはcommandのinsertと読み取りだけを行い、
long-running処理を持たない。

- `/` — 移行一覧、表示中のジョブの概要、新しい移行の作成
- `/settings` — 移行元の登録、配置先一覧、実行環境の確認
- `/jobs/[jobId]` — SSEによる進捗（phase、bytes、throughput、ETA、retry、
  error category、review backlog、Snowflake delivery backlog）
- `/jobs/[jobId]/review` — 配置先別の一覧、右側の詳細、個別・一括承認
- `/api/...` — profile、job、command、snapshot、SSE、review、report

UIはPC専用。1440px前後を基準とし、最小レイアウト幅は1280px。
狭いウィンドウでは横スクロールし、ナビゲーションや詳細パネルを縦積みにしない。
全画面で左ナビゲーションを共有し、分類・承認では一覧と詳細を個別にスクロールする。
承認操作は各パネルの下部に残る。デモ／実Boxモードはヘッダーに表示し、
プロキシ・ログ・AIの設定は設定画面で確認する。
