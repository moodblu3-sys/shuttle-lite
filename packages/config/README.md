# Configuration

- `env.ts` — Zodによる環境変数の検証とcross-field check。credentialは
  profileへ保存せず環境から読む。SQLite stateをネットワーク共有や同期folderへ
  置く設定を拒否する
- `proxy.ts` — ProxyProfileからundici dispatcherへの変換。`required` modeでは
  direct接続へfallbackしない。TLS検証を無効化する経路は用意しない
- `destinations.ts` — 許可済みdestination catalogの読み込みと検証
- `paths.ts` — repository rootの解決
