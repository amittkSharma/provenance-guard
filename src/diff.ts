import { execFileSync } from 'node:child_process';
import type { Change, Packages } from './types.ts';

/** Semver order: numeric major.minor.patch, and a prerelease sorts before its release. Build metadata is ignored. */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = a.split('+')[0].split(/-(.*)/s);
  const [coreB, preB] = b.split('+')[0].split(/-(.*)/s);
  const numsA = coreA.split('.').map(Number);
  const numsB = coreB.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (numsA[i] !== numsB[i]) return numsA[i] - numsB[i];
  }
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA.localeCompare(preB, 'en', { numeric: true });
}

/** Versions in `head` that are not in `base`. `from` is the highest base version of the same package. */
export function diffPackages(base: Packages, head: Packages): Change[] {
  const changes: Change[] = [];
  for (const [name, versions] of head) {
    const before = base.get(name);
    const from = before ? [...before].sort(compareVersions).at(-1) : undefined;
    for (const to of versions) {
      if (before?.has(to)) continue;
      changes.push(from ? { name, from, to } : { name, to });
    }
  }
  return changes.sort((a, b) => a.name.localeCompare(b.name) || compareVersions(a.to, b.to));
}

/** File content at a git ref, or `undefined` when the file does not exist there. Throws for other git errors. */
export function readAtRef(ref: string, path: string, cwd: string = process.cwd()): string | undefined {
  try {
    return execFileSync('git', ['show', `${ref}:./${path}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    if (/exists on disk, but not in|does not exist in/.test(stderr)) return undefined;
    throw new Error(`git show ${ref}:${path} failed: ${stderr.trim() || (error as Error).message}`);
  }
}
