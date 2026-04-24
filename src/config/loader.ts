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
 * Load global config. Supports .ts/.js/.mjs/.cjs (via dynamic import) and .json.
 * TS files are loaded through tsx at runtime (see cli.ts preload).
 */
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

export async function loadPerRepoConfig(repoRoot: string): Promise<PerRepoConfig> {
  const path = resolve(repoRoot, '.beaver-scan.json');
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new ConfigError(
        `Per-repo config not found at ${path}. Each repo MUST have .beaver-scan.json (PRD §9.2).`,
      );
    }
    throw err;
  }
  const json = JSON.parse(text) as unknown;
  const parsed = PerRepoConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid per-repo config at ${path}`,
      parsed.error.format(),
    );
  }
  return parsed.data;
}
