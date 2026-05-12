export const SCHEMA_VERSION = '1.1' as const;

export type StructuralCategory =
  | 'html-native'
  | 'beaver'
  | 'local'
  | 'local-library'
  | 'third-party';

export type Bucket = 'adoption' | 'shadow' | 'neither';

export type ShadowLevel = 'confirmed' | 'likely' | 'possible';

export type ClassificationSource =
  | 'direct-beaver'
  | 'beaver-backed-wrapper'
  | 'beaver-composition'
  | 'wraps-with-customization'
  | 'parallel-local-ui'
  | 'utility-heuristic'
  | 'unresolved-dynamic';

export type Route =
  | { kind: 'bound'; path: string }
  | { kind: 'shared'; paths: string[] }
  | { kind: 'unmapped' }
  | { kind: 'unsupported' };

export type Resolution = 'static' | 'dynamic-branch';

export interface UsageRecord {
  schemaVersion: '1.1';
  kind: 'usage';
  repoId: string;
  filePath: string;
  line: number;
  column: number;
  componentName: string;
  category: StructuralCategory;
  bucket: Bucket;
  shadowLevel?: ShadowLevel;
  classificationSource: ClassificationSource;
  beaverPackage?: string;
  canonicalizedVia?: string;
  localLibId?: string;
  beaverBackedByLib?: boolean;
  route: Route;
  resolution: Resolution;
}

export interface ShadowComponentRecord {
  schemaVersion: '1.1';
  kind: 'shadow-component';
  repoId: string;
  filePath: string;
  componentName: string;
  signature: {
    propNames: string[];
    jsxElementCount: number;
    localImports: string[];
    beaverImports: string[];
    htmlTags: string[];
    usesStyled: boolean;
  };
  pathHint: {
    directorySegments: string[];
    feature: string | null;
  };
  codeSnippet: string;
  codeSnippetTruncated: boolean;
  beaverCandidateMapping: {
    candidatePackage: string | null;
    candidateComponent: string | null;
    confidence: number | null;
    source: 'manual' | 'llm-embedding' | 'llm-reasoning' | null;
  };
  embedding: number[] | null;
  usageCount: number;
  filesUsedIn: number;
  shadowLevel: ShadowLevel;
  signals: string[];
}

export type UnresolvedReason =
  | 'lookup-by-string'
  | 'member-expression-not-supported'
  | 'external-hoc'
  | 'spread-component'
  | 'nested-ternary'
  | 'if-else-branch'
  | 'switch-branch';

export interface UnresolvedRecord {
  schemaVersion: '1.1';
  kind: 'unresolved-dynamic';
  repoId: string;
  filePath: string;
  line: number;
  reason: UnresolvedReason;
  context: string;
}

export type DatasetRecord = UsageRecord | ShadowComponentRecord | UnresolvedRecord;

export interface Warning {
  repoId?: string;
  /** Repo-relative, forward-slashed. Stable across machines — good for BI. */
  filePath?: string;
  /**
   * Absolute path on the operator's filesystem. Same file as {@link filePath}
   * but prefixed with the local repo checkout. Use this in IDEs / from the
   * CLI for one-click navigation; ignore it in BI / cross-machine pipelines.
   */
  absPath?: string;
  code: string;
  message: string;
}

export interface InvariantReport {
  checked: number;
  failed: number;
  violations: Array<{ code: string; message: string; count: number }>;
}

export interface ShadowByFile {
  repoId: string;
  filePath: string;
  componentName: string;
  level: ShadowLevel;
  signals: string[];
  usageCount: number;
  filesUsedIn: number;
  primaryRoute: Route;
}

export interface ShadowByComponent {
  groupKey: string;
  componentName: string;
  level: ShadowLevel;
  reposCount: number;
  totalUsages: number;
  implementations: Array<{ repoId: string; filePath: string }>;
  candidateBeaverPackage: string | null;
}

export interface Aggregates {
  schemaVersion: '1.1';
  meta: {
    scannerVersion: string;
    scannedAt: string;
    scanDurationMs: number;
    beaverVersion: string;
    reposScanned: number;
    filesScanned: number;
  };
  metrics: {
    globalAdoption: { value: number; formula: string };
    perRepoAdoption: Array<{ repoId: string; value: number }>;
    shadowLandscape: {
      byFile: ShadowByFile[];
      byComponent: ShadowByComponent[];
    };
    beaverCoverage: Array<{
      package: string;
      reposUsing: number;
      instances: number;
    }>;
    perRouteAdoption: Array<{
      repoId: string;
      routePath: string;
      value: number;
      adoptionInstances: number;
      shadowInstances: number;
    }>;
    sharedComponentsAdoption: Array<{
      repoId: string;
      filePath: string;
      componentName: string;
      sharedAcrossRoutes: string[];
      bucket: Bucket;
    }>;
  };
  invariants: InvariantReport;
  warnings: Warning[];
}
