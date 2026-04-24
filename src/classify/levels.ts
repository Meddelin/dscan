import type { ComponentProfile } from '../pipeline/profile.js';
import type { ShadowLevel } from '../types/dataset.js';
import type { ShadowSignal } from './signals.js';

/**
 * Level resolution per PRD §3.5.
 *
 *   confirmed: no Beaver-imports + primitive-like-name + substantial-markup.
 *   likely:    no Beaver-imports + (reusable-local OR multi-route), not confirmed.
 *   possible:  any other shadow signal fired.
 */
export function pickLevel(
  profile: ComponentProfile,
  signals: Set<ShadowSignal>,
): ShadowLevel | null {
  if (signals.size === 0) return null;

  const noBeaver = !profile.hasBeaverImport;

  if (
    noBeaver &&
    signals.has('primitive-like-name') &&
    signals.has('substantial-markup')
  ) {
    return 'confirmed';
  }

  if (noBeaver && signals.has('reusable-local')) {
    return 'likely';
  }

  return 'possible';
}
