# Routing

- `extraction.ts` — AI出力のschema検証と正規化。catalogにないdestination keyは
  記録するが採用しない。confidenceは提供された場合だけ保持する
- `approval.ts` — 承認入力の検証と、move直前のstale判定
- `metadata.ts` — 旧共通メタデータ方式のprovenanceとrouting metadata生成、必須fieldの充足確認。
  絶対pathをmetadataへ入れない

新方式のテンプレート選択・抽出・付与は`apps/worker/src/business-metadata.ts`、
項目の型検証は`packages/core/src/business-metadata.ts`が担当する。
