# Windows運用

更新日: 2026-09-14

> 2026-09-15: 実機検証は発表後に回した（[D-016](decisions.md)）。9/30の発表は
> macOS上で実演する。この文書の実装内容は有効だが、**Windows実機での動作は
> 未検証**である。下のchecklistはPoCの次段階で実施する。

## なぜWindowsを想定するか

Box Shuttleでfile serverを移行する場合、実行主体は
[Box Shuttle Windows Agent](https://docs.box.com/en/box-shuttle/configuring-source-systems/box-shuttle-windows-agent)
であり、対応OSは Windows 8 / 10 / 11 と Windows Server 2012 R2 / 2016 / 2019 / 2022
と公開されている（Windows Core は非対応）。

Shuttle Liteが想定する「明示的proxy経由でしか外部へ出られない企業のfile server」
という環境は、実際にはWindows上で動く。macOSだけで動くagentは顧客のIT部門との
会話で配置先がない。したがってcodeはcross-platformのまま維持し、Windows固有の
失敗を実装に織り込む。

Windows専用へ倒す判断は今回しない。専用化して初めて価値が出るのはVSS snapshot、
NTFS ACL読み取り、NTLM/Kerberos proxy認証だが、permission移行とNTLM/Kerberosは
[要件 section 9](requirements.md) で対象外としている。

## 実装済みのWindows対応

| 項目 | 実装 |
|---|---|
| Path区切り | `sourceRelativePath` は `path.sep` を `/` に正規化。UNC rootでも同じ |
| 変更検知 | sizeとmtimeのみで判定。Windowsで信頼できないinodeは記録するだけで比較しない |
| 禁止文字 | Boxの禁止文字 `\ / : * ? " < > \|` はWindowsの禁止文字と同一 |
| 予約名 | `CON` `PRN` `AUX` `NUL` `COM1-9` `LPT1-9` をpreflightでreviewへ送る |
| Office lock file | `~$*` をscanから除外する |
| 共有違反 | `EBUSY` / `EPERM` / `EACCES` を `SOURCE_LOCKED` として分類し、backoff付きで再試行 |
| MAX_PATH | 絶対pathが260文字以上ならpreflightで `PATH_TOO_LONG`。upload途中で落とさない |
| State fileの配置 | `SQLITE_PATH` がUNCまたは同期folder配下なら起動を拒否する |
| Symlink / junction | 追跡せずskipする |

検証は `test/windows.test.ts`。errorコードとpathを注入して判定するため、macOS上でも
実行できる。

## Windows実機 checklist（発表後に実施）

- [ ] Node.js 22以上をinstallし、`npm ci` が通ること（`better-sqlite3` のprebuiltが取得できること）
- [ ] `npm test` と `npm run typecheck` が通ること
- [ ] Source rootにUNC path (`\\fileserver\share\dept`) を指定してscanできること
- [ ] `SQLITE_PATH` を `C:\ProgramData\ShuttleLite\shuttle-lite.db` のようなlocal diskに置くこと
- [ ] mapped drive (`Z:\...`) を `SQLITE_PATH` に指定した場合の挙動を確認すること
      （UNCと違い自動検出できないため、運用手順で禁止する）
- [ ] 260文字を超えるpathを含むtree でpreflightが `PATH_TOO_LONG` を返すこと
- [ ] Excelでfileを開いたままscan・uploadし、`SOURCE_LOCKED` として再試行されること
- [ ] Antivirusのreal-time scanと同時に実行し、throughputとlock errorの頻度を見ること
- [ ] 長時間実行後にWAL fileが肥大化していないこと

### Long path

Windows 10 1607以降は、group policyまたはregistryで長いpathを有効化できる。

```
HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1
```

有効化しない場合はpreflightで `PATH_TOO_LONG` としてreviewへ送られる。無断でrename
したり切り詰めたりはしない。

## Serviceとしての常駐

Shuttle Agentと同じく、workerはWindows Serviceとして常駐させるのが運用上自然である。
`nssm` を使う例を示す。

```
nssm install ShuttleLiteWorker "C:\Program Files\nodejs\node.exe" ^
  "--import" "tsx" "C:\shuttle-lite\apps\worker\src\main.ts"
nssm set ShuttleLiteWorker AppDirectory C:\shuttle-lite
nssm set ShuttleLiteWorker AppStdout C:\ProgramData\ShuttleLite\worker.log
nssm set ShuttleLiteWorker AppStderr C:\ProgramData\ShuttleLite\worker.log
nssm start ShuttleLiteWorker
```

Serviceのlog on accountには、対象の共有へ読み取り権限があるdomain accountを指定する。
Local Systemでは共有へ到達できない。

Web UIはlocalhost専用のため、常駐させる場合も外部へ公開しない。

## 未検証であること

現時点でWindows実機での実行は行っていない。発表では「Windows向けに設計・実装し、
macOSで開発と自動テストを実施。Windows実機検証は未了」と明示する。上のchecklistを
実施したら、この節を結果に置き換える。
