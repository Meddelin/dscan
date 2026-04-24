/**
 * Output of Stage 5a — Beaver prescan (§4.5).
 * Built once per scan and passed to categorize / classify.
 */
export interface BeaverRegistry {
  /** Human-readable Beaver version (tag or short SHA via `git describe`). */
  version: string;

  /** Absolute path to the Beaver checkout root (local or cloned). */
  rootPath: string;

  /** Every Beaver package name (e.g. `@beaver-ui/button`). */
  packages: Set<string>;

  /**
   * Direct exports per package: package → set of exported symbol names.
   * Source: `packages/<pkg>/src/index.ts` own `export { ... }` declarations
   * (non-re-export).
   */
  exports: Map<string, Set<string>>;

  /**
   * Re-export map keyed by aggregator-ish source package. For each symbol the
   * map tells where it ultimately originates. Flat — no chain, already resolved.
   *
   * Example: `@beaver-ui/components` re-exports `Button` from `@beaver-ui/button`.
   *   reExports.get('@beaver-ui/components').get('Button')
   *     → { sourcePackage: '@beaver-ui/button', sourceSymbol: 'Button' }
   */
  reExports: Map<string, Map<string, ReExportEntry>>;

  /** Packages we walked but could not fully resolve (depth limit, cycle). */
  unresolvedPackages: string[];
}

export interface ReExportEntry {
  sourcePackage: string;
  sourceSymbol: string;
  /** How many re-export hops it took. 0 = direct export of the package. */
  hops: number;
}

/**
 * Output of local-library prescan (§4.5). MVP only has local-path source.
 * Built in M3 — this type is a forward declaration so categorize can depend
 * on it without churn.
 */
export interface LocalLibRegistry {
  /** libId → (componentName → isBeaverBacked). */
  byLib: Map<string, Map<string, boolean>>;
  /** libIds for which prescan failed (disk missing, parse errors). */
  prescanFailed: string[];
}
