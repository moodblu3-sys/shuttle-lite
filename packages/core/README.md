# Core

Vendorとframeworkに依存しないdomain層。

- `state.ts` — item stateの遷移表、side stateからの復帰、progress phaseへの射影
- `errors.ts` — 失敗のcategory、retryable判定、operatorへの推奨対応
- `retry.ts` — `Retry-After`を最優先するbackoff
- `naming.ts` — Box/Windowsのfile名検証、deterministicなstaging名、state file配置の判定
- `hash.ts` — streamingのSHA-1（file全体をmemoryに載せない）
- `ids.ts` — job内で安定するmigration item ID、重複排除に使うevent ID
- `progress.ts` — throughput、ETA、phase counter
- `semaphore.ts` — file並列とpart並列を束ねるglobal budget
