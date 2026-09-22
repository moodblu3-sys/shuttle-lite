/**
 * 非透過型proxy (Squid) の検証環境を、macOS上で直接動かす。
 *
 *   npm run squid:start    .env のproxy設定からSquidの設定を生成して起動する
 *   npm run squid:log      access logを表示する（経路の証明に使う）
 *   npm run squid:stop     停止する
 *
 * Dockerが無い環境向け。`brew install squid` で入るSquidを使う。
 *
 * 認証情報の出所は .env だけにする。このscriptは新しいpasswordを作らず、
 * PROXY_USERNAME / PROXY_PASSWORD からhtpasswdのhashを作るだけにする。
 * 平文のpasswordを別fileへ書き出さない。
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fromRepoRoot, loadConfig, type ProxyProfile } from '@shuttle-lite/config';

const execFileAsync = promisify(execFile);

const PREFIX = '/opt/homebrew/opt/squid';
const SQUID = join(PREFIX, 'sbin', 'squid');
const RUNTIME = fromRepoRoot('.shuttle-lite/squid');
const CONF = join(RUNTIME, 'squid.conf');
const PASSWD = join(RUNTIME, 'passwd');
const TEMPLATE = fromRepoRoot('infra/squid/squid.local.conf.template');
const PORT = 3128;

function requireSquid(): void {
  if (!existsSync(SQUID)) {
    process.stderr.write(
      `Squidが見つかりません: ${SQUID}\n  brew install squid を実行してください。\n`,
    );
    process.exit(1);
  }
}

/** .env のproxy設定からSquid側の設定を決める。両者の食い違いを防ぐ。 */
function resolveProxy(): ProxyProfile {
  const { proxy } = loadConfig();
  const port = proxy.url ? new URL(proxy.url).port || '80' : '';
  if (proxy.url && port !== String(PORT)) {
    process.stderr.write(
      `PROXY_URL のportが ${port} ですが、このscriptは ${PORT} で起動します。\n` +
        `  .env を PROXY_URL=http://127.0.0.1:${PORT} にしてください。\n`,
    );
    process.exit(1);
  }
  if (proxy.authMode === 'basic' && (!proxy.username || !proxy.password)) {
    process.stderr.write(
      'PROXY_AUTH_MODE=basic ですが PROXY_USERNAME / PROXY_PASSWORD が未設定です。\n',
    );
    process.exit(1);
  }
  return proxy;
}

/**
 * 認証部分の設定。basic_ncsa_auth はmacOSの crypt(3) を使うため、hashは
 * apr1 MD5 (htpasswd -m) にする。bcrypt は解釈されず常に407になる。
 */
async function buildAuthConfig(proxy: ProxyProfile): Promise<string> {
  if (proxy.authMode !== 'basic') {
    return ['# PROXY_AUTH_MODE=none。認証なしで待ち受ける', 'acl client_ok src 127.0.0.1'].join(
      '\n',
    );
  }
  await execFileAsync('/usr/sbin/htpasswd', [
    '-cbm',
    PASSWD,
    proxy.username as string,
    proxy.password as string,
  ]);
  return [
    `auth_param basic program ${PREFIX}/libexec/basic_ncsa_auth ${PASSWD}`,
    'auth_param basic realm Shuttle Lite proxy',
    'auth_param basic children 5',
    'auth_param basic credentialsttl 1 hour',
    '',
    'acl client_ok proxy_auth REQUIRED',
  ].join('\n');
}

async function start(): Promise<void> {
  requireSquid();
  const proxy = resolveProxy();
  mkdirSync(RUNTIME, { recursive: true });

  const conf = readFileSync(TEMPLATE, 'utf8')
    .replaceAll('__AUTH__', await buildAuthConfig(proxy))
    .replaceAll('__RUNTIME__', RUNTIME)
    .replaceAll('__PORT__', String(PORT));
  writeFileSync(CONF, conf);

  // 設定の誤りは起動前に止める。Squidの診断だけを見せ、node stackは出さない。
  try {
    await execFileAsync(SQUID, ['-f', CONF, '-k', 'parse']);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    const diagnostics = stderr
      .split('\n')
      .filter((line) => /ERROR|FATAL|WARNING/.test(line))
      .join('\n');
    process.stderr.write(`Squidの設定を読み込めません。\n${diagnostics}\n`);
    process.exit(1);
  }
  const child = spawn(SQUID, ['-f', CONF, '-N'], { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const up = await execFileAsync('/usr/bin/nc', ['-z', '127.0.0.1', String(PORT)]).then(
      () => true,
      () => false,
    );
    if (up) {
      process.stdout.write(
        [
          `Squidを起動しました (127.0.0.1:${PORT}, 認証: ${proxy.authMode})`,
          `  設定      ${CONF}`,
          `  access log ${RUNTIME}/access.log`,
          '',
          '確認: npm run check:proxy',
          '',
        ].join('\n'),
      );
      return;
    }
  }
  process.stderr.write(`起動を確認できませんでした。${RUNTIME}/cache.log を確認してください。\n`);
  process.exitCode = 1;
}

async function stop(): Promise<void> {
  requireSquid();
  if (!existsSync(CONF)) {
    process.stdout.write('起動していません。\n');
    return;
  }
  await execFileAsync(SQUID, ['-f', CONF, '-k', 'shutdown']).catch(() => undefined);
  process.stdout.write('Squidへ停止を要求しました。\n');
}

function log(): void {
  const path = join(RUNTIME, 'access.log');
  if (!existsSync(path)) {
    process.stdout.write('access logがまだありません。\n');
    return;
  }
  process.stdout.write(readFileSync(path, 'utf8'));
}

const command = process.argv[2] ?? 'start';
if (command === 'start') await start();
else if (command === 'stop') await stop();
else if (command === 'log') log();
else {
  process.stderr.write('使い方: squid.ts [start|stop|log]\n');
  process.exitCode = 1;
}
