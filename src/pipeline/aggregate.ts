import type {
  Aggregates,
  DatasetRecord,
  InvariantReport,
  ShadowByComponent,
  ShadowByFile,
  ShadowComponentRecord,
  ShadowLevel,
  UsageRecord,
  Warning,
} from '../types/dataset.js';
import { SCHEMA_VERSION } from '../types/dataset.js';
import { shadowGroupKey } from './classify-pass.js';

export interface AggregateInput {
  records: DatasetRecord[];
  warnings: Warning[];
  scannerVersion: string;
  scannedAt: string;
  scanDurationMs: number;
  beaverVersion: string;
  reposScanned: number;
  filesScanned: number;
}

/**
 * Stage 8 (§4.8 + §7).
 * MVP subset: metrics A, B, C (per-file + per-component via ShadowComponentRecord
 * + §7.3 hash groupKey), D. Metric E pending Stage 7 (M4).
 */
export function buildAggregates(input: AggregateInput): Aggregates {
  const usages = input.records.filter(
    (r): r is UsageRecord => r.kind === 'usage',
  );
  const shadowComponents = input.records.filter(
    (r): r is ShadowComponentRecord => r.kind === 'shadow-component',
  );

  const globalAdoption = computeAdoption(usages);

  const perRepoAdoption = groupBy(usages, (u) => u.repoId).map(
    ([repoId, items]) => ({
      repoId,
      value: computeAdoption(items),
    }),
  );

  const beaverCoverage = computeBeaverCoverage(usages);

  const shadowLandscape = computeShadowLandscape(shadowComponents);

  const invariants = checkInvariants(
    input.records,
    beaverCoverage,
    shadowLandscape.byFile,
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      scannerVersion: input.scannerVersion,
      scannedAt: input.scannedAt,
      scanDurationMs: input.scanDurationMs,
      beaverVersion: input.beaverVersion,
      reposScanned: input.reposScanned,
      filesScanned: input.filesScanned,
    },
    metrics: {
      globalAdoption: {
        value: globalAdoption,
        formula: 'adoption / (adoption + shadow)',
      },
      perRepoAdoption,
      shadowLandscape,
      beaverCoverage,
      perRouteAdoption: [],
      sharedComponentsAdoption: [],
    },
    invariants,
    warnings: input.warnings,
  };
}

function computeAdoption(usages: UsageRecord[]): number {
  let adoption = 0;
  let shadow = 0;
  for (const u of usages) {
    if (u.bucket === 'adoption') adoption++;
    else if (u.bucket === 'shadow') shadow++;
  }
  const denom = adoption + shadow;
  return denom === 0 ? 0 : adoption / denom;
}

function computeBeaverCoverage(
  usages: UsageRecord[],
): Array<{ package: string; reposUsing: number; instances: number }> {
  const byPackage = new Map<string, { repos: Set<string>; instances: number }>();
  for (const u of usages) {
    if (u.category !== 'beaver' || !u.beaverPackage) continue;
    const entry = byPackage.get(u.beaverPackage) ?? { repos: new Set(), instances: 0 };
    entry.repos.add(u.repoId);
    entry.instances++;
    byPackage.set(u.beaverPackage, entry);
  }
  return [...byPackage.entries()]
    .map(([pkg, { repos, instances }]) => ({
      package: pkg,
      reposUsing: repos.size,
      instances,
    }))
    .sort((a, b) => b.instances - a.instances || cmp(a.package, b.package));
}

function computeShadowLandscape(shadows: ShadowComponentRecord[]): {
  byFile: ShadowByFile[];
  byComponent: ShadowByComponent[];
} {
  const byFile: ShadowByFile[] = shadows
    .map((s) => ({
      repoId: s.repoId,
      filePath: s.filePath,
      componentName: s.componentName,
      level: s.shadowLevel,
      signals: s.signals,
      usageCount: s.usageCount,
      filesUsedIn: s.filesUsedIn,
      primaryRoute: { kind: 'unsupported' as const },
    }))
    .sort(
      (a, b) =>
        cmp(a.repoId, b.repoId) ||
        cmp(a.filePath, b.filePath) ||
        cmp(a.componentName, b.componentName),
    );

  // Per-component grouping (§7.3): hash by (name + sorted props + jsxCount bucket).
  const componentGroups = new Map<
    string,
    {
      componentName: string;
      level: ShadowLevel;
      repos: Set<string>;
      totalUsages: number;
      implementations: Array<{ repoId: string; filePath: string }>;
      signalsUnion: Set<string>;
    }
  >();
  for (const s of shadows) {
    const key = shadowGroupKey(s);
    const existing = componentGroups.get(key);
    if (existing) {
      existing.repos.add(s.repoId);
      existing.totalUsages += s.usageCount;
      existing.implementations.push({ repoId: s.repoId, filePath: s.filePath });
      for (const sig of s.signals) existing.signalsUnion.add(sig);
      // Level promotion: confirmed > likely > possible.
      existing.level = promoteLevel(existing.level, s.shadowLevel);
    } else {
      componentGroups.set(key, {
        componentName: s.componentName,
        level: s.shadowLevel,
        repos: new Set([s.repoId]),
        totalUsages: s.usageCount,
        implementations: [{ repoId: s.repoId, filePath: s.filePath }],
        signalsUnion: new Set(s.signals),
      });
    }
  }

  const byComponent: ShadowByComponent[] = [...componentGroups.entries()]
    .map(([groupKey, g]) => ({
      groupKey,
      componentName: g.componentName,
      level: g.level,
      reposCount: g.repos.size,
      totalUsages: g.totalUsages,
      implementations: g.implementations.sort(
        (a, b) => cmp(a.repoId, b.repoId) || cmp(a.filePath, b.filePath),
      ),
      candidateBeaverPackage: null,
    }))
    .sort(
      (a, b) =>
        b.totalUsages - a.totalUsages ||
        cmp(a.componentName, b.componentName),
    );

  return { byFile, byComponent };
}

const LEVEL_ORDER: Record<ShadowLevel, number> = {
  confirmed: 3,
  likely: 2,
  possible: 1,
};

function promoteLevel(a: ShadowLevel, b: ShadowLevel): ShadowLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b;
}

function checkInvariants(
  records: DatasetRecord[],
  beaverCoverage: Array<{ package: string; instances: number }>,
  shadowByFile: ShadowByFile[],
): InvariantReport {
  const violations: Array<{ code: string; message: string; count: number }> = [];
  const bump = (code: string, message: string): void => {
    const existing = violations.find((v) => v.code === code);
    if (existing) existing.count++;
    else violations.push({ code, message, count: 1 });
  };

  const usages = records.filter((r): r is UsageRecord => r.kind === 'usage');
  let checked = 0;

  let beaverUsages = 0;
  let shadowUsages = 0;

  for (const u of usages) {
    checked++;
    if (u.bucket === 'shadow' && u.shadowLevel === undefined) {
      bump(
        'shadow-level-consistency',
        'usage has bucket=shadow but shadowLevel missing (§10.1 #3)',
      );
    }
    if (u.bucket !== 'shadow' && u.shadowLevel !== undefined) {
      bump(
        'shadow-level-consistency',
        'usage has shadowLevel set but bucket !== shadow (§10.1 #3)',
      );
    }
    if (u.category === 'beaver' && !u.beaverPackage) {
      bump(
        'beaver-package-canonicalization',
        'category=beaver requires beaverPackage (§10.1 #4)',
      );
    }
    if (u.route === undefined) {
      bump('route-presence', 'usage missing route (§10.1 #7)');
    }
    if (u.schemaVersion !== SCHEMA_VERSION) {
      bump('schema-version-fixed', 'schemaVersion drift (§10.1 #6)');
    }
    if (u.category === 'beaver') beaverUsages++;
    if (u.bucket === 'shadow') shadowUsages++;
  }

  // Invariant #5 (§10.1): dataset completeness — aggregated sums must match
  // the dataset's own tallies. Decoupling point: if the aggregator drops
  // records, coverage/landscape will diverge from what lives in dataset.jsonl.
  const coverageInstanceSum = beaverCoverage.reduce(
    (sum, c) => sum + c.instances,
    0,
  );
  if (coverageInstanceSum !== beaverUsages) {
    bump(
      'dataset-completeness-beaver',
      `beaverCoverage total ${coverageInstanceSum} ≠ category=beaver usage count ${beaverUsages} (§10.1 #5)`,
    );
  }
  const shadowFileUsageSum = shadowByFile.reduce(
    (sum, f) => sum + f.usageCount,
    0,
  );
  if (shadowFileUsageSum !== shadowUsages) {
    bump(
      'dataset-completeness-shadow',
      `shadowLandscape byFile usage total ${shadowFileUsageSum} ≠ bucket=shadow usage count ${shadowUsages} (§10.1 #5)`,
    );
  }

  return {
    checked,
    failed: violations.reduce((sum, v) => sum + v.count, 0),
    violations,
  };
}

function groupBy<T, K>(items: T[], keyFn: (t: T) => K): Array<[K, T[]]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return [...map.entries()].sort(([a], [b]) => cmp(String(a), String(b)));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
