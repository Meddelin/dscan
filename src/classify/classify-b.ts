import type { ComponentProfile } from '../pipeline/profile.js';
import type {
  Bucket,
  ClassificationSource,
  ShadowLevel,
} from '../types/dataset.js';
import { matchNeither } from './neither.js';
import { detectSignals, type ShadowSignal, type SignalContext } from './signals.js';
import { pickLevel } from './levels.js';

/**
 * Stage 6 Этап B (§4.6) — orchestrator for local and fully-custom
 * local-library components.
 *
 * Priority order (no guard between branches; each branch returns early):
 *   1. Neither-heuristics (§5.3) — applied first, before shadow signals.
 *   2. Component imports Beaver + passes className/style/styled() → shadow
 *      (wraps-with-customization).
 *   3. Component imports Beaver, no customization, markup < threshold →
 *      adoption / beaver-composition (adoption-wrapper, §3.6).
 *   4. Component imports Beaver, markup ≥ threshold → shadow (substantial).
 *   5. No Beaver imports, any shadow signal fires → shadow / parallel-local-ui
 *      with level from §3.5.
 *   6. Default → neither.
 */
export interface ClassifyBResult {
  bucket: Bucket;
  classificationSource: ClassificationSource;
  shadowLevel?: ShadowLevel;
  signals: ShadowSignal[];
}

export function classifyLocal(
  profile: ComponentProfile,
  ctx: SignalContext,
): ClassifyBResult {
  // 1. Neither heuristics first (§5.3).
  if (matchNeither(profile)) {
    return {
      bucket: 'neither',
      classificationSource: 'utility-heuristic',
      signals: [],
    };
  }

  const signals = detectSignals(profile, ctx);
  const signalSet = new Set(signals);

  // 2 + 3 + 4: component imports Beaver — apply Adoption-wrapper vs shadow rules.
  if (profile.hasBeaverImport) {
    if (signalSet.has('wraps-with-customization')) {
      return {
        bucket: 'shadow',
        classificationSource: 'wraps-with-customization',
        shadowLevel: 'possible',
        signals,
      };
    }
    if (signalSet.has('substantial-markup')) {
      return {
        bucket: 'shadow',
        classificationSource: 'wraps-with-customization',
        shadowLevel: 'possible',
        signals,
      };
    }
    // Adoption-wrapper path (§3.6): wraps Beaver, no customisation, small markup.
    return {
      bucket: 'adoption',
      classificationSource: 'beaver-composition',
      signals,
    };
  }

  // 5. No Beaver imports — classical shadow detection.
  if (signalSet.size > 0) {
    const level = pickLevel(profile, signalSet) ?? 'possible';
    return {
      bucket: 'shadow',
      classificationSource: 'parallel-local-ui',
      shadowLevel: level,
      signals,
    };
  }

  // 6. Default.
  return {
    bucket: 'neither',
    classificationSource: 'utility-heuristic',
    signals: [],
  };
}
