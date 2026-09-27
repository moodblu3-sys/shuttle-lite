import type { ErrorCategory } from '@shuttle-lite/core';

interface ErrorPresentation {
  title: string;
  action: string;
}

// 表示専用。再試行・停止の判断はワーカーのエラー分類を変更しない。
const ERRORS: Record<ErrorCategory, ErrorPresentation> = {
  SOURCE_READ: {
    title: '移行元のファイルを読み取れません',
    action: '読み取り権限とディスクの状態を確認してください。',
  },
  SOURCE_CHANGED: {
    title: '移行元のファイルが変更されています',
    action: '移行元を再スキャンしてから再実行してください。',
  },
  SOURCE_MISSING: {
    title: '移行元のファイルが見つかりません',
    action: 'ファイルが移動・削除されていないか確認してください。',
  },
  SOURCE_LOCKED: {
    title: 'ファイルが使用中です',
    action: 'ファイルを使用しているアプリを閉じてください。',
  },
  PATH_TOO_LONG: {
    title: '移行元のパスが長すぎます',
    action: 'フォルダー構成や名前を短くして、移行元を再スキャンしてください。',
  },
  PROXY_CONNECT: {
    title: 'プロキシに接続できません',
    action: 'プロキシの起動状態・接続先・通信許可を確認してください。',
  },
  PROXY_AUTH: {
    title: 'プロキシの認証に失敗しました',
    action: 'プロキシの認証設定を確認し、変更後にアプリを再起動してください。',
  },
  PROXY_TLS: {
    title: '通信先の証明書を確認できません',
    action: 'プロキシの証明書設定を確認し、変更後にアプリを再起動してください。',
  },
  PROXY_REQUIRED: {
    title: '必須のプロキシを利用できません',
    action: 'プロキシの接続設定を確認してください。',
  },
  BOX_AUTH: {
    title: 'Boxの認証に失敗しました',
    action: 'Boxの認証設定を確認し、変更後にアプリを再起動してください。',
  },
  BOX_PERMISSION: {
    title: 'Boxへのアクセス権限がありません',
    action: '認証ユーザーのアクセス権限とアプリの権限を確認してください。',
  },
  BOX_NOT_FOUND: {
    title: 'Boxのファイルまたはフォルダーが見つかりません',
    action: '対象が削除されていないか、アクセスできるか確認してください。',
  },
  BOX_CONFLICT: {
    title: '同名のファイルまたはフォルダーがあります',
    action: '対象を確認し、名前の変更または除外を選んでください。',
  },
  BOX_RATE_LIMIT: {
    title: 'Boxへのアクセスが一時的に制限されています',
    action: '時間をおいて再実行してください。',
  },
  BOX_SERVER: {
    title: 'Boxで一時的なエラーが発生しました',
    action: '時間をおいて再実行してください。',
  },
  BOX_BAD_REQUEST: {
    title: 'Boxが処理を受け付けませんでした',
    action: '技術情報を確認し、要求内容を調査してください。',
  },
  BOX_PRECONDITION: {
    title: 'Box側の処理条件が一致しません',
    action: 'Box上の対象の状態を確認してください。',
  },
  BOX_TIMEOUT: {
    title: 'Boxからの応答を確認できませんでした',
    action: '進捗で処理結果を確認してください。',
  },
  UPLOAD_SESSION_EXPIRED: {
    title: '分割転送の有効期限が切れました',
    action: '進捗から再実行してください。',
  },
  UPLOAD_PART_MISMATCH: {
    title: '分割転送の情報が一致しません',
    action: '進捗と技術情報を確認してください。',
  },
  INTEGRITY_MISMATCH: {
    title: '転送結果が元ファイルと一致しません',
    action: '元ファイルとBox上のファイルを確認してください。',
  },
  NAME_INVALID: {
    title: 'Boxで使用できないファイル名です',
    action: 'ファイル名を確認してください。',
  },
  SIZE_LIMIT: {
    title: 'ファイルがアップロード上限を超えています',
    action: 'ファイルの容量とBoxのアップロード上限を確認してください。',
  },
  METADATA_SCHEMA: {
    title: 'メタデータの定義または値が一致しません',
    action: 'テンプレートの項目と入力値を確認してください。',
  },
  METADATA_CONFLICT: {
    title: '既存のメタデータと競合しています',
    action: 'Box上のメタデータと承認内容を確認してください。',
  },
  AI_DISABLED: {
    title: 'AI分類が無効です',
    action: '配置先と必要なメタデータを指定してください。',
  },
  AI_UNSUPPORTED: {
    title: 'Box AIで処理できないファイルです',
    action: '配置先と必要なメタデータを指定してください。',
  },
  AI_NOT_READY: {
    title: 'Box AIが処理を受け付けられませんでした',
    action: '時間をおいて再実行してください。',
  },
  AI_INVALID_OUTPUT: {
    title: 'AIの結果を読み取れませんでした',
    action: '配置先とメタデータを確認・修正してください。',
  },
  AI_FAILURE: {
    title: 'AI処理に失敗しました',
    action: '配置先とメタデータを確認・修正してください。',
  },
  DESTINATION_UNKNOWN: {
    title: '配置先を確認できません',
    action: '候補から配置先を選び直してください。',
  },
  APPROVAL_STALE: {
    title: '承認後に対象が変更されています',
    action: '最新の内容を確認し、もう一度承認してください。',
  },
  APPROVAL_INVALID: {
    title: '承認内容を確認できません',
    action: '配置先・ファイル名・メタデータの入力値を確認してください。',
  },
  MOVE_CONFLICT: {
    title: '配置先に同名ファイルがあります',
    action: 'ファイル名か配置先を変更するか、対象を除外してください。',
  },
  TELEMETRY_DELIVERY: {
    title: '処理ログを保存できません',
    action: 'ログ出力先の接続と書き込み権限を確認してください。',
  },
  STATE_INVALID: {
    title: '処理状態に不整合があります',
    action: '技術情報と処理ログを確認してください。',
  },
  CONFIG_INVALID: {
    title: '設定を確認できません',
    action: '設定内容と技術情報を確認してください。',
  },
  UNKNOWN: {
    title: '処理を完了できませんでした',
    action: '処理結果と技術情報を確認してください。',
  },
};

export function errorPresentation(category?: string | null, state?: string): ErrorPresentation {
  const known = category && Object.hasOwn(ERRORS, category);
  const presentation = known ? ERRORS[category as ErrorCategory] : ERRORS.UNKNOWN;
  // 再試行が終了しているファイルには、自動復旧中と表示しない。
  if (state === 'RETRY_WAIT')
    return { ...presentation, action: '時間をおいて自動で再試行します。' };
  if (state === 'UNKNOWN_OUTCOME')
    return { ...presentation, action: 'Box上の処理結果を照合します。' };
  return presentation;
}
