import type { ComponentProfile } from '../pipeline/profile.js';

/**
 * Neither-heuristics (§5.3).
 * Applied BEFORE shadow signals: if a component name matches one of these,
 * it's `neither`/utility-heuristic regardless of markup or primitive-name.
 */
export interface NeitherMatch {
  code:
    | 'provider-context'
    | 'hook-like'
    | 'data-component'
    | 'layout-wrapper'
    | 'business-container';
}

export function matchNeither(profile: ComponentProfile): NeitherMatch | null {
  const n = profile.componentName;

  // provider-context / *Gate — no markup cap.
  if (/(Provider|Context|Gate)$/.test(n)) {
    return { code: 'provider-context' };
  }

  // hook-like: `use*` — unusual for a component name but we catch it honestly.
  if (/^use[A-Z]/.test(n)) {
    return { code: 'hook-like' };
  }

  // data-components with at most 2 JSX elements (§5.3).
  if (/(Query|Mutation|Fetcher|Loader|Data)$/.test(n)) {
    if (profile.jsxElementCount <= 2) return { code: 'data-component' };
  }

  // layout-wrappers with at most 3 JSX elements.
  if (/(Layout|Page|Template|Shell|Scaffold)$/.test(n)) {
    if (profile.jsxElementCount <= 3) return { code: 'layout-wrapper' };
  }

  // business containers — no markup cap.
  if (/(Container|Wrapper)$/.test(n)) {
    return { code: 'business-container' };
  }

  return null;
}
