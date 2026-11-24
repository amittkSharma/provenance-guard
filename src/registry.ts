import type { Trust, Unverified, VersionFacts } from './types.ts';

/** Fetches a URL and returns its status and parsed JSON body. Replace it to add auth, proxies or caching. */
export type FetchJson = (url: string) => Promise<{ status: number; body?: unknown }>;

/** A package's published versions, oldest first. */
export interface History {
  versions: VersionFacts[];
}

/** The registry could not be read (network error, 5xx, 429). The run must not pass silently. */
export class RegistryError extends Error {
  url: string;
  constructor(url: string, reason: string) {
    super(`registry request failed: ${url} (${reason})`);
    this.name = 'RegistryError';
    this.url = url;
  }
}

export interface FetchJsonOptions {
  /** Maximum parallel requests. Default 8. */
  concurrency?: number;
  /** Extra request headers, e.g. `{ authorization: 'Bearer <token>' }` for a private registry. */
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
}

/** `FetchJson` built on global `fetch`, with a concurrency limit and a timeout. */
export function createFetchJson({
  concurrency = 8,
  headers = {},
  timeoutMs = 30_000,
}: FetchJsonOptions = {}): FetchJson {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (url) => {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, body: res.ok ? await res.json() : undefined };
    } catch (error) {
      throw new RegistryError(url, (error as Error).cause ? String((error as Error).cause) : (error as Error).message);
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

export const defaultFetchJson: FetchJson = createFetchJson();

interface PackumentVersion {
  _npmUser?: { name?: string; trustedPublisher?: unknown };
  dist?: { attestations?: { url?: string; provenance?: unknown } };
  scripts?: Record<string, string>;
  gypfile?: boolean;
}

interface Packument {
  time?: Record<string, string>;
  versions?: Record<string, PackumentVersion>;
}

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];
const SLSA_PROVENANCE = 'https://slsa.dev/provenance/v1';

function trustOf(v: PackumentVersion): Trust {
  if (v._npmUser?.trustedPublisher) return 'trusted-publisher';
  if (v.dist?.attestations?.provenance) return 'provenance';
  return 'none';
}

function toFacts(packument: Packument): VersionFacts[] {
  const facts: VersionFacts[] = [];
  for (const [version, v] of Object.entries(packument.versions ?? {})) {
    const publishedAt = packument.time?.[version];
    if (!publishedAt) continue;
    facts.push({
      version,
      publishedAt,
      trust: trustOf(v),
      publisher: v._npmUser?.name,
      hasInstallScript: v.gypfile === true || INSTALL_SCRIPTS.some((s) => v.scripts?.[s]),
    });
  }
  return facts.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
}

/** Reads package histories from an npm-compatible registry. Packuments are cached for the life of the object. */
export function createRegistry(fetchJson: FetchJson, base: string) {
  const root = base.replace(/\/+$/, '');
  const packuments = new Map<string, Promise<Packument | Unverified>>();

  const get = async (url: string): Promise<{ status: number; body?: unknown }> => {
    const res = await fetchJson(url);
    if (res.status === 429 || res.status >= 500) throw new RegistryError(url, `HTTP ${res.status}`);
    return res;
  };

  const packument = (name: string): Promise<Packument | Unverified> => {
    let pending = packuments.get(name);
    if (!pending) {
      pending = get(`${root}/${name.replace('/', '%2f')}`).then(({ status, body }) =>
        status === 200 ? (body as Packument) : { name, version: '*', reason: `registry ${status}` },
      );
      packuments.set(name, pending);
    }
    return pending;
  };

  const sourceRepo = async (url: string): Promise<string | undefined> => {
    const { status, body } = await get(url);
    if (status !== 200) return undefined;
    const attestations = (body as { attestations?: { predicateType?: string; bundle?: unknown }[] }).attestations;
    const slsa = attestations?.find((a) => a.predicateType === SLSA_PROVENANCE);
    const payload = (slsa?.bundle as { dsseEnvelope?: { payload?: string } } | undefined)?.dsseEnvelope?.payload;
    if (!payload) return undefined;
    const statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    const repo = statement?.predicate?.buildDefinition?.externalParameters?.workflow?.repository;
    return typeof repo === 'string' ? repo.toLowerCase() : undefined;
  };

  return {
    /** All published versions with their trust facts (without `sourceRepo`), or `Unverified` on 401/403/404. */
    async history(name: string): Promise<History | Unverified> {
      const p = await packument(name);
      return 'reason' in p ? p : { versions: toFacts(p) };
    },

    /** Fills `sourceRepo` for the given versions that have provenance. */
    async withSourceRepos(name: string, history: History, versions: string[]): Promise<History> {
      const p = await packument(name);
      if ('reason' in p) return history;
      const wanted = new Set(versions);
      return {
        versions: await Promise.all(
          history.versions.map(async (facts) => {
            const url = p.versions?.[facts.version]?.dist?.attestations?.url;
            if (!wanted.has(facts.version) || facts.trust === 'none' || !url) return facts;
            return { ...facts, sourceRepo: await sourceRepo(url) };
          }),
        ),
      };
    },
  };
}

export type Registry = ReturnType<typeof createRegistry>;
