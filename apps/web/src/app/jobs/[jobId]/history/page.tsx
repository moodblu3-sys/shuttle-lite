import { requirePageUser } from '../../../../lib/auth';
import { notFound } from 'next/navigation';
import { migrationRuns } from '@shuttle-lite/db';
import { StatePill } from '../../../../components/state-pill';
import { getStore } from '../../../../lib/runtime';

export const dynamic = 'force-dynamic';

export default async function HistoryPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  await requirePageUser(jobId);
  const store = getStore();
  const job = store.getJob(jobId);
  if (!job) notFound();
  const runs = migrationRuns(store, jobId);
  return (
    <div className="page-content">
      <p className="breadcrumb">
        <a href="/">移行一覧</a> / 実行履歴
      </p>
      <h1 className="page-title">{job.name}</h1>
      <section className="card">
        <h2>実行履歴</h2>
        <table>
          <thead>
            <tr>
              <th>実行</th>
              <th>作成日時</th>
              <th>状態</th>
              <th>ファイル</th>
              <th>レポート</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run, i) => (
              <tr key={run.id}>
                <td>
                  <a href={`/jobs/${run.id}`}>{i === 0 ? '初回移行' : `差分 ${i}回目`}</a>
                </td>
                <td>
                  <time dateTime={run.createdAt}>
                    {new Date(run.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
                  </time>
                </td>
                <td>
                  <StatePill state={run.state} />
                </td>
                <td>{run.totalItems}件</td>
                <td>
                  <a href={`/api/jobs/${run.id}/report?format=csv`}>CSV</a>{' '}
                  <a href={`/api/jobs/${run.id}/report?format=json`}>JSON</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
