# Synthetic source fixtures

`npm run fixtures` で生成する。中身はすべて架空で、実在の企業・人物・契約とは
関係がない。顧客content、credential、access token、機密情報は置かない。

生成物はgitignoreしている。内訳は契約、請求書、従業員記録、運用手順書、提案書、
分類が曖昧なもの、同名file、同一内容の別item、Box AI対象外のbinary、
chunked upload検証用の52MB fileである。

実Boxで検証する際は、Box AIがtextを抽出できるようPDFやDOCXへ差し替える
（[docs/integration-todo.md](../../docs/integration-todo.md)）。
