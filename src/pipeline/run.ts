import { resolve, isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  loadGlobalConfig,
  loadPerRepoConfig,
  loadRepositoriesFile,
  ConfigError,
} from '../config/loader.js';
import type { RepositoryEntry } from '../config/schema.js';
import { discoverFiles } from './discovery.js';
import { parseFiles } from './parse.js';
import { categorizeFile } from './categorize.js';
import { sortRecords, writeJsonl } from '../writer/jsonl.js';
import { buildAggregates } from './aggregate.js';
import { renderReport, writeReport } from '../viewer/render.js';
import type {
  DatasetRecord,
  UnresolvedRecord,
  UsageRecord,
  Warning,
} from '../types/dataset.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { prescanBeaver } from '../prescan/beaver.js';
import { createTsResolver } from '../resolve/ts-resolver.js';

export const SCANNER_VERSION = '0.1.0';

export interface RunOptions {
  configPath: string;
}

export interface RunResult {
  datasetPath: string;
  aggregatesPath: string;
  reportPath: string | null;
  stats: {
    reposScanned: number;
    filesScanned: number;
    usages: number;
    unresolved: number;
    warnings: number;
    durationMs: number;
    beaverVersion: string;
  };
}

/**
 * Full pipeline runner (§6.5 `beaver-scan run`).
 * Wires Stage 5a (Beaver prescan), Stage 3 (resolve), Stages 1/2/4/6-partial/8
 * and renders the HTML viewer. Stages 5b (local-lib prescan), 6 Этап B, and 7
 * remain stubbed — see implementation/plan.md.
 */
export async function runScan(opts: RunOptions): Promise<RunResult> {
  const started = performance.now();
  const { config, configDir } = await loadGlobalConfig(opts.configPath);
  const repositories = await loadRepositoriesFile(config, configDir);

  const outputDir = isAbsolute(config.output.dir)
    ? config.output.dir
    : resolve(configDir, config.output.dir);
  await mkdir(outputDir, { recursive: true });

  const cacheDir = resolve(configDir, '.cache/beaver-ui');
  const beaverRegistry = await prescanBeaver({
    beaverUrl: config.beaverUrl,
    cacheDir,
  });

  const allRecords: DatasetRecord[] = [];
  const allWarnings: Warning[] = [];
  let filesScanned = 0;

  for (const repo of repositories) {
    const repoId = repoIdFor(repo);
    const repoRoot = await resolveRepoRoot(repo, configDir);

    const perRepo = await loadPerRepoConfig(repoRoot);
    const resolver = await createTsResolver(repoRoot, perRepo.tsconfig);

    const files = await discoverFiles(repoId, repoRoot, perRepo);
    filesScanned += files.length;

    const { parsed, warnings: parseWarnings } = await parseFiles(files);
    allWarnings.push(...parseWarnings);

    for (const parsedFile of parsed) {
      const { usages, unresolved, warnings } = categorizeFile({
        parsed: parsedFile,
        perRepo,
        repoRoot,
        resolver,
        beaverRegistry,
        ...(config.primitiveNames !== undefined
          ? { globalPrimitiveNames: config.primitiveNames }
          : {}),
      });
      allRecords.push(...(usages as UsageRecord[]));
      allRecords.push(...(unresolved as UnresolvedRecord[]));
      allWarnings.push(...warnings);
    }
  }

  const sorted = sortRecords(allRecords);

  const formats = new Set(config.output.formats);
  const datasetPath = join(outputDir, 'dataset.jsonl');
  const aggregatesPath = join(outputDir, 'aggregates.json');
  const reportPath = join(outputDir, 'report.html');
  const warningsPath = join(outputDir, 'warnings.json');

  if (formats.has('jsonl')) {
    await writeJsonl(datasetPath, sorted);
  }

  const aggregates = buildAggregates({
    records: sorted,
    warnings: allWarnings,
    scannerVersion: SCANNER_VERSION,
    scannedAt: new Date().toISOString(),
    scanDurationMs: Math.round(performance.now() - started),
    beaverVersion: beaverRegistry.version,
    reposScanned: repositories.length,
    filesScanned,
  });

  if (formats.has('aggregates')) {
    await writeFile(aggregatesPath, JSON.stringify(aggregates, null, 2), 'utf-8');
  }
  await writeFile(warningsPath, JSON.stringify(allWarnings, null, 2), 'utf-8');

  let writtenReport: string | null = null;
  if (formats.has('html')) {
    const html = renderReport(aggregates);
    await writeReport(reportPath, html);
    writtenReport = reportPath;
  }

  const usages = sorted.filter((r) => r.kind === 'usage').length;
  const unresolved = sorted.filter((r) => r.kind === 'unresolved-dynamic').length;

  return {
    datasetPath,
    aggregatesPath,
    reportPath: writtenReport,
    stats: {
      reposScanned: repositories.length,
      filesScanned,
      usages,
      unresolved,
      warnings: allWarnings.length,
      durationMs: Math.round(performance.now() - started),
      beaverVersion: beaverRegistry.version,
    },
  };
}

function repoIdFor(repo: RepositoryEntry): string {
  if (repo.name && repo.name.length > 0) return repo.name;
  const match = /\/([^/]+?)(?:\.git)?$/.exec(repo.gitUrl);
  if (match && match[1]) return match[1];
  return repo.gitUrl;
}

async function resolveRepoRoot(
  repo: RepositoryEntry,
  configDir: string,
): Promise<string> {
  if (repo.localPath) {
    return isAbsolute(repo.localPath)
      ? repo.localPath
      : resolve(configDir, repo.localPath);
  }
  throw new ConfigError(
    `Repository ${repoIdFor(repo)} has no localPath and MVP does not yet clone consumer repos (lands in M6). Provide localPath in repositories.json.`,
  );
}
