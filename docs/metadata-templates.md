# 書類別メタデータの事前設定

対象: 2026-09-23以降の新しい移行。実Box検証は利用者のMacで行う。
既存の移行は従来方式のまま。新方式を試すときは設定保存後に「新しい移行」を作成する。

## Cursorに依頼する準備

Box CLIを使い、接続先のデモ企業に次のテンプレートを作成する。
作成時のscopeは `enterprise`。取得結果の `enterprise_企業ID` とtemplateKeyを控える。
同じキーが既にある場合は定義を比較し、自動で削除・変更しない。
テンプレートは表示可能（hidden=false）にする。既存ファイルやフォルダーへの付与は不要。

| テンプレート | templateKey | 項目名 | field key | Boxの型 |
|---|---|---|---|---|
| 契約書管理 | shuttleLiteContract | 契約先 | counterparty | string |
| 契約書管理 | shuttleLiteContract | 契約種別 | contractType | string |
| 契約書管理 | shuttleLiteContract | 締結日 | signedDate | date |
| 契約書管理 | shuttleLiteContract | 契約終了日 | expirationDate | date |
| 請求書管理 | shuttleLiteInvoice | 請求元 | vendor | string |
| 請求書管理 | shuttleLiteInvoice | 請求番号 | invoiceNumber | string |
| 請求書管理 | shuttleLiteInvoice | 請求日 | invoiceDate | date |
| 請求書管理 | shuttleLiteInvoice | 金額 | amount | float |
| 請求書管理 | shuttleLiteInvoice | 通貨 | currency | string |
| 請求書管理 | shuttleLiteInvoice | 支払期限 | dueDate | date |

Cursorではインストール済みのBox CLIのhelpを確認して作成コマンドを組み立てる。
上の名称・キーはデモ用の推奨定義。アプリは他の既存テンプレートも選択でき、実際の項目を取得する。
CLIの利用者とShuttle Liteの認証主体が異なる場合、アプリ側の認証でもテンプレートを取得できることを確認する。
トークン・秘密鍵の値を報告やGitHubに含めない。

公式仕様:
- [テンプレート作成](https://developer.box.com/reference/post-metadata-templates-schema/)
- [企業テンプレート一覧](https://developer.box.com/reference/get-metadata-templates-enterprise/)
- [テンプレート指定のAI抽出](https://developer.box.com/guides/box-ai/ai-tutorials/extract-metadata-structured)

## アプリ側の操作

1. 更新後、アプリを再起動する。SQLiteのschema 8への更新は自動。
2. 「設定」→「メタデータ」で、契約書に「契約書管理」、請求書に「請求書管理」を選び保存する。
3. AI分類を有効にして「新しい移行」を作成する。
4. 承認画面でテンプレートと抽出値を確認する。必要に応じて値を修正し、配置先とともに承認する。
5. Boxでファイルを開き、承認したテンプレートと値を確認する。

文書種別が不明なファイルはテンプレート「未選択」になる。人がテンプレートを選択した後、
「AIで抽出」を押すか手入力する。テンプレート未選択のまま承認すると業務メタデータは付けない。
AI分類をオフにした移行では、テンプレートと値の手動指定を利用する。
取得できない値や無効な抽出値は空欄とし、推測による既定値は入れない。

## 動作の範囲

- 対応フィールド: string、float、date、enum。複数選択・階層・表などの項目があるテンプレートは候補に出さない。
- 設定は新規移行に反映する。進行中の移行は開始時の定義を使い、後から設定を変更しても切り替わらない。
- Box側で項目を変更した場合は、設定を保存し直し、新しい移行を作成する。
- 新方式では移行管理用の共通テンプレートを付けない。既存ファイルの旧テンプレートは自動削除しない。
- 移行ファイルのID、サイズ、SHA-1、配置先、承認したメタデータの値を最終確認する。
- 書き込み失敗後の再承認でテンプレートを変更したときは、その移行が書いた旧テンプレートだけを除去する。
- 他の処理が先に同じテンプレートを付けた場合は、上書きせず確認待ちにする。
- fake Boxでは合成の契約書・請求書テンプレートを使用できる。実Boxでの自動作成はしない。

## Macでの確認項目

- 契約書と請求書を各1件移行し、別々のテンプレート・項目が表示されること。
- 金額の修正、日付の空欄化がそのままBoxへ反映されること。
- 未選択のファイルは、テンプレート選択・手入力でも完了できること。
- AI分類オフでAI抽出が呼ばれず、手入力で完了できること。
- 承認前に業務メタデータが付かず、新規移行には内部IDなどの共通テンプレートが付かないこと。
