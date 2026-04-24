import { resolve, isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  loadGlobalConfig,
  loadPerRepoConfig,
  loadRepositoriesFile,
  ConfigError,
} from '../config/loader.js';
import type { RepositoryEntry } from '../config/schema.js';
import { discoverFiles, type DiscoveredFile } from './discovery.js';
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
  };
}

/**
 * Full pipeline runner (§6.5 `beaver-scan run`).
 * MVP: Stages 1, 2, 4, 6(partial), 8 + viewer. Stages 3, 5, 7 are stubbed.
 */
export async function runScan(opts: RunOptions): Promise<RunResult> {
  const started = performance.now();
  const { config, configDir } = await loadGlobalConfig(opts.configPath);
  const repositories = await loadRepositoriesFile(config, configDir);

  const outputDir = isAbsolute(config.output.dir)
    ? config.output.dir
    : resolve(configDir, config.output.dir);
  await mkdir(outputDir, { recursive: true });

  const allRecords: DatasetRecord[] = [];
  const allWarnings: Warning[] = [];
  let filesScanned = 0;

  for (const repo of repositories) {
    const repoId = repoIdFor(repo);
    const repoRoot = await resolveRepoRoot(repo, configDir);

    let perRepo;
    try {
      perRepo = await loadPerRepoConfig(repoRoot);
    } catch (err) {
      if (err instanceof ConfigError) {
        throw err; // fail fast per §8.3
      }
      throw err;
    }

    const files = await discoverFiles(repoId, repoRoot, perRepo);
    filesScanned += files.length;

    const { parsed, warnings: parseWarnings } = await parseFiles(files);
    allWarnings.push(...parseWarnings);

    for (const parsedFile of parsed) {
      const { usages, unresolved, warnings } = categorizeFile(parsedFile, config, perRepo);
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
    beaverVersion: 'unprescanned', // Stage 5 stub
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
    return isAbsolute(repo.localPath) ? repo.localPath : resolve(configDir, repo.localPath);
  }
  throw new ConfigError(
    `Repository ${repoIdFor(repo)} has no localPath and MVP does not yet clone (Stage 5). Provide localPath in repositories.json or wait for Stage-5 clone support.`,
  );
}
