import type { ReviewCommandView } from './review-types';

/** Only retry a known, rolled-back database rejection, never an unknown receipt. */
export async function submitReviewCommand(
  jobId: string,
  command: unknown,
): Promise<ReviewCommandView> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`/api/jobs/${jobId}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    });
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      code?: string;
      command?: ReviewCommandView;
    } | null;
    if (response.status === 503 && body?.code === 'DATABASE_BUSY' && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      continue;
    }
    if (!response.ok || !body?.command?.id) {
      throw new Error(
        body?.error ??
          '操作の受付結果を確認できませんでした。画面を更新し、承認待ちのファイルを確認してください。',
      );
    }
    return body.command;
  }
}
