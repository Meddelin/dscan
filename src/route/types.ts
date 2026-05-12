/**
 * Types shared between route discovery, page extraction, and import-graph
 * binding. See PRD §4.7.
 */
export interface DiscoveredRouteConfig {
  /** Absolute path of the file hosting the route array. */
  configFile: string;
  /** All top-level route entries parsed from the config. */
  entries: RouteEntry[];
}

/**
 * One route entry from a RouteObject-like tree. Paths are already joined
 * with any enclosing parent paths per §4.7.2. `pageComponent` is null when
 * the entry is purely structural (e.g. a layout route) or dynamic.
 */
export interface RouteEntry {
  /** Full joined path, e.g. `/checkout/payment`. Leading slash normalised. */
  path: string;
  /** Repo-relative path of the file that hosts this route entry. */
  configFilePath: string;
  /** Absolute path of the file that hosts this route entry. */
  configAbsPath: string;
  /**
   * Absolute path to the file defining the page component.
   * Null when `element`/`lazy`/`Component` can't be statically resolved
   * (dynamic, HOC, external HOC). The route still counts for structural
   * completeness but does not anchor any import-graph binding.
   */
  pageComponentFile: string | null;
  /**
   * Symbol name as declared in the page component file. Null when the
   * component is anonymous (default export of a lazy chunk). Used only as
   * a diagnostic — reachability is driven by file, not symbol.
   */
  pageComponentSymbol: string | null;
  /** Non-fatal problems: dynamic path, non-resolvable element, etc. */
  warnings: string[];
}

export interface RouteWarning {
  /** Repo-relative path of the route-config file that emitted this warning. */
  filePath: string;
  /** Absolute path of the same file — for IDE navigation. */
  absPath: string;
  /** Joined route path, if applicable (else empty string). */
  routePath: string;
  /** Short, machine-style code (e.g. "page-not-imported", "dynamic-path-skipped"). */
  code: string;
  /** Human-readable detail. */
  message: string;
}

export interface RouteResolution {
  /** Map: absolute file path → its route binding. Forward-slashed, lowercased. */
  byFile: Map<string, FileRouteBinding>;
  /** All discovered routes (diagnostic; not required for binding). */
  entries: RouteEntry[];
  /** Non-fatal warnings emitted during resolution, with full file context. */
  warnings: RouteWarning[];
}

export type FileRouteBinding =
  | { kind: 'bound'; path: string }
  | { kind: 'shared'; paths: string[] }
  | { kind: 'unmapped' };
