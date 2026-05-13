import { describe, it, expect } from 'vitest';
import { generateRecommendations } from '../src/pipeline/recommendations.js';
import type { Aggregates, ShadowByComponent } from '../src/types/dataset.js';

const CONFIG = {
  addToBeaverMinRepos: 3,
  outreachMaxAdoption: 0.3,
  promotePackageMaxReposRatio: 0.1,
  maxRecommendations: 12,
};

function shadowGroup(overrides: Partial<ShadowByComponent>): ShadowByComponent {
  return {
    groupKey: 'g' + Math.random().toString(36).slice(2, 8),
    componentName: 'X',
    level: 'possible',
    reposCount: 1,
    totalUsages: 1,
    implementations: [],
    candidateBeaverPackage: null,
    ...overrides,
  };
}

function emptyMetrics(): Aggregates['metrics'] {
  return {
    globalAdoption: { value: 0, formula: '' },
    perRepoAdoption: [],
    shadowLandscape: { byFile: [], byComponent: [] },
    beaverCoverage: [],
    perRouteAdoption: [],
    sharedComponentsAdoption: [],
    bucketDistribution: { adoption: 0, shadow: 0, neither: 0 },
  };
}

describe('generateRecommendations', () => {
  it('emits add-to-beaver for shadow groups in ≥ N repos', () => {
    const metrics = emptyMetrics();
    metrics.shadowLandscape.byComponent = [
      shadowGroup({
        componentName: 'Card',
        reposCount: 8,
        totalUsages: 40,
        level: 'confirmed',
      }),
      shadowGroup({
        componentName: 'NotEnoughRepos',
        reposCount: 2,
        totalUsages: 5,
      }),
    ];
    const recs = generateRecommendations(
      metrics,
      { reposScanned: 100 },
      CONFIG,
    );
    const add = recs.filter((r) => r.kind === 'add-to-beaver');
    expect(add).toHaveLength(1);
    expect(add[0]!.title).toContain('Card');
    expect(add[0]!.priority).toBe('high'); // 8 ≥ 3*2
  });

  it('emits outreach when repos below adoption threshold exist', () => {
    const metrics = emptyMetrics();
    metrics.perRepoAdoption = [
      { repoId: 'low-a', value: 0.1 },
      { repoId: 'low-b', value: 0.2 },
      { repoId: 'low-c', value: 0.25 },
      { repoId: 'ok', value: 0.7 },
    ];
    const recs = generateRecommendations(
      metrics,
      { reposScanned: 4 },
      CONFIG,
    );
    const out = recs.filter((r) => r.kind === 'outreach');
    expect(out).toHaveLength(1);
    expect(out[0]!.rationale).toContain('low-a');
    expect(out[0]!.evidence.repoIds).toEqual(['low-a', 'low-b', 'low-c']);
  });

  it('emits promote-package for under-used Beaver pkgs', () => {
    const metrics = emptyMetrics();
    metrics.beaverCoverage = [
      { package: '@beaver-ui/wide', reposUsing: 80, instances: 1000 },
      { package: '@beaver-ui/niche', reposUsing: 3, instances: 7 },
    ];
    const recs = generateRecommendations(
      metrics,
      { reposScanned: 100 },
      CONFIG,
    );
    const promote = recs.filter((r) => r.kind === 'promote-package');
    expect(promote).toHaveLength(1);
    expect(promote[0]!.evidence.packages).toEqual(['@beaver-ui/niche']);
  });

  it('emits tune-thresholds when possible >> confirmed', () => {
    const metrics = emptyMetrics();
    metrics.shadowLandscape.byComponent = [
      ...Array.from({ length: 10 }, () =>
        shadowGroup({ level: 'possible' }),
      ),
      shadowGroup({ level: 'confirmed' }),
    ];
    const recs = generateRecommendations(
      metrics,
      { reposScanned: 50 },
      CONFIG,
    );
    expect(recs.some((r) => r.kind === 'tune-thresholds')).toBe(true);
  });

  it('respects maxRecommendations cap', () => {
    const metrics = emptyMetrics();
    metrics.shadowLandscape.byComponent = Array.from({ length: 20 }, (_, i) =>
      shadowGroup({
        componentName: `Comp${i}`,
        reposCount: 5,
        totalUsages: 20 - i,
      }),
    );
    const recs = generateRecommendations(
      metrics,
      { reposScanned: 100 },
      { ...CONFIG, maxRecommendations: 3 },
    );
    expect(recs.length).toBeLessThanOrEqual(3);
  });

  it('returns empty when nothing to suggest', () => {
    const recs = generateRecommendations(
      emptyMetrics(),
      { reposScanned: 0 },
      CONFIG,
    );
    expect(recs).toEqual([]);
  });
});
