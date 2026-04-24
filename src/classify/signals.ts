import type { ComponentProfile } from '../pipeline/profile.js';

/**
 * Shadow signals enumerated in PRD §5.1.
 * `multi-route` is intentionally absent — lands in M4 (requires Stage 7).
 */
export type ShadowSignal =
  | 'wraps-with-customization'
  | 'standalone-styled'
  | 'primitive-like-name'
  | 'substantial-markup'
  | 'reusable-local'
  | 'parallel-layer';

export interface SignalContext {
  primitiveNames: Set<string>;
  reusableLocalThreshold: number;
  substantialMarkupThreshold: number;
}

export function detectSignals(
  profile: ComponentProfile,
  ctx: SignalContext,
): ShadowSignal[] {
  const out: ShadowSignal[] = [];

  if (profile.passesClassNameToBeaver || profile.wrapsBeaverWithStyled) {
    out.push('wraps-with-customization');
  }

  if (profile.usesStyled && !profile.hasBeaverImport) {
    out.push('standalone-styled');
  }

  if (ctx.primitiveNames.has(profile.componentName)) {
    out.push('primitive-like-name');
  }

  if (profile.jsxElementCount >= ctx.substantialMarkupThreshold) {
    out.push('substantial-markup');
  }

  if (profile.filesUsedIn >= ctx.reusableLocalThreshold) {
    out.push('reusable-local');
  }

  if (inParallelLayerDir(profile.filePath)) {
    out.push('parallel-layer');
  }

  return out;
}

const PARALLEL_LAYER_SEGMENTS = new Set([
  'ui',
  'components/ui',
  'shared/ui',
  'kit',
]);

function inParallelLayerDir(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const parts = normalized.split('/');
  for (const seg of PARALLEL_LAYER_SEGMENTS) {
    if (seg.includes('/')) {
      const pieces = seg.split('/');
      for (let i = 0; i + pieces.length <= parts.length; i++) {
        let hit = true;
        for (let j = 0; j < pieces.length; j++) {
          if (parts[i + j] !== pieces[j]) {
            hit = false;
            break;
          }
        }
        if (hit) return true;
      }
    } else if (parts.includes(seg)) {
      return true;
    }
  }
  return false;
}
