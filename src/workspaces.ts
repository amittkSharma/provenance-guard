import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isRegistryTarball, SEMVER, splitSpec, yarnV1Entries } from './lockfile.ts';

/** Read access to the project next to a lockfile. Paths are relative to the lockfile's directory. */
export interface ProjectFiles {
  readFile(path: string): string | undefined;
  listDirs(path: string): string[];
}

/** `ProjectFiles` backed by the real file system. */
export function nodeProjectFiles(root: string): ProjectFiles {
  return {
    readFile: (path) => {
      try {
        return readFileSync(join(root, path), 'utf8');
      } catch {
        return undefined;
      }
    },
    listDirs: (path) => {
      try {
        return readdirSync(join(root, path), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch {
        return [];
      }
    },
  };
}

export interface WorkspaceUsage {
  /** Workspace directories in the lockfile, relative to it (`.` is the root project). */
  importers: string[];
  /** `name@version` → workspaces that depend on it directly or transitively. */
  usedBy: Map<string, string[]>;
  /** Workspace/local links whose target isn't in the lockfile, e.g. `apps/web → packages/gone`. Not followed. */
  unresolvedLinks: string[];
  /** Required (non-optional, non-peer) dependencies missing from the lockfile, e.g. `debug@4.4.1 → ms`. */
  unresolvedRequired: string[];
}

/** Gaps found while resolving a lockfile's dependency graph. */
interface Unresolved {
  links: Set<string>;
  required: Set<string>;
}

const newUnresolved = (): Unresolved => ({ links: new Set(), required: new Set() });

/** Protocols that point at a local folder or workspace rather than a registry package. */
const LOCAL_PROTOCOL = /^(workspace|link|portal|file):/;

/** A dependency graph: workspaces (importers) are entry points; `key` names registry packages. */
interface Graph {
  importers: Map<string, string>; // label → node id
  /** Filled while `deps`/`devDeps` run. */
  unresolved: Unresolved;
  /** Production, optional and peer dependencies of a node (for a workspace too). */
  deps(id: string): string[];
  /** A workspace's devDependencies. Followed only from the workspace the walk starts at. */
  devDeps(id: string): string[];
  key(id: string): string | undefined;
}

/**
 * Walks the graph once per workspace. Every node's dependencies are resolved once up front, so the per-workspace
 * walks only touch integer arrays: O(nodes + edges) to build, then O(workspaces × reachable nodes) cheap steps.
 */
function walk(graph: Graph): WorkspaceUsage {
  const index = new Map<string, number>();
  const ids: string[] = [];
  const intern = (id: string): number => {
    let n = index.get(id);
    if (n === undefined) {
      n = ids.length;
      index.set(id, n);
      ids.push(id);
    }
    return n;
  };
  const starts = [...graph.importers].map(([label, id]) => ({
    label,
    n: intern(id),
    dev: graph.devDeps(id).map(intern),
  }));
  const adjacency: number[][] = [];
  const pending = starts.flatMap((s) => [s.n, ...s.dev]);
  for (let n = pending.pop(); n !== undefined; n = pending.pop()) {
    if (adjacency[n]) continue;
    adjacency[n] = graph.deps(ids[n]).map(intern);
    for (const next of adjacency[n]) if (!adjacency[next]) pending.push(next);
  }
  const keys = ids.map((id) => graph.key(id));

  const usedBy = new Map<string, Set<string>>();
  const seen = new Int32Array(ids.length).fill(-1);
  starts.forEach(({ label, n: start, dev }, round) => {
    const queue = [start, ...dev];
    for (const n of queue) seen[n] = round;
    for (let n = queue.pop(); n !== undefined; n = queue.pop()) {
      const key = keys[n];
      if (key) usedBy.set(key, (usedBy.get(key) ?? new Set()).add(label));
      for (const next of adjacency[n]) {
        if (seen[next] !== round) {
          seen[next] = round;
          queue.push(next);
        }
      }
    }
  });
  return {
    importers: [...graph.importers.keys()].sort(),
    usedBy: new Map(
      [...usedBy].sort(([a], [b]) => a.localeCompare(b)).map(([key, labels]) => [key, [...labels].sort()]),
    ),
    unresolvedLinks: [...graph.unresolved.links].sort(),
    unresolvedRequired: [...graph.unresolved.required].sort(),
  };
}

/** `name@version` for a registry version, otherwise undefined. */
const registryKey = (name: string | undefined, version: string | undefined) =>
  name && version && SEMVER.test(version) ? `${name}@${version}` : undefined;

type DepMap = Record<string, string> | undefined;

interface NpmEntry {
  name?: string;
  version?: string;
  resolved?: string;
  link?: boolean;
  dependencies?: DepMap;
  optionalDependencies?: DepMap;
  peerDependencies?: DepMap;
  devDependencies?: DepMap;
}

function npmGraph(content: string): Graph {
  const packages = (JSON.parse(content) as { packages?: Record<string, NpmEntry> }).packages ?? {};
  const unresolved = newUnresolved();
  const isLocal = (path: string) => !path.split('/').includes('node_modules');
  // Workspaces live inside the repo; `../shared` (a `file:` dependency) is followed but isn't a workspace.
  const isWorkspace = (path: string) => isLocal(path) && path !== '..' && !path.startsWith('../');
  const display = (id: string) => {
    if (id === '') return '.';
    const at = id.lastIndexOf('node_modules/');
    return packages[id]?.name ?? (at === -1 ? id : id.slice(at + 'node_modules/'.length));
  };
  /** Node's lookup: `<dir>/node_modules/<name>` from the package's own directory up to the root. */
  const resolve = (from: string, name: string) => {
    const parts = from ? from.split('/') : [];
    for (let i = parts.length; i >= 0; i--) {
      const prefix = parts.slice(0, i).join('/');
      const candidate = prefix ? `${prefix}/node_modules/${name}` : `node_modules/${name}`;
      if (candidate in packages) return candidate;
    }
    return undefined;
  };
  /** Resolves dependency names; missing required ones are recorded, missing optional/peer ones are expected. */
  const resolveAll = (from: string, deps: DepMap, required: boolean) =>
    Object.keys(deps ?? {})
      .map((name) => {
        const path = resolve(from, name);
        if (!path && required) unresolved.required.add(`${display(from)} → ${name}`);
        return path;
      })
      .filter((path): path is string => path !== undefined);
  return {
    importers: new Map(
      Object.keys(packages)
        .filter(isWorkspace)
        .map((path) => [path || '.', path]),
    ),
    unresolved,
    deps(id) {
      const entry = packages[id];
      if (!entry) return [];
      if (entry.link) {
        if (entry.resolved && entry.resolved in packages) return [entry.resolved];
        unresolved.links.add(`${display(id)} → ${entry.resolved ?? '?'}`);
        return [];
      }
      return [
        ...resolveAll(id, entry.dependencies, true),
        ...resolveAll(id, { ...entry.optionalDependencies, ...entry.peerDependencies }, false),
      ];
    },
    devDeps: (id) => (isLocal(id) ? resolveAll(id, packages[id]?.devDependencies, true) : []),
    key(id) {
      const entry = packages[id];
      const at = id.lastIndexOf('node_modules/');
      if (!entry || at === -1 || entry.link || !isRegistryTarball(entry.resolved)) return undefined;
      return registryKey(entry.name ?? id.slice(at + 'node_modules/'.length), entry.version);
    },
  };
}

type PnpmDeps = Record<string, { version?: string } | string> | undefined;
interface PnpmImporter {
  dependencies?: PnpmDeps;
  devDependencies?: PnpmDeps;
  optionalDependencies?: PnpmDeps;
}
interface PnpmLock extends PnpmImporter {
  importers?: Record<string, PnpmImporter>;
  packages?: Record<string, { dependencies?: DepMap; optionalDependencies?: DepMap }>;
  snapshots?: Record<string, { dependencies?: DepMap; optionalDependencies?: DepMap }>;
}

function pnpmGraph(content: string): Graph {
  const lock = parseYaml(content) as PnpmLock;
  const unresolved = newUnresolved();
  // v9 keeps resolved dependencies in `snapshots`; v6 keeps them in `packages` with a leading `/`.
  const index = new Map(
    Object.entries(lock.snapshots ?? lock.packages ?? {}).map(([key, value]) => [key.replace(/^\//, ''), value]),
  );
  // A single-project v6 lockfile has no `importers`; its dependencies sit at the top level.
  const importers = lock.importers ?? { '.': lock };
  /** `owner` is a workspace path (for importers) or `name@version` (for packages); `from` anchors `link:` paths. */
  const refs = (deps: PnpmDeps, owner: string, from: string, required: boolean) =>
    Object.entries(deps ?? {})
      .map(([name, dep]) => {
        const version = typeof dep === 'string' ? dep : dep?.version;
        if (!version) return undefined;
        if (version.startsWith('link:')) {
          const target = posix.normalize(posix.join(from, version.slice('link:'.length)));
          if (target in importers) return `i:${target}`;
          unresolved.links.add(`${owner} → ${target}`);
          return undefined;
        }
        const v = version.replace(/^\//, '');
        const key = [`${name}@${v}`, v].find((candidate) => index.has(candidate));
        if (!key && required) unresolved.required.add(`${owner} → ${name}`);
        return key && `p:${key}`;
      })
      .filter((id): id is string => id !== undefined);
  return {
    importers: new Map(Object.keys(importers).map((path) => [path, `i:${path}`])),
    unresolved,
    deps(id) {
      const name = id.slice(2);
      if (id.startsWith('i:')) {
        const imp = importers[name];
        return imp
          ? [...refs(imp.dependencies, name, name, true), ...refs(imp.optionalDependencies, name, name, false)]
          : [];
      }
      const snap = index.get(name);
      const owner = name.replace(/\(.*$/, '');
      return snap
        ? [...refs(snap.dependencies, owner, '.', true), ...refs(snap.optionalDependencies, owner, '.', false)]
        : [];
    },
    devDeps: (id) =>
      id.startsWith('i:') ? refs(importers[id.slice(2)]?.devDependencies, id.slice(2), id.slice(2), true) : [],
    key(id) {
      if (!id.startsWith('p:')) return undefined;
      const parts = splitSpec(id.slice(2).replace(/\(.*$/, ''));
      return parts && registryKey(...parts);
    },
  };
}

interface BerryEntry {
  resolution?: string;
  dependencies?: DepMap;
  dependenciesMeta?: Record<string, { optional?: boolean }>;
}

/** `typescript@patch:typescript@npm%3A5.6.3#…` → `typescript@npm:5.6.3`; other resolutions unchanged. */
function unpatch(resolution: string): string {
  const patch = resolution.indexOf('@patch:');
  return patch > 0 ? decodeURIComponent(resolution.slice(patch + '@patch:'.length).split('#')[0]) : resolution;
}

function berryGraph(content: string): Graph {
  const lock = parseYaml(content) as Record<string, BerryEntry>;
  const unresolved = newUnresolved();
  const byDescriptor = new Map<string, string>();
  const importers = new Map<string, string>();
  const workspaceOf = new Map<string, string>();
  for (const [key, entry] of Object.entries(lock)) {
    if (key === '__metadata') continue;
    for (const descriptor of key.split(/,\s*/)) byDescriptor.set(descriptor, key);
    const ws = entry?.resolution?.indexOf('@workspace:') ?? -1;
    if (ws > 0) {
      const path = entry.resolution?.slice(ws + '@workspace:'.length) ?? '.';
      importers.set(path, key);
      workspaceOf.set(key, path);
    }
  }
  const npmVersion = (id: string) => {
    const resolution = unpatch(lock[id]?.resolution ?? '');
    const at = resolution.lastIndexOf('@npm:');
    return at > 0
      ? ([resolution.slice(0, at), resolution.slice(at + '@npm:'.length).split('::')[0]] as const)
      : undefined;
  };
  const display = (id: string) => workspaceOf.get(id) ?? npmVersion(id)?.join('@') ?? id;
  return {
    importers,
    unresolved,
    // Berry lockfiles merge a workspace's devDependencies into `dependencies`, so they can't be told apart.
    devDeps: () => [],
    deps(id) {
      const entry = lock[id];
      return Object.entries(entry?.dependencies ?? {})
        .map(([name, range]) => {
          const key = byDescriptor.get(`${name}@${range}`) ?? byDescriptor.get(`${name}@npm:${range}`);
          if (key || entry?.dependenciesMeta?.[name]?.optional) return key;
          if (LOCAL_PROTOCOL.test(range)) unresolved.links.add(`${display(id)} → ${name}@${range}`);
          else unresolved.required.add(`${display(id)} → ${name}`);
          return undefined;
        })
        .filter((key): key is string => key !== undefined);
    },
    key(id) {
      const parts = npmVersion(id);
      return parts && registryKey(...parts);
    },
  };
}

interface Manifest {
  name?: string;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: DepMap;
  devDependencies?: DepMap;
  optionalDependencies?: DepMap;
}

/** Glob → RegExp for workspace patterns: `**` (any depth), `*`, `?` and `{a,b}`. */
function globToRegExp(pattern: string): RegExp {
  let re = '';
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (pattern.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 2;
    } else if (pattern.startsWith('/**', i) && i + 3 === pattern.length) {
      re += '(?:/.*)?';
      i += 2;
    } else if (pattern.startsWith('**', i)) {
      re += '.*';
      i += 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      braces++;
      re += '(?:';
    } else if (c === '}' && braces > 0) {
      braces--;
      re += ')';
    } else if (c === ',' && braces > 0) re += '|';
    else re += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Workspace directories matching the root package.json `workspaces` patterns; `!pattern` excludes. */
function expandWorkspaces(patterns: string[], files: ProjectFiles): string[] {
  const clean = (p: string) => p.replace(/^\.\//, '').replace(/\/+$/, '');
  const exclude = patterns.filter((p) => p.startsWith('!')).map((p) => globToRegExp(clean(p.slice(1))));
  const found = new Set<string>();
  for (const pattern of patterns.filter((p) => !p.startsWith('!')).map(clean)) {
    const matcher = globToRegExp(pattern);
    // Walk only below the pattern's fixed prefix, e.g. `packages` for `packages/**`.
    const segments = pattern.split('/');
    const firstWild = segments.findIndex((segment) => /[*?{]/.test(segment));
    const visit = (dir: string) => {
      if (matcher.test(dir) && files.readFile(posix.join(dir, 'package.json')) !== undefined) found.add(dir);
      if (firstWild === -1) return;
      for (const name of files.listDirs(dir || '.')) {
        if (name !== 'node_modules' && !name.startsWith('.')) visit(posix.join(dir, name));
      }
    };
    visit((firstWild === -1 ? segments : segments.slice(0, firstWild)).join('/'));
  }
  return [...found].filter((dir) => dir !== '' && dir !== '.' && !exclude.some((re) => re.test(dir)));
}

/** Yarn v1 lockfiles don't list workspaces, so they are read from the package.json files. */
function yarnV1Graph(content: string, files: ProjectFiles): Graph {
  const entries = yarnV1Entries(content);
  const unresolved = newUnresolved();
  const byDescriptor = new Map<string, number>();
  entries.forEach((entry, i) => {
    for (const descriptor of entry.descriptors) byDescriptor.set(descriptor, i);
  });
  const readManifest = (dir: string): Manifest | undefined => {
    const text = files.readFile(posix.join(dir, 'package.json'));
    return text === undefined ? undefined : (JSON.parse(text) as Manifest);
  };
  const root = readManifest('.');
  const manifests = new Map<string, Manifest>();
  if (root) {
    manifests.set('.', root);
    const patterns = Array.isArray(root.workspaces) ? root.workspaces : (root.workspaces?.packages ?? []);
    for (const dir of expandWorkspaces(patterns, files)) {
      const manifest = readManifest(dir);
      if (manifest) manifests.set(dir, manifest);
    }
  }
  const workspaceByName = new Map([...manifests].filter(([, m]) => m.name).map(([dir, m]) => [m.name, dir]));
  const lookup = (name: string, range: string) => {
    const i = byDescriptor.get(`${name}@${range}`);
    return i === undefined ? undefined : `e:${i}`;
  };
  /** Resolves `name → range` pairs; records missing local links and missing required dependencies. */
  const refs = (deps: DepMap, owner: string, required: boolean, workspaces: boolean) =>
    Object.entries(deps ?? {})
      .map(([name, range]) => {
        if (workspaces && workspaceByName.has(name)) return `w:${workspaceByName.get(name)}`;
        const next = lookup(name, range);
        if (!next && LOCAL_PROTOCOL.test(range)) unresolved.links.add(`${owner} → ${name}@${range}`);
        else if (!next && required) unresolved.required.add(`${owner} → ${name}`);
        return next;
      })
      .filter((next): next is string => next !== undefined);
  const entryName = (i: number) => `${entries[i].name}@${entries[i].version}`;
  return {
    importers: new Map([...manifests.keys()].map((dir) => [dir, `w:${dir}`])),
    unresolved,
    devDeps: (id) =>
      id.startsWith('w:') ? refs(manifests.get(id.slice(2))?.devDependencies, id.slice(2), true, true) : [],
    deps(id) {
      if (id.startsWith('w:')) {
        const dir = id.slice(2);
        const m = manifests.get(dir);
        return [...refs(m?.dependencies, dir, true, true), ...refs(m?.optionalDependencies, dir, false, true)];
      }
      const i = Number(id.slice(2));
      return [
        ...refs(entries[i].dependencies, entryName(i), true, false),
        ...refs(entries[i].optionalDependencies, entryName(i), false, false),
      ];
    },
    key(id) {
      if (!id.startsWith('e:')) return undefined;
      const { name, version, resolved } = entries[Number(id.slice(2))];
      return resolved && isRegistryTarball(resolved) ? registryKey(name, version) : undefined;
    },
  };
}

/**
 * Which workspaces use each registry package in a lockfile, directly or through other packages and workspaces.
 * `files` gives access to the project next to the lockfile (only Yarn v1 needs it).
 */
export function workspaceUsage(
  filename: string,
  raw: string,
  files: ProjectFiles = { readFile: () => undefined, listDirs: () => [] },
): WorkspaceUsage {
  const content = raw.replace(/\r\n/g, '\n');
  switch (basename(filename)) {
    case 'package-lock.json':
    case 'npm-shrinkwrap.json':
      return walk(npmGraph(content));
    case 'pnpm-lock.yaml':
      return walk(pnpmGraph(content));
    case 'yarn.lock':
      return walk(/^__metadata:/m.test(content) ? berryGraph(content) : yarnV1Graph(content, files));
    default:
      throw new Error(`unsupported lockfile: ${filename}`);
  }
}
