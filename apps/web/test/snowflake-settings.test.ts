// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SettingsForm } from '../src/components/settings-form';
import type { RuntimeSettings } from '@shuttle-lite/config/settings-schema';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

it('tests saved Snowflake settings and invalidates success when the configuration changes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ eventId: 'connection-test-123' }));
  vi.stubGlobal('fetch', fetchMock);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const initial: RuntimeSettings = {
    aiEnabled: true,
    fileConcurrency: 2,
    chunkConcurrency: 2,
    logSink: 'snowflake',
    logFolder: '/tmp/logs',
    snowflake: {
      account: 'org-account',
      username: 'LOGGER',
      warehouse: 'WH',
      database: 'DB',
      schema: 'PUBLIC',
      table: 'EVENTS',
      role: '',
    },
  };
  try {
    await act(async () =>
      root.render(
        createElement(SettingsForm, {
          initial,
          revision: 7,
          folderPickerAvailable: true,
          snowflakeKeyConfigured: true,
        }),
      ),
    );
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'テストログを送信',
    )!;
    await act(async () => button.click());
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ revision: 7 });
    expect(container.textContent).toContain('テストログを送信しました');
    const input = container.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    await act(async () => input.click());
    expect(button.disabled).toBe(true);
    expect(container.textContent).not.toContain('テストログを送信しました');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
