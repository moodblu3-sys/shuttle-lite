# Box adapter

`BoxGateway` portと2つの実装。

- `gateway.ts` — port定義（auth、folder、preflight、direct/chunked upload、
  metadata、AI extract、move、template）
- `http/` — undiciによる実装。ProxyAgent、CCG token cache、`Retry-After`、
  request ID付きerror分類。実enterpriseでは未検証
- `fake/` — local disk上のfake Box。SHA-1、同名409、chunked session、
  429、representation pending、AI extractを再現する
- `layout.ts` — `/Shuttle Lite` 配下のfolder layout解決
- `template.ts` — `shuttleLiteMigration` metadata templateの定義
