import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, dirname, isAbsolute } from 'node:path';
import {
  GlobalConfigSchema,
  PerRepoConfigSchema,
  RepositoriesFileSchema,
  type GlobalConfig,
  type PerRepoConfig,
  type RepositoryEntry,
} from './schema.js';

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Load global config. Supports `.json` (parsed directly), `.js/.mjs/.cjs`
 * (via dynamic import), and `.ts/.mts` (via on-demand tsx ESM register —
 * works under compiled `node dist/cli.js` without requiring the user to
 * preload tsx themselves).
 */
let tsxRegistered = false;

export async function loadGlobalConfig(configPath: string): Promise<{
  config: GlobalConfig;
  configDir: string;
}> {
  const abs = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);
  const configDir = dirname(abs);

  let raw: unknown;
  if (abs.endsWith('.json')) {
    const text = await readFile(abs, 'utf-8');
    raw = JSON.parse(text);
  } else {
    if ((abs.endsWith('.ts') || abs.endsWith('.mts')) && !tsxRegistered) {
      try {
        // tsx exposes a programmatic ESM register for transforming TS-on-import.
        const tsx = (await import('tsx/esm/api')) as { register: () => unknown };
        tsx.register();
        tsxRegistered = true;
      } catch (err) {
        throw new ConfigError(
          `Cannot load TypeScript config ${abs}: tsx is not available. ` +
            `Install tsx (npm i tsx) or convert the config to .json/.mjs. ` +
            `Underlying error: ${(err as Error).message}`,
        );
      }
    }
    const mod = await import(pathToFileURL(abs).href);
    raw = (mod as { default?: unknown }).default ?? mod;
  }

  const parsed = GlobalConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid global config at ${abs}`,
      parsed.error.format(),
    );
  }
  return { config: parsed.data, configDir };
}

export async function loadRepositoriesFile(
  globalConfig: GlobalConfig,
  configDir: string,
): Promise<RepositoryEntry[]> {
  const path = isAbsolute(globalConfig.repositoriesFile)
    ? globalConfig.repositoriesFile
    : resolve(configDir, globalConfig.repositoriesFile);

  const text = await readFile(path, 'utf-8');
  const json = JSON.parse(text) as unknown;
  const parsed = RepositoriesFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid repositories file at ${path}`,
      parsed.error.format(),
    );
  }
  return parsed.data;
}

/**
 * Load per-repo config. Precedence:
 *   1. `.beaver-scan.json` at the consumer repo root (opt-in by consumers)
 *   2. `inlineOverride` supplied by the operator via `repositories.json`
 *   3. Built-in Zod defaults
 *
 * Missing entirely is fine — the scanner uses defaults. Malformed (bad
 * JSON / schema violation) still fails fast so operators catch typos.
 */
export async function loadPerRepoConfig(
  repoRoot: string,
  inlineOverride?: unknown,
): Promise<PerRepoConfig> {
  const path = resolve(repoRoot, '.beaver-scan.json');
  let fromFile: unknown = undefined;
  try {
    const text = await readFile(path, 'utf-8');
    try {
      fromFile = JSON.parse(text);
    } catch (err) {
      throw new ConfigError(
        `Per-repo config at ${path} is not valid JSON: ${(err as Error).message}`,
      );
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') throw err;
    // File missing → fall through to override/defaults.
  }

  const raw = fromFile ?? inlineOverride ?? {};
  const parsed = PerRepoConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const source = fromFile !== undefined ? path : 'repositories.json inline config';
    throw new ConfigError(
      `Invalid per-repo config from ${source}`,
      parsed.error.format(),
    );
  }
  return parsed.data;
}
