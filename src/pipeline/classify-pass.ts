import { createHash } from 'node:crypto';
import type { ComponentProfile } from './profile.js';
import { profileKey } from './profile.js';
import type { PendingUsage } from './collect.js';
import { classifyLocal } from '../classify/classify-b.js';
import type { SignalContext } from '../classify/signals.js';
import type {
  ShadowComponentRecord,
  ShadowLevel,
  UsageRecord,
} from '../types/dataset.js';
import { SCHEMA_VERSION } from '../types/dataset.js';

export interface ClassifyPassInput {
  pending: PendingUsage[];
  profiles: Map<string, ComponentProfile>;
  signalContext: SignalContext;
}

export interface ClassifyPassOutput {
  usages: UsageRecord[];
  shadowRecords: ShadowComponentRecord[];
}

/**
 * Pass-B: resolve each PendingUsage via the profile map and apply Stage 6
 * Этап B (§4.6). Also emits one ShadowComponentRecord per distinct profile
 * whose bucket ends up being shadow (§6.1).
 *
 * Before calling: run.ts must have populated each profile's
 * `usageCount` / `filesUsedIn` through annotateCrossFileUsage (§5.1
 * reusable-local signal depends on it).
 */
export function classifyPass(input: ClassifyPassInput): ClassifyPassOutput {
  const usages: UsageRecord[] = [];
  const shadowByKey = new Map<string, ShadowComponentRecord>();

  for (const pending of input.pending) {
    const key = profileKey({
      absPath: pending.definingAbsPath,
      componentName: pending.definingSymbol,
    });
    const profile = input.profiles.get(key);

    let result: ReturnType<typeof classifyLocal>;
    if (profile) {
      result = classifyLocal(profile, input.signalContext);
    } else if (pending.localLibKind === 'fully-custom') {
      // Fully-custom local-library whose source isn't visible (e.g. installed
      // as an npm dep). Lands in M3 once local-lib prescan parses those
      // sources; until then, treat as shadow/possible per §3.3 (parallel UI).
      result = {
        bucket: 'shadow',
        classificationSource: 'parallel-local-ui',
        shadowLevel: 'possible',
        signals: [],
      };
    } else {
      // Component we can't profile (file failed to parse, or unresolved
      // relative import). Best-effort `neither` to avoid over-reporting.
      result = {
        bucket: 'neither',
        classificationSource: 'utility-heuristic',
        signals: [],
      };
    }

    const record: UsageRecord = {
      schemaVersion: SCHEMA_VERSION,
      kind: 'usage',
      repoId: pending.partial.repoId,
      filePath: pending.partial.filePath,
      line: pending.partial.line,
      column: pending.partial.column,
      componentName: pending.componentName,
      category: pending.partial.category,
      bucket: result.bucket,
      classificationSource: result.classificationSource,
      route: { kind: 'unsupported' },
      resolution: pending.partial.resolution,
    };
    if (result.shadowLevel !== undefined) {
      record.shadowLevel = result.shadowLevel;
    }
    if (pending.localLibId !== null) {
      record.localLibId = pending.localLibId;
      record.beaverBackedByLib = pending.localLibKind === 'partially-beaver-backed';
    }
    usages.push(record);

    if (result.bucket === 'shadow' && profile) {
      const existing = shadowByKey.get(key);
      if (!existing) {
        shadowByKey.set(
          key,
          buildShadowRecord(profile, result.shadowLevel ?? 'possible', result.signals),
        );
      }
    }
  }

  return { usages, shadowRecords: [...shadowByKey.values()] };
}

function buildShadowRecord(
  profile: ComponentProfile,
  level: ShadowLevel,
  signals: string[],
): ShadowComponentRecord {
  const directorySegments = profile.filePath
    .split('/')
    .slice(0, -1);
  const feature = directorySegments.find(
    (seg, i) => directorySegments[i - 1] === 'features',
  ) ?? null;

  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'shadow-component',
    repoId: profile.repoId,
    filePath: profile.filePath,
    componentName: profile.componentName,
    signature: {
      propNames: profile.propNames,
      jsxElementCount: profile.jsxElementCount,
      localImports: profile.localImports,
      beaverImports: profile.beaverImports,
      htmlTags: profile.htmlTags,
      usesStyled: profile.usesStyled,
    },
    pathHint: {
      directorySegments,
      feature,
    },
    codeSnippet: profile.codeSnippet,
    codeSnippetTruncated: profile.codeSnippetTruncated,
    beaverCandidateMapping: {
      candidatePackage: null,
      candidateComponent: null,
      confidence: null,
      source: null,
    },
    embedding: null,
    usageCount: profile.usageCount,
    filesUsedIn: profile.filesUsedIn,
    shadowLevel: level,
    signals,
  };
}

/**
 * Stable groupKey per §7.3 — used by aggregates to fold cross-repo shadow
 * components into a single row (Metric C.1). Heuristic in MVP; swapped for
 * embedding similarity in v2.
 */
export function shadowGroupKey(record: ShadowComponentRecord): string {
  const jsxBucket = bucketJsxCount(record.signature.jsxElementCount);
  const input = [
    record.componentName,
    record.signature.propNames.join(','),
    jsxBucket,
  ].join('|');
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function bucketJsxCount(count: number): string {
  if (count <= 2) return '0-2';
  if (count <= 4) return '3-4';
  if (count <= 9) return '5-9';
  if (count <= 19) return '10-19';
  return '20+';
}
