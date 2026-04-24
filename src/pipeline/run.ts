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
import { parseFiles, type ParsedFile } from './parse.js';
import { collectUsages, type PendingUsage } from './collect.js';
import { buildProfilesForFile, profileKey, type ComponentProfile } from './profile.js';
import { classifyPass } from './classify-pass.js';
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
import { prescanLocalLibs } from '../prescan/local-lib.js';
import { createTsResolver, type TsResolver } from '../resolve/ts-resolver.js';
import type { BeaverRegistry, LocalLibRegistry } from '../types/prescan.js';
import type { SignalContext } from '../classify/signals.js';
import { resolveRoutes } from '../route/resolve.js';
import { normalize as normalizePath } from '../route/import-graph.js';

export const SCANNER_VERSION = '0.1.0';

const DEFAULT_PRIMITIVE_NAMES = [
  'Button', 'Input', 'TextField', 'Select', 'Checkbox', 'Radio', 'Switch',
  'Toggle', 'Text', 'Heading', 'Title', 'Label', 'Icon', 'Avatar', 'Badge',
  'Tag', 'Chip', 'Card', 'Modal', 'Dialog', 'Drawer', 'Tooltip', 'Popover',
  'Popup', 'Menu', 'Dropdown', 'Tab', 'Tabs', 'Panel', 'Accordion',
  'Divider', 'Spacer', 'Stack', 'Flex', 'Grid', 'Box', 'Container',
  'Alert', 'Notification', 'Toast', 'Skeleton', 'Spinner', 'Loader',
  'Progress',
];

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
    shadowComponents: number;
    unresolved: number;
    warnings: number;
    durationMs: number;
    beaverVersion: string;
  };
}

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
    const localLibRegistry = await prescanLocalLibs(
      perRepo,
      repoRoot,
      beaverRegistry,
      perRepo.tsconfig,
    );

    const files = await discoverFiles(repoId, repoRoot, perRepo);
    filesScanned += files.length;

    const { parsed, warnings: parseWarnings } = await parseFiles(files);
    allWarnings.push(...parseWarnings);

    const perRepoResult = await classifyRepo({
      parsed,
      perRepo,
      repoRoot,
      resolver,
      beaverRegistry,
      localLibRegistry,
      globalPrimitiveNames: config.primitiveNames ?? DEFAULT_PRIMITIVE_NAMES,
      thresholds: config.thresholds,
    });

    // Stage 7: route resolution (§4.7). Opt-out via global/per-repo config;
    // if no router config found in the repo, every usage stays `unsupported`.
    const routeEnabled =
      (perRepo.routeResolution?.enabled ?? config.routeResolution?.enabled ?? true) !==
      false;
    if (routeEnabled) {
      const resolution = resolveRoutes({
        parsed,
        resolver,
        depthLimit: config.routeResolution?.importGraphDepthLimit ?? 20,
      });
      if (resolution.entries.length > 0) {
        applyRoutes(perRepoResult.usages, resolution.byFile, repoRoot);
        applyRoutesToShadow(perRepoResult.shadowRecords, resolution.byFile, repoRoot);
        for (const w of resolution.warnings) {
          allWarnings.push({
            repoId,
            code: 'route-resolution-warning',
            message: w,
          });
        }
      }
    }

    allRecords.push(...(perRepoResult.usages as UsageRecord[]));
    allRecords.push(...perRepoResult.shadowRecords);
    allRecords.push(...(perRepoResult.unresolved as UnresolvedRecord[]));
    allWarnings.push(...perRepoResult.warnings);

    for (const failed of localLibRegistry.prescanFailed) {
      allWarnings.push({
        repoId,
        code: 'local-lib-prescan-failed',
        message: `Local library "${failed}" prescan failed; components fall back to config.kind`,
      });
    }

    const unresolvedRate =
      perRepoResult.usages.length + perRepoResult.unresolved.length > 0
        ? perRepoResult.unresolved.length /
          (perRepoResult.usages.length + perRepoResult.unresolved.length)
        : 0;
    if (unresolvedRate > config.thresholds.unresolvedDynamicWarningPct) {
      allWarnings.push({
        repoId,
        code: 'unresolved-dynamic-rate-exceeded',
        message: `Unresolved-dynamic rate ${(unresolvedRate * 100).toFixed(2)}% exceeds threshold ${(
          config.thresholds.unresolvedDynamicWarningPct * 100
        ).toFixed(2)}% (§5.4)`,
      });
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
  const shadowComponents = sorted.filter((r) => r.kind === 'shadow-component').length;
  const unresolved = sorted.filter((r) => r.kind === 'unresolved-dynamic').length;

  return {
    datasetPath,
    aggregatesPath,
    reportPath: writtenReport,
    stats: {
      reposScanned: repositories.length,
      filesScanned,
      usages,
      shadowComponents,
      unresolved,
      warnings: allWarnings.length,
      durationMs: Math.round(performance.now() - started),
      beaverVersion: beaverRegistry.version,
    },
  };
}

interface ClassifyRepoInput {
  parsed: ParsedFile[];
  perRepo: Awaited<ReturnType<typeof loadPerRepoConfig>>;
  repoRoot: string;
  resolver: TsResolver;
  beaverRegistry: BeaverRegistry;
  localLibRegistry: LocalLibRegistry;
  globalPrimitiveNames: string[];
  thresholds: {
    reusableLocalFiles: number;
    substantialMarkupElements: number;
    codeSnippetMaxLines: number;
  };
}

async function classifyRepo(input: ClassifyRepoInput) {
  // Pass-A: build profiles for every file (components + their metadata).
  const profiles = new Map<string, ComponentProfile>();
  for (const parsed of input.parsed) {
    const fileProfiles = await buildProfilesForFile({
      parsed,
      resolver: input.resolver,
      beaverRegistry: input.beaverRegistry,
      codeSnippetMaxLines: input.thresholds.codeSnippetMaxLines,
    });
    for (const p of fileProfiles) {
      profiles.set(profileKey(p), p);
    }
  }

  // Pass-A: collect pre-classified + pending usages.
  const finalizedUsages: UsageRecord[] = [];
  const pending: PendingUsage[] = [];
  const unresolved: UnresolvedRecord[] = [];
  const warnings: Warning[] = [];
  for (const parsed of input.parsed) {
    const result = collectUsages({
      parsed,
      perRepo: input.perRepo,
      repoRoot: input.repoRoot,
      resolver: input.resolver,
      beaverRegistry: input.beaverRegistry,
      localLibRegistry: input.localLibRegistry,
    });
    for (const pre of result.preClassified) {
      if (pre.kind === 'finalized') finalizedUsages.push(pre.record);
      else pending.push(pre.pending);
    }
    unresolved.push(...result.unresolved);
    warnings.push(...result.warnings);
  }

  // Cross-file aggregation for `reusable-local` + ShadowComponentRecord fields.
  // Each pending points at `definingAbsPath` + `definingSymbol` → bump profile
  // counters keyed the same way.
  const counters = new Map<string, { files: Set<string>; count: number }>();
  for (const p of pending) {
    const key = profileKey({
      absPath: p.definingAbsPath,
      componentName: p.definingSymbol,
    });
    const bucket = counters.get(key);
    if (bucket) {
      bucket.files.add(p.importerAbsPath);
      bucket.count++;
    } else {
      counters.set(key, {
        files: new Set([p.importerAbsPath]),
        count: 1,
      });
    }
  }
  for (const [key, stats] of counters) {
    const profile = profiles.get(key);
    if (!profile) continue;
    profile.usageCount = stats.count;
    profile.filesUsedIn = stats.files.size;
  }

  const signalContext: SignalContext = {
    primitiveNames: new Set(
      input.perRepo.primitiveNamesOverride ?? input.globalPrimitiveNames,
    ),
    reusableLocalThreshold: input.thresholds.reusableLocalFiles,
    substantialMarkupThreshold: input.thresholds.substantialMarkupElements,
  };

  // Pass-B: apply Stage 6 Этап B to every pending usage.
  const { usages: classifiedUsages, shadowRecords } = classifyPass({
    pending,
    profiles,
    signalContext,
  });

  return {
    usages: [...finalizedUsages, ...classifiedUsages],
    shadowRecords,
    unresolved,
    warnings,
  };
}

function applyRoutes(
  usages: UsageRecord[],
  byFile: Map<string, { kind: 'bound'; path: string } | { kind: 'shared'; paths: string[] } | { kind: 'unmapped' }>,
  repoRoot: string,
): void {
  for (const u of usages) {
    const key = normalizePath(resolve(repoRoot, u.filePath));
    assignRoute(u, byFile.get(key));
  }
}

function applyRoutesToShadow(
  records: Array<{ filePath: string; signals: string[] }>,
  byFile: Map<string, { kind: 'bound'; path: string } | { kind: 'shared'; paths: string[] } | { kind: 'unmapped' }>,
  repoRoot: string,
): void {
  for (const record of records) {
    const key = normalizePath(resolve(repoRoot, record.filePath));
    const binding = byFile.get(key);
    if (binding?.kind === 'shared' && !record.signals.includes('multi-route')) {
      record.signals.push('multi-route');
    }
  }
}

function assignRoute(
  usage: UsageRecord,
  binding:
    | { kind: 'bound'; path: string }
    | { kind: 'shared'; paths: string[] }
    | { kind: 'unmapped' }
    | undefined,
): void {
  if (!binding) return;
  if (binding.kind === 'bound') {
    usage.route = { kind: 'bound', path: binding.path };
  } else if (binding.kind === 'shared') {
    usage.route = { kind: 'shared', paths: binding.paths };
  } else {
    usage.route = { kind: 'unmapped' };
  }
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
