import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { diffPackages, readAtRef } from './diff.ts';
import { discoverLockfiles } from './discover.ts';
import { findLine, LOCKFILES, parseLockfile } from './lockfile.ts';
import type { CheckOptions } from './options.ts';
import { plural, shortList } from './text.ts';
import type { Change, Location } from './types.ts';
import { nodeProjectFiles, workspaceUsage } from './workspaces.ts';

/** One version to check, the workspaces (relative to `cwd`) that use it, and where it sits in the lockfiles. */
export interface Target {
  change: Change;
  usedBy: Set<string>;
  locations: Location[];
}

export interface Collection {
  /** Lockfiles that were read, relative to `cwd`. */
  lockfiles: string[];
  /** Each name/from/to once, even when several lockfiles contain it. */
  targets: Target[];
  /** Workspaces across all lockfiles, relative to `cwd`. */
  workspaces: Set<string>;
  warnings: string[];
  notes: string[];
}

const toPosix = (path: string) => posix.normalize(path.replace(/\\/g, '/'));

function findLockfile(cwd: string, lockfile?: string): string {
  if (lockfile) {
    if (!existsSync(join(cwd, lockfile))) throw new Error(`lockfile not found: ${join(cwd, lockfile)}`);
    return lockfile;
  }
  const found = LOCKFILES.find((name) => existsSync(join(cwd, name)));
  if (!found) throw new Error(`no lockfile found in ${cwd} (looked for ${LOCKFILES.join(', ')})`);
  return found;
}

/** Changes in one lockfile, each tagged with the workspaces that use it. */
function collectLockfile(
  cwd: string,
  lockfile: string,
  base: string | undefined,
  workspaces: Set<string>,
  notes: string[],
): Target[] {
  const content = readFileSync(join(cwd, lockfile), 'utf8');
  const head = parseLockfile(lockfile, content);
  const before = base === undefined ? undefined : readAtRef(base, lockfile, cwd);
  const changes = diffPackages(before === undefined ? new Map() : parseLockfile(lockfile, before), head);
  const dir = toPosix(dirname(lockfile));
  const usage = workspaceUsage(lockfile, content, nodeProjectFiles(join(cwd, dir)));
  const label = (importer: string) => posix.join(dir, importer);
  const { unresolvedLinks: links, unresolvedRequired: required } = usage;
  if (links.length) {
    notes.push(
      `${lockfile}: ${plural(links.length, 'workspace dependency', 'workspace dependencies')} could not be resolved, so 'used by' doesn't follow ${links.length === 1 ? 'it' : 'them'}: ${shortList(links)}`,
    );
  }
  if (required.length) {
    notes.push(
      `${lockfile}: ${plural(required.length, 'required dependency is', 'required dependencies are')} missing from the lockfile, so 'used by' may be incomplete (is the lockfile out of sync?): ${shortList(required)}`,
    );
  }
  // A lockfile without workspace information belongs to its own folder. In a lockfile that has workspaces, a
  // package none of them reaches gets no attribution rather than a guess.
  const hasWorkspaces = usage.importers.length > 0;
  for (const importer of hasWorkspaces ? usage.importers : ['.']) workspaces.add(label(importer));
  return changes.map((change) => ({
    change,
    usedBy: new Set((hasWorkspaces ? (usage.usedBy.get(`${change.name}@${change.to}`) ?? []) : ['.']).map(label)),
    locations: [{ file: posix.join(dir, posix.basename(lockfile)), line: findLine(content, change.name, change.to) }],
  }));
}

/** Reads the lockfile(s) `options` select and returns the versions to check, with coverage warnings and notes. */
export function collect(cwd: string, options: CheckOptions): Collection {
  const { lockfiles: discovered, unreadable } = discoverLockfiles(cwd, options.exclude);
  const lockfiles = options.recursive ? discovered : [findLockfile(cwd, options.lockfile)];
  if (lockfiles.length === 0) throw new Error(`no lockfile found in ${cwd} (looked for ${LOCKFILES.join(', ')})`);

  const warnings: string[] = [];
  if (unreadable.length) {
    warnings.push(
      `could not read ${plural(unreadable.length, 'folder')}: ${shortList(unreadable)} (lockfiles inside were not checked)`,
    );
  }
  if (!options.recursive) {
    const checkedPath = toPosix(lockfiles[0]);
    const others = discovered.filter((path) => posix.normalize(path) !== checkedPath);
    if (others.length) {
      warnings.push(
        `${plural(others.length, 'more lockfile')} not checked: ${shortList(others)} (use --recursive or exclude ${others.length === 1 ? 'it' : 'them'})`,
      );
    }
  }

  const workspaces = new Set<string>();
  const notes: string[] = [];
  const targets = new Map<string, Target>();
  for (const lockfile of lockfiles) {
    for (const target of collectLockfile(cwd, lockfile, options.base, workspaces, notes)) {
      const key = `${target.change.name}\0${target.change.from ?? ''}\0${target.change.to}`;
      const existing = targets.get(key);
      if (existing) {
        for (const label of target.usedBy) existing.usedBy.add(label);
        existing.locations.push(...target.locations);
      } else {
        targets.set(key, target);
      }
    }
  }
  return { lockfiles, targets: [...targets.values()], workspaces, warnings, notes };
}
