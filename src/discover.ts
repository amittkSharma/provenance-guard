import { readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { LOCKFILES } from './lockfile.ts';

const isLockfile = (name: string) => (LOCKFILES as readonly string[]).includes(name);

interface Discovery {
  /** Lockfiles relative to `cwd`: root lockfiles first, then by path. */
  lockfiles: string[];
  /** Folders that could not be read; lockfiles inside them were not found. */
  unreadable: string[];
}

/**
 * Every lockfile under `cwd`, found by walking the file system. Only `node_modules`, `.git` and `exclude` paths are
 * skipped — git-ignored folders, dot folders (e.g. `.github/actions`) and nested repos are searched, so nothing
 * disappears silently. Use `exclude` for folders that should not be checked.
 */
export function discoverLockfiles(cwd: string, exclude: string[] = []): Discovery {
  const excluded = exclude.map((e) => posix.normalize(e.replace(/\\/g, '/')).replace(/\/+$/, ''));
  const isExcluded = (path: string) => excluded.some((e) => path === e || path.startsWith(`${e}/`));
  const lockfiles: string[] = [];
  const unreadable: string[] = [];
  const walk = (dir: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(join(cwd, dir), { withFileTypes: true });
    } catch {
      unreadable.push(dir || '.');
      return;
    }
    for (const entry of entries) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (isExcluded(path)) continue;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') walk(path);
      } else if (isLockfile(entry.name)) {
        lockfiles.push(path);
      }
    }
  };
  walk('');
  lockfiles.sort((a, b) => Number(a.includes('/')) - Number(b.includes('/')) || a.localeCompare(b));
  return { lockfiles, unreadable: unreadable.sort() };
}
