# Migration worker

Long-running処理はすべてここで動く。

- `runtime.ts` — job lease、pause/resume、transfer/routing/placementの
  独立したqueue、graceful shutdown
- `pipeline.ts` — state別のstep dispatchと、失敗のretry/review/failへの分類
- `steps/` — hash、preflight、upload（direct/chunked）、transfer verification、
  provenance metadata、AI routing、move、final verification
- `source/` — `SourceAdapter` portと`LocalSourceAdapter`
- `reconcile.ts` — 起動時にstaging folderを直接listingして不明なuploadを照合する
- `commands.ts` — UIから届いたcommandの実行
- `report.ts` — CSV/JSONの生成とBox `_reports` へのupload
