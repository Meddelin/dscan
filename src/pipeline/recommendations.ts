import type {
  Aggregates,
  Recommendation,
  ShadowByComponent,
} from '../types/dataset.js';

export interface RecommendationConfig {
  addToBeaverMinRepos: number;
  outreachMaxAdoption: number;
  promotePackageMaxReposRatio: number;
  maxRecommendations: number;
}

/**
 * Snapshot-only recommendation generation. Reads aggregated metrics that
 * are already computed, applies operator-configurable thresholds, returns
 * a prioritised list. Deltas vs. previous scan land in a follow-up.
 *
 * Priority logic is intentionally simple — we'd rather under-suggest than
 * spam. Tune thresholds in `recommendations.*` config block (defaults in
 * `src/config/schema.ts`).
 */
export function generateRecommendations(
  metrics: Aggregates['metrics'],
  meta: Pick<Aggregates['meta'], 'reposScanned'>,
  config: RecommendationConfig,
): Recommendation[] {
  const out: Recommendation[] = [];

  // 1. ADD TO BEAVER — shadow groups that span many repos.
  const addCandidates = [...metrics.shadowLandscape.byComponent]
    .filter((g) => g.reposCount >= config.addToBeaverMinRepos)
    .sort(
      (a, b) =>
        b.reposCount * b.totalUsages - a.reposCount * a.totalUsages ||
        b.totalUsages - a.totalUsages,
    );
  for (const g of addCandidates.slice(0, 5)) {
    out.push({
      kind: 'add-to-beaver',
      priority: prioritizeAddToBeaver(g, config),
      title: `Добавить в Beaver: ${g.componentName}`,
      rationale: ruRationaleAdd(g),
      evidence: { shadowGroupKeys: [g.groupKey] },
    });
  }

  // 2. OUTREACH — repos with adoption below threshold.
  const lowRepos = [...metrics.perRepoAdoption]
    .filter((r) => r.value < config.outreachMaxAdoption)
    .sort((a, b) => a.value - b.value);
  if (lowRepos.length > 0) {
    const sample = lowRepos.slice(0, 3).map((r) => r.repoId).join(', ');
    out.push({
      kind: 'outreach',
      priority: lowRepos.length >= 3 ? 'high' : 'medium',
      title: `Outreach: ${lowRepos.length} ${ruRepoPlural(lowRepos.length)} с adoption < ${
        Math.round(config.outreachMaxAdoption * 100)
      }%`,
      rationale:
        `Самые низкие: ${sample}${lowRepos.length > 3 ? ` (+${lowRepos.length - 3} ещё)` : ''}. ` +
        `Pre-pilot этим командам стоит первыми показать чем Beaver удобнее ` +
        `их текущего стека.`,
      evidence: { repoIds: lowRepos.map((r) => r.repoId) },
    });
  }

  // 3. PROMOTE PACKAGE — Beaver pkgs used in fewer than X% of repos.
  if (meta.reposScanned > 0) {
    const promoteThreshold = Math.max(
      1,
      Math.floor(meta.reposScanned * config.promotePackageMaxReposRatio),
    );
    const underused = [...metrics.beaverCoverage]
      .filter((p) => p.reposUsing > 0 && p.reposUsing < promoteThreshold)
      .sort((a, b) => a.reposUsing - b.reposUsing);
    if (underused.length > 0) {
      const sample = underused.slice(0, 3).map((p) => `\`${p.package}\``).join(', ');
      out.push({
        kind: 'promote-package',
        priority: 'low',
        title: `Промоушн ${underused.length} ${ruPackagePlural(underused.length)} Beaver`,
        rationale:
          `Используется в < ${Math.round(config.promotePackageMaxReposRatio * 100)}% ` +
          `сканированных репо: ${sample}. Возможно, нужна evangelism — внутренний `+
          `tech-talk или примеры использования в onboarding-документации.`,
        evidence: { packages: underused.map((p) => p.package) },
      });
    }
  }

  // 4. TUNE THRESHOLDS — high count of low-confidence shadows ("possible"
  //    dominates) suggests detection is noisy. Operator should tune
  //    primitiveNames / substantialMarkupElements per FP review.
  const possibleCount = metrics.shadowLandscape.byComponent.filter(
    (g) => g.level === 'possible',
  ).length;
  const confirmedCount = metrics.shadowLandscape.byComponent.filter(
    (g) => g.level === 'confirmed',
  ).length;
  if (possibleCount > 0 && possibleCount > confirmedCount * 3) {
    out.push({
      kind: 'tune-thresholds',
      priority: 'medium',
      title: `Тюнинг порогов: ${possibleCount} possible vs ${confirmedCount} confirmed`,
      rationale:
        `Доля «possible» уровней shadow велика — детекция шумит. После 50-компонентного ` +
        `FP-review (PRD §10.3) подними substantialMarkupElements или сузь primitiveNames per-repo.`,
      evidence: {},
    });
  }

  // Sort by priority + cap.
  return out
    .sort((a, b) => priorityWeight(a.priority) - priorityWeight(b.priority))
    .slice(0, config.maxRecommendations);
}

function prioritizeAddToBeaver(
  group: ShadowByComponent,
  config: RecommendationConfig,
): Recommendation['priority'] {
  if (group.reposCount >= config.addToBeaverMinRepos * 2) return 'high';
  if (group.level === 'confirmed') return 'high';
  if (group.level === 'likely') return 'medium';
  return 'low';
}

function priorityWeight(p: Recommendation['priority']): number {
  return p === 'high' ? 0 : p === 'medium' ? 1 : 2;
}

function ruRationaleAdd(g: ShadowByComponent): string {
  return (
    `Переизобретён в ${g.reposCount} ${ruRepoPlural(g.reposCount)} (${g.totalUsages} ` +
    `${ruUsagePlural(g.totalUsages)}, уровень ${ruLevelLabel(g.level)}). ` +
    `Один компонент в Beaver сэкономит ${g.totalUsages} миграций.`
  );
}

function ruLevelLabel(level: 'confirmed' | 'likely' | 'possible'): string {
  return level === 'confirmed'
    ? 'confirmed'
    : level === 'likely'
      ? 'likely'
      : 'possible';
}

function ruRepoPlural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'репо';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'репо';
  return 'репо'; // "репо" indeclinable in this register
}

function ruUsagePlural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `usage`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `usage'я`;
  return `usage'ей`;
}

function ruPackagePlural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'пакета';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'пакетов';
  return 'пакетов';
}
