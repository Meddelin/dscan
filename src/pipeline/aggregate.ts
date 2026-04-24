import type {
  Aggregates,
  DatasetRecord,
  InvariantReport,
  ShadowByComponent,
  ShadowByFile,
  UsageRecord,
  Warning,
} from '../types/dataset.js';
import { SCHEMA_VERSION } from '../types/dataset.js';

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
 * Stage 8: Aggregate (§4.8 + §7).
 * MVP subset: metrics A, B, D, C (per-file + per-component heuristic grouping).
 * E (per-route) is emitted empty until Stage 7 lands.
 */
export function buildAggregates(input: AggregateInput): Aggregates {
  const usages = input.records.filter(
    (r): r is UsageRecord => r.kind === 'usage',
  );

  const globalAdoption = computeAdoption(usages);

  const perRepoAdoption = groupBy(usages, (u) => u.repoId).map(
    ([repoId, items]) => ({
      repoId,
      value: computeAdoption(items),
    }),
  );

  const beaverCoverage = computeBeaverCoverage(usages);

  const shadowLandscape = computeShadowLandscape(usages);

  const invariants = checkInvariants(input.records);

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

function computeShadowLandscape(usages: UsageRecord[]): {
  byFile: ShadowByFile[];
  byComponent: ShadowByComponent[];
} {
  const shadows = usages.filter((u) => u.bucket === 'shadow');

  // Per-file: group by (repoId + filePath + componentName)
  const fileGroups = new Map<
    string,
    {
      repoId: string;
      filePath: string;
      componentName: string;
      level: NonNullable<UsageRecord['shadowLevel']>;
      usageCount: number;
      filesUsedIn: Set<string>;
    }
  >();

  for (const u of shadows) {
    const key = `${u.repoId}::${u.filePath}::${u.componentName}`;
    const existing = fileGroups.get(key);
    if (existing) {
      existing.usageCount++;
      existing.filesUsedIn.add(u.filePath);
    } else {
      fileGroups.set(key, {
        repoId: u.repoId,
        filePath: u.filePath,
        componentName: u.componentName,
        level: u.shadowLevel ?? 'possible',
        usageCount: 1,
        filesUsedIn: new Set([u.filePath]),
      });
    }
  }

  const byFile: ShadowByFile[] = [...fileGroups.values()]
    .map((g) => ({
      repoId: g.repoId,
      filePath: g.filePath,
      componentName: g.componentName,
      level: g.level,
      signals: [],
      usageCount: g.usageCount,
      filesUsedIn: g.filesUsedIn.size,
      primaryRoute: { kind: 'unsupported' as const },
    }))
    .sort(
      (a, b) =>
        cmp(a.repoId, b.repoId) ||
        cmp(a.filePath, b.filePath) ||
        cmp(a.componentName, b.componentName),
    );

  // Per-component: group by componentName + level (MVP heuristic — signatures
  // require per-component AST analysis we don't have yet; see §7.3).
  const componentGroups = new Map<
    string,
    {
      componentName: string;
      level: NonNullable<UsageRecord['shadowLevel']>;
      repos: Set<string>;
      totalUsages: number;
      implementations: Array<{ repoId: string; filePath: string }>;
    }
  >();
  for (const f of byFile) {
    const key = `${f.componentName}::${f.level}`;
    const existing = componentGroups.get(key);
    if (existing) {
      existing.repos.add(f.repoId);
      existing.totalUsages += f.usageCount;
      existing.implementations.push({ repoId: f.repoId, filePath: f.filePath });
    } else {
      componentGroups.set(key, {
        componentName: f.componentName,
        level: f.level,
        repos: new Set([f.repoId]),
        totalUsages: f.usageCount,
        implementations: [{ repoId: f.repoId, filePath: f.filePath }],
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

function checkInvariants(records: DatasetRecord[]): InvariantReport {
  const violations: Array<{ code: string; message: string; count: number }> = [];
  const bump = (code: string, message: string): void => {
    const existing = violations.find((v) => v.code === code);
    if (existing) existing.count++;
    else violations.push({ code, message, count: 1 });
  };

  const usages = records.filter((r): r is UsageRecord => r.kind === 'usage');
  let checked = 0;

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
