# Web application

localhost専用のNext.js UI。Route Handlerは設定・移行の作成、Boxのフォルダー・テンプレート参照、
commandの受付と読み取りを行う。長時間の転送・AI処理・配置はworkerが実行する。

- `/` — 移行一覧、表示中のジョブの概要、新しい移行の作成
- `/settings` — 認証方式の表示、使用するメタデータテンプレートの複数選択、AI分類・並列数・ログ出力先の編集
- `/jobs/[jobId]` — SSEによる進捗（phase、bytes、throughput、ETA、retry、
  error category、review backlog、Snowflake delivery backlog）
- `/jobs/[jobId]/review` — 配置先別の一覧、テンプレートと抽出状況、プレビュー、個別・一括承認。抽出値は詳細で編集
- `/api/...` — profile、job、command、snapshot、SSE、review、report

UIはPC専用。1440px前後を基準とし、最小レイアウト幅は1280px。
狭いウィンドウでは横スクロールし、ナビゲーションや詳細パネルを縦積みにしない。
全画面で左ナビゲーションを共有し、分類・承認では一覧と詳細を個別にスクロールする。
承認操作は各パネルの下部に残る。上部のモード表示バーは設けない。
移行元は「新しい移行」でMacのフォルダー選択画面から指定し、Boxの移行先も移行ごとに選ぶ。
承認一覧は100件ごとに表示し、検索は移行全体が対象。下書きは同じブラウザーで7日間保持する。
