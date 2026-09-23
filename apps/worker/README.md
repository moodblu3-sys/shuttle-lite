# Migration worker

Long-running処理はすべてここで動く。

- `runtime.ts` — job lease、pause/resume、transfer/routing/placementの
  独立したqueue、graceful shutdown
- `pipeline.ts` — state別のstep dispatchと、失敗のretry/review/failへの分類
- `steps/` — hash、preflight、upload（direct/chunked）、transfer verification、
  AIによる配置先・テンプレート選択、move、final verification。provenance metadataの付与は旧ジョブだけ
- `business-metadata.ts` — テンプレートに沿った自動抽出、承認値の検証、承認後のBox付与・照合
- `source/` — `SourceAdapter` portと`LocalSourceAdapter`
- `reconcile.ts` — 起動時にstaging folderを直接listingして不明なuploadを照合する
- `commands.ts` — UIから届いたcommandの実行
- `report.ts` — CSV/JSONの生成とBox `_reports` へのupload

転送・分類・配置は空いた枠へ逐次投入する。ファイル並列数は1〜5、分類と配置は各2、
分割転送は全ファイルで共有する1〜4の枠。設定変更や操作時は実行中のステップの終了を待つ。
承認前のメタデータはSQLiteの下書きで、Boxへの付与は`placeItem`でmove前に行う。
