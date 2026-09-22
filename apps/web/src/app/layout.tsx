import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getConfig } from '../lib/runtime';
import './globals.css';

export const metadata: Metadata = {
  title: 'Shuttle Lite',
  description: 'Box Platformベースの軽量migration path PoC',
};

function Badge({ label, value, demo }: { label: string; value: string; demo: boolean }) {
  return (
    <span className={`badge${demo ? ' badge-demo' : ''}`}>
      {label} <strong>{value}</strong>
    </span>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const config = getConfig();
  return (
    <html lang="ja">
      <body>
        <div className="shell">
          <header className="topbar">
            <a className="brand" href="/">
              Shuttle Lite
            </a>
            <span className="tagline">Shuttleが届きにくい場所へ、軽やかに。</span>
            {/* These decide whether what you see is real. A demo-only setting
                has to be obvious, not a grey chip that reads as decoration. */}
            <div className="badges">
              <Badge label="Box" value={config.box.mode} demo={config.box.mode !== 'real'} />
              <Badge
                label="Proxy"
                value={config.proxy.mode}
                demo={config.proxy.mode !== 'required'}
              />
              <Badge
                label="Telemetry"
                value={config.telemetry.sink}
                demo={config.telemetry.sink !== 'snowflake'}
              />
              <Badge
                label="AI"
                value={config.ai.enabled ? 'enabled' : 'disabled'}
                demo={!config.ai.enabled}
              />
            </div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
