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
import {
  prescanLibraries,
  resolveLibraries,
  mergeLibraries,
  mergeRegistries,
  type ResolvedLibrary,
} from '../prescan/local-lib.js';
import { gitClone, isGitRepo } from '../ops/git.js';
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
  /**
   * Override `output.dir` from the config — used by `ds-scanner analyze
   * --output <dir>`. Resolved relative to CWD when not absolute.
   */
  outputDir?: string;
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

  const rawOutput = opts.outputDir ?? config.output.dir;
  const outputDir = isAbsolute(rawOutput)
    ? rawOutput
    : resolve(opts.outputDir ? process.cwd() : configDir, rawOutput);
  await mkdir(outputDir, { recursive: true });

  const cacheDir = resolve(configDir, '.cache/beaver-ui');
  const beaverRegistry = await prescanBeaver({
    beaverUrl: config.beaverUrl,
    cacheDir,
  });

  // sharedLibraries are declared once in global config; scan their sources
  // here, before the per-repo loop. Path is resolved relative to configDir
  // so the same declaration applies to every consumer.
  const sharedResolved = resolveLibraries(
    config.sharedLibraries,
    configDir,
    'shared',
  );
  const sharedRegistry = await prescanLibraries(
    sharedResolved,
    configDir,
    beaverRegistry,
    'tsconfig.json',
  );

  const allRecords: DatasetRecord[] = [];
  const allWarnings: Warning[] = [];
  let filesScanned = 0;

  for (const repo of repositories) {
    const repoId = repoIdFor(repo);
    const repoRoot = await resolveRepoRoot(repo, configDir);
    const perRepo = await loadPerRepoConfig(repoRoot, repo.config);
    const resolver = await createTsResolver(repoRoot, perRepo.tsconfig);

    // Build the effective library list: per-repo localLibraries override
    // sharedLibraries on libId conflict, then we prescan the per-repo ones
    // and merge with the already-scanned shared registry.
    const perRepoResolved = resolveLibraries(
      perRepo.localLibraries,
      repoRoot,
      'repo',
    );
    const effectiveLibraries: ResolvedLibrary[] = mergeLibraries(
      sharedResolved,
      perRepoResolved,
    );
    const perRepoLibRegistry = await prescanLibraries(
      perRepoResolved,
      repoRoot,
      beaverRegistry,
      perRepo.tsconfig,
    );
    const localLibRegistry = mergeRegistries(sharedRegistry, perRepoLibRegistry);

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
      effectiveLibraries,
      globalPrimitiveNames: config.primitiveNames ?? DEFAULT_PRIMITIVE_NAMES,
      thresholds: config.thresholds,
    });

    // Stage 7: route resolution (§4.7). Opt-out via global/per-repo config;
    // if no router config found in the repo, every usage stays `unsupported`.
    const routeEnabled =
      (perRepo.routeResolution?.enabled ?? config.routeResolution?.enabled ?? true) !==
      false;
    if (routeEnabled) {
      const resolution = await resolveRoutes({
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
            filePath: w.filePath,
            absPath: w.absPath,
            code: 'route-resolution-warning',
            message: `[${w.code}] route ${w.routePath}: ${w.message}`,
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
    recommendationConfig: config.recommendations,
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
  effectiveLibraries: ResolvedLibrary[];
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

  // Barrel aliasing: `export { X } from './X'` in an index.ts means a
  // consumer that imports X from './kit' resolves to the barrel's path,
  // not X's definition file. Copy the profile entry under the barrel's
  // absolute path so Pass-B lookups succeed regardless of which file
  // the import resolves into.
  aliasBarrelProfiles(input.parsed, input.resolver, profiles);

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
      effectiveLibraries: input.effectiveLibraries,
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
  // Aliasing (`aliasBarrelProfiles` + `export *` fixpoint below) registers
  // ONE ComponentProfile under multiple keys (`kit/index.ts::Foo` AND
  // `kit/Foo.tsx::Foo`). If pendings hit different keys but the same
  // profile object, a naive `profile.usageCount = stats.count` overwrites
  // the previous write — losing usages and breaking invariant #5
  // (dataset-completeness-shadow). Accumulate by object identity:
  const perProfile = new Map<
    ComponentProfile,
    { files: Set<string>; count: number }
  >();
  for (const [key, stats] of counters) {
    const profile = profiles.get(key);
    if (!profile) continue;
    const cur = perProfile.get(profile);
    if (cur) {
      cur.count += stats.count;
      for (const f of stats.files) cur.files.add(f);
    } else {
      perProfile.set(profile, {
        count: stats.count,
        files: new Set(stats.files),
      });
    }
  }
  for (const [profile, totals] of perProfile) {
    profile.usageCount = totals.count;
    profile.filesUsedIn = totals.files.size;
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

const BARREL_ALIAS_FIXPOINT_LIMIT = 5;

/**
 * Register profiles under the barrel paths that re-export them. Required so
 * `import { Foo } from './kit'` (resolved to `kit/index.ts`) finds the same
 * profile that `import { Foo } from './kit/Foo'` would.
 *
 * Handles three forms:
 *   - `export { Foo } from './foo'`          — explicit named
 *   - `export { default as Foo } from './foo'` — default-renamed
 *   - `export * from './foo'`                  — every named export of foo
 *
 * Chained barrels (barrel1 → barrel2 → source) need a fixed-point pass
 * because a single sweep only sees aliases that already exist at iteration
 * time. We loop until no new aliases land or we hit the depth cap.
 */
function aliasBarrelProfiles(
  parsed: ParsedFile[],
  resolver: TsResolver,
  profiles: Map<string, ComponentProfile>,
): void {
  for (let pass = 0; pass < BARREL_ALIAS_FIXPOINT_LIMIT; pass++) {
    // Build absPath → (componentName → profile) per pass. We index by the
    // MAP KEY's absPath segment (not `profile.absPath`), so previously-added
    // aliases show up under the barrel file they were registered at. That's
    // what makes chained barrels work: kit/index.ts uses `export *` from
    // kit/widgets/index.ts; on pass N+1 we need kit/widgets/index.ts to
    // *appear* as a profile source even though no profile was originally
    // defined there.
    const profilesByFile = new Map<string, Map<string, ComponentProfile>>();
    for (const [key, profile] of profiles) {
      const splitIdx = key.lastIndexOf('::');
      if (splitIdx === -1) continue;
      const absLow = key.slice(0, splitIdx);
      const name = key.slice(splitIdx + 2);
      const list = profilesByFile.get(absLow) ?? new Map();
      list.set(name, profile);
      profilesByFile.set(absLow, list);
    }

    let added = 0;

    for (const file of parsed) {
      for (const node of file.ast.body) {
        if (node.type === 'ExportNamedDeclaration' && node.source) {
          const resolved = resolver.resolve(node.source.value, file.file.absPath);
          if (resolved.kind !== 'in-repo') continue;
          for (const spec of node.specifiers) {
            if (spec.type !== 'ExportSpecifier') continue;
            const localSymbol =
              spec.local.type === 'Identifier' ? spec.local.name : null;
            const exportedSymbol =
              spec.exported.type === 'Identifier' ? spec.exported.name : null;
            if (!localSymbol || !exportedSymbol) continue;
            const sourceKey = profileKey({
              absPath: resolved.absPath,
              componentName: localSymbol,
            });
            const profile = profiles.get(sourceKey);
            if (!profile) continue;
            const aliasKey = profileKey({
              absPath: file.file.absPath,
              componentName: exportedSymbol,
            });
            if (!profiles.has(aliasKey)) {
              profiles.set(aliasKey, profile);
              added++;
            }
          }
        } else if (
          node.type === 'ExportAllDeclaration' &&
          typeof node.source.value === 'string' &&
          // `export * as NS from './foo'` is namespace re-export, not a
          // fan-out — we don't expand it. Only bare `export * from`.
          node.exported === null
        ) {
          const resolved = resolver.resolve(node.source.value, file.file.absPath);
          if (resolved.kind !== 'in-repo') continue;
          const targetKey = resolved.absPath.replace(/\\/g, '/').toLowerCase();
          const targetProfiles = profilesByFile.get(targetKey);
          if (!targetProfiles) continue;
          for (const [name, profile] of targetProfiles) {
            // `export *` doesn't propagate default exports.
            if (name === 'default') continue;
            const aliasKey = profileKey({
              absPath: file.file.absPath,
              componentName: name,
            });
            if (!profiles.has(aliasKey)) {
              profiles.set(aliasKey, profile);
              added++;
            }
          }
        }
      }
    }

    if (added === 0) break;
  }
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
  // Otherwise clone into `.cache/repos/<repoId>` (§8.1).
  const repoId = repoIdFor(repo);
  const cacheDir = resolve(configDir, '.cache/repos', repoId);
  if (await isGitRepo(cacheDir)) {
    return cacheDir;
  }
  // Fail-fast per §8.3: no retry on clone failure.
  await gitClone(repo.gitUrl, cacheDir, {
    depth: 1,
    singleBranch: true,
  });
  return cacheDir;
}
