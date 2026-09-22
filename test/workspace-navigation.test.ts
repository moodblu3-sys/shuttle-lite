import { describe, expect, it } from 'vitest';
import { workspaceNavigation } from '../apps/web/src/lib/workspace-navigation';

describe('desktop workspace navigation', () => {
  it('does not point review or progress at an arbitrary job on the dashboard', () => {
    const links = workspaceNavigation('/');
    expect(links.filter((link) => link.current).map((link) => link.label)).toEqual(['移行一覧']);
    expect(links.find((link) => link.label === '分類・承認')?.href).toBeNull();
    expect(links.find((link) => link.label === '進捗')?.href).toBeNull();
    expect(links.find((link) => link.label === '設定')?.href).toBe('/settings');
  });

  it('keeps progress and approval links scoped to the job currently open', () => {
    for (const jobId of ['job_first', 'job_second']) {
      const links = workspaceNavigation(`/jobs/${jobId}/review`);
      expect(links.filter((link) => link.current).map((link) => link.label)).toEqual([
        '分類・承認',
      ]);
      expect(links.find((link) => link.label === '進捗')?.href).toBe(`/jobs/${jobId}`);
      expect(links.find((link) => link.label === '分類・承認')?.href).toBe(`/jobs/${jobId}/review`);
    }
  });

  it('marks only progress as current on a job page, including a trailing slash', () => {
    for (const pathname of ['/jobs/job_first', '/jobs/job_first/']) {
      expect(
        workspaceNavigation(pathname)
          .filter((link) => link.current)
          .map((link) => link.label),
      ).toEqual(['進捗']);
    }
  });

  it('makes settings reachable without retaining a previous job selection', () => {
    const links = workspaceNavigation('/settings');
    expect(links.filter((link) => link.current).map((link) => link.label)).toEqual(['設定']);
    expect(links.find((link) => link.label === '分類・承認')?.href).toBeNull();
    expect(workspaceNavigation('/jobs/job_first/unrecognized').some((link) => link.current)).toBe(
      false,
    );
  });
});
