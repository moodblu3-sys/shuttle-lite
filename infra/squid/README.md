# Squid test environment

非透過型proxyを経由してBox移行が成立すること、そして `PROXY_MODE=required` の
ときにdirect接続へfallbackしないことを実証するための環境。

**実施済み**。Squid 7.7 経由で実Box enterpriseへ 32 件 / 51 MB を移行し、
検証項目 18 / 18 が成功した。証跡と数値は
[docs/acceptance.md](../../docs/acceptance.md) にある。

## 起動

Dockerがある環境と、無い環境の2通りを用意している。どちらも待ち受けは
`127.0.0.1:3128`、宛先allowlistとBasic認証の条件は同じである。

### Dockerがない場合（macOS、実施した経路）

```sh
brew install squid
npm run squid:start     # .env のproxy設定から squid.conf を生成して起動
npm run squid:log       # access log（経路の証明に使う）
npm run squid:stop
```

`npm run squid:start` は `.env` の `PROXY_USERNAME` / `PROXY_PASSWORD` から
htpasswdを作る。password を別fileへ複製しないため、認証情報の出所は `.env`
だけになる。生成物は `.shuttle-lite/squid/`（gitignore対象）に置く。

hashは apr1 MD5 (`htpasswd -m`) を使う。bcrypt (`-B`) はmacOSの `crypt(3)` が
解釈できず、`basic_ncsa_auth` が常に認証失敗して407を返す。

### Dockerがある場合

```sh
cd infra/squid
htpasswd -c -m passwd shuttle           # passwordは対話入力。commitしない
docker compose up -d
docker compose logs -f squid
```

## Shuttle Lite側の設定

```sh
PROXY_MODE=required
PROXY_URL=http://127.0.0.1:3128
PROXY_AUTH_MODE=basic
PROXY_USERNAME=shuttle
PROXY_PASSWORD=...            # .env のみ。profileにもlogにも残らない
NO_PROXY=localhost,127.0.0.1
```

`PROXY_MODE=required` では、proxyが使えないときにdirect接続へfallbackせず
`PROXY_REQUIRED` または `PROXY_CONNECT` として停止する。

## 確認手順

```sh
npm run check:proxy          # 経路と分類の確認
npm run verify -- --real     # 実Boxへの移行をproxy経由で通す
npm run squid:log            # 経路の証跡
```

1. **経路の証明**: access logのCONNECT行だけでBox通信のすべてが説明できること。
   Squidのlogに出ないBox通信があれば、それはdirect接続である。
   CONNECT tunnelは1本で複数requestを多重化するので、行数はrequest数ではなく
   tunnel数になる。上り/下りのbyteは `up=` / `down=` に出る。
2. **allowlistの証明**: 許可していない宛先が `TCP_DENIED/403` になること。
3. **停止時の挙動**: proxyを止めてからmigrationを実行し、`PROXY_CONNECT` として
   分類されたerrorで止まること。direct接続で成功しないこと。
4. **認証失敗**: `PROXY_PASSWORD` を誤った値にして `PROXY_AUTH` (407) になること。
5. **TLS**: custom CAを使う場合は `PROXY_CA_BUNDLE_PATH` を設定する。
   TLS検証を無効化する設定は用意していない。

## 対象外

NTLM、Kerberos、PACは[要件 section 9](../../docs/requirements.md)のとおり対象外。
この設定は認証なしとBasicのみを扱う。
