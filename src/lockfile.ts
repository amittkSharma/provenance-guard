import { basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Packages } from './types.ts';

/** Lockfile names provenance-guard reads, in the order they are picked when several sit in one folder. */
export const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'] as const;

export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** Registry tarballs look like `<registry>/<name>/-/<name>-<version>.tgz`; git, file and link deps don't. */
export const isRegistryTarball = (resolved: unknown): boolean =>
  resolved === undefined || (typeof resolved === 'string' && /^https?:\/\/.+\/-\/.+\.tgz/.test(resolved));

/** `chalk@5.3.0` → ['chalk', '5.3.0']; `@scope/x@1.0.0` → ['@scope/x', '1.0.0']. */
export function splitSpec(spec: string): [string, string] | undefined {
  const at = spec.lastIndexOf('@');
  return at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : undefined;
}

function add(pkgs: Packages, name: string, version: string): void {
  if (!SEMVER.test(version)) return;
  let versions = pkgs.get(name);
  if (!versions) {
    versions = new Set();
    pkgs.set(name, versions);
  }
  versions.add(version);
}

interface NpmEntry {
  name?: string;
  version?: string;
  resolved?: string;
  link?: boolean;
}

function parseNpm(content: string): Packages {
  const lock = JSON.parse(content) as { lockfileVersion?: number; packages?: Record<string, NpmEntry> };
  if (!lock.packages) {
    throw new Error(
      `package-lock.json lockfileVersion ${lock.lockfileVersion ?? 1} is not supported; reinstall with npm >= 7`,
    );
  }
  const pkgs: Packages = new Map();
  for (const [path, entry] of Object.entries(lock.packages)) {
    const at = path.lastIndexOf('node_modules/');
    if (at === -1 || entry.link || !entry.version || !isRegistryTarball(entry.resolved)) continue;
    add(pkgs, entry.name ?? path.slice(at + 'node_modules/'.length), entry.version);
  }
  return pkgs;
}

function parsePnpm(content: string): Packages {
  const lock = parseYaml(content) as { lockfileVersion?: string | number; packages?: Record<string, unknown> };
  if (Number.parseFloat(String(lock.lockfileVersion)) < 6) {
    throw new Error(
      `pnpm-lock.yaml lockfileVersion ${lock.lockfileVersion} is not supported; reinstall with pnpm >= 8`,
    );
  }
  const pkgs: Packages = new Map();
  for (const key of Object.keys(lock.packages ?? {})) {
    // v9 keys are `name@version`; older ones start with `/` and may carry a `(peer@x)` suffix.
    const parts = splitSpec(key.replace(/^\//, '').replace(/\(.*$/, ''));
    if (parts) add(pkgs, ...parts);
  }
  return pkgs;
}

function parseYarnBerry(content: string): Packages {
  const lock = parseYaml(content) as Record<string, { resolution?: string }>;
  const pkgs: Packages = new Map();
  for (const [key, entry] of Object.entries(lock)) {
    if (key === '__metadata' || !entry?.resolution) continue;
    const at = entry.resolution.lastIndexOf('@npm:');
    // `foo@npm:1.0.0::__archiveUrl=…` → version is the part before `::`.
    if (at > 0) add(pkgs, entry.resolution.slice(0, at), entry.resolution.slice(at + '@npm:'.length).split('::')[0]);
  }
  return pkgs;
}

export interface YarnV1Entry {
  /** Header descriptors, e.g. `lodash@^4.17.20`, `string-width-cjs@npm:string-width@^4.2.0`. */
  descriptors: string[];
  /** Real package name (an `npm:` alias resolves to the aliased package). */
  name?: string;
  version?: string;
  resolved?: string;
  /** name → range. */
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
}

/** Parses a Yarn v1 lockfile into its entries. */
export function yarnV1Entries(content: string): YarnV1Entry[] {
  const entries: YarnV1Entry[] = [];
  let entry: YarnV1Entry | undefined;
  let section: 'dependencies' | 'optionalDependencies' | undefined;
  for (const line of content.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    if (!line.startsWith(' ')) {
      const descriptors = line
        .replace(/:$/, '')
        .split(', ')
        .map((d) => d.replace(/^"|"$/g, ''));
      // An npm: alias names the real package after `@npm:`.
      const first = descriptors[0];
      const alias = first.indexOf('@npm:');
      entry = {
        descriptors,
        name: splitSpec(alias > 0 ? first.slice(alias + '@npm:'.length) : first)?.[0],
        dependencies: {},
        optionalDependencies: {},
      };
      entries.push(entry);
      section = undefined;
      continue;
    }
    if (!entry) continue;
    if (/^ {2}\S/.test(line)) {
      const header = /^ {2}(dependencies|optionalDependencies):$/.exec(line);
      section = header ? (header[1] as 'dependencies' | 'optionalDependencies') : undefined;
      const field = /^ {2}(version|resolved) "(.*)"$/.exec(line);
      if (field?.[1] === 'version') entry.version = field[2];
      else if (field?.[1] === 'resolved') entry.resolved = field[2];
      continue;
    }
    const dep = section && /^ {4}(?:"([^"]+)"|(\S+)) (?:"([^"]*)"|(\S+))$/.exec(line);
    if (section && dep) entry[section][dep[1] ?? dep[2]] = dep[3] ?? dep[4];
  }
  return entries;
}

function parseYarnV1(content: string): Packages {
  const pkgs: Packages = new Map();
  for (const { name, version, resolved } of yarnV1Entries(content)) {
    // Yarn v1 always records `resolved` for registry packages; `link:` entries have none.
    if (name && version && resolved && isRegistryTarball(resolved)) add(pkgs, name, version);
  }
  return pkgs;
}

/** Every registry package and version in a lockfile. Git, file, link and workspace entries are skipped. */
export function parseLockfile(filename: string, raw: string): Packages {
  const content = raw.replace(/\r\n/g, '\n'); // Windows checkouts (core.autocrlf)
  switch (basename(filename)) {
    case 'package-lock.json':
    case 'npm-shrinkwrap.json':
      return parseNpm(content);
    case 'pnpm-lock.yaml':
      return parsePnpm(content);
    case 'yarn.lock':
      return /^__metadata:/m.test(content) ? parseYarnBerry(content) : parseYarnV1(content);
    default:
      throw new Error(`unsupported lockfile: ${filename} (expected package-lock.json, pnpm-lock.yaml or yarn.lock)`);
  }
}
