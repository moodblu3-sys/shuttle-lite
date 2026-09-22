import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

let cachedRoot: string | null = null;

/**
 * The worker, the web app and the scripts all run from different working
 * directories, so every relative path in the configuration is resolved against
 * the repository root rather than `process.cwd()`.
 */
export function findRepoRoot(startDir = process.cwd()): string {
  if (cachedRoot) return cachedRoot;
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { workspaces?: unknown };
        if (pkg.workspaces) {
          cachedRoot = dir;
          return dir;
        }
      } catch {
        // Ignore an unreadable package.json and keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedRoot = resolve(startDir);
  return cachedRoot;
}

export function fromRepoRoot(...parts: string[]): string {
  return join(findRepoRoot(), ...parts);
}

export function resolvePath(path: string): string {
  return isAbsolute(path) ? path : fromRepoRoot(path);
}
