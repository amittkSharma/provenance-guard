#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { check } from './check.ts';
import { type CheckOptions, DEFAULT_REGISTRY } from './options.ts';
import type { FetchJson } from './registry.ts';
import { OUTPUT_FORMATS, type OutputFormat, render } from './report.ts';

const USAGE = `Usage: provenance-guard <diff|scan> [options]

Commands:
  diff    Check packages added or upgraded since a git ref (for pull requests)
  scan    Check every package in the lockfile

Options:
  --base <ref>        Git ref to compare against (diff only, default: origin/main)
  --lockfile <path>   Lockfile to read (default: auto-detect in the current folder)
  --recursive         Check every lockfile below the current folder (monorepos)
  --format <fmt>      Format printed to stdout: text | json | markdown | sarif | junit | html (default: text)
  --output <fmt>=<path>
                      Also write a report file; repeat for several formats from one run
                      (e.g. --output sarif=reports/pg.sarif --output html=reports/pg.html)
  --config <path>     Config file (default: .provenance-guard.json if present)
  --registry <url>    Registry URL (default: $npm_config_registry or https://registry.npmjs.org)
  -h, --help          Show this help

Exit codes: 0 no errors, 1 error findings, 2 tool failure`;

const isFormat = (value: string): value is OutputFormat => (OUTPUT_FORMATS as readonly string[]).includes(value);

/** `sarif=reports/pg.sarif` → ['sarif', 'reports/pg.sarif'] */
function parseOutput(value: string): [OutputFormat, string] {
  const at = value.indexOf('=');
  const format = at === -1 ? value : value.slice(0, at);
  const path = at === -1 ? '' : value.slice(at + 1);
  if (!isFormat(format) || !path) {
    throw new Error(`--output must be <format>=<path> with format one of ${OUTPUT_FORMATS.join(', ')}, got "${value}"`);
  }
  return [format, path];
}

interface RunDeps {
  cwd?: string;
  fetchJson?: FetchJson;
  env?: Record<string, string | undefined>;
}

interface RunResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

function readConfig(cwd: string, path?: string): CheckOptions {
  const file = join(cwd, path ?? '.provenance-guard.json');
  if (!existsSync(file)) {
    if (path) throw new Error(`config file not found: ${file}`);
    return {};
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CheckOptions;
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${(error as Error).message}`);
  }
}

/** Runs the CLI without touching process state, so it can be tested and embedded. */
export async function run(argv: string[], deps: RunDeps = {}): Promise<RunResult> {
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (error) {
    return { exitCode: 2, stdout: '', stderr: `${(error as Error).message}\n\n${USAGE}\n` };
  }
  if (args.values.help) return { exitCode: 0, stdout: `${USAGE}\n`, stderr: '' };

  const [command] = args.positionals;
  const format = args.values.format ?? 'text';
  if (command !== 'diff' && command !== 'scan') {
    return { exitCode: 2, stdout: '', stderr: `expected a command: diff or scan\n\n${USAGE}\n` };
  }
  if (!isFormat(format)) {
    return { exitCode: 2, stdout: '', stderr: `--format must be one of ${OUTPUT_FORMATS.join(', ')}\n` };
  }
  let outputs: [OutputFormat, string][];
  try {
    outputs = (args.values.output ?? []).map(parseOutput);
  } catch (error) {
    return { exitCode: 2, stdout: '', stderr: `${(error as Error).message}\n` };
  }

  try {
    const config = readConfig(cwd, args.values.config);
    const result = await check({
      ...config,
      cwd,
      // --recursive on the command line overrides a lockfile from the config file.
      lockfile: args.values.lockfile ?? (args.values.recursive ? undefined : config.lockfile),
      recursive: args.values.recursive ?? config.recursive,
      base: command === 'diff' ? (args.values.base ?? config.base ?? 'origin/main') : undefined,
      registry: args.values.registry ?? config.registry ?? env.npm_config_registry ?? DEFAULT_REGISTRY,
      fetchJson: deps.fetchJson,
    });
    // One check, many renders: extra formats cost no extra registry calls.
    const options = { generatedAt: new Date().toISOString() };
    for (const [outputFormat, path] of outputs) {
      const file = resolve(cwd, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, render(outputFormat, result, options));
    }
    return { exitCode: result.exitCode, stdout: render(format, result, options), stderr: '' };
  } catch (error) {
    return { exitCode: 2, stdout: '', stderr: `provenance-guard: ${(error as Error).message}\n` };
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      lockfile: { type: 'string' },
      recursive: { type: 'boolean' },
      format: { type: 'string' },
      output: { type: 'string', multiple: true },
      config: { type: 'string' },
      registry: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = await run(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
