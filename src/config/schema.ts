import { z } from 'zod';

/**
 * Shape of a single library declaration. Used in two places:
 *   - GlobalConfig.sharedLibraries — applies to every scanned repo;
 *     `source.path` is resolved relative to the operator's config dir.
 *   - PerRepoConfig.localLibraries — applies only to that repo;
 *     `source.path` is resolved relative to the repo root.
 *
 * When the same `libId` appears in both, the per-repo entry wins entirely
 * (no field-level merge). Operators use shared libs for cross-repo
 * declarations and per-repo overrides for the few repos that need to
 * tweak `kind` or `matchPattern`.
 */
export const LocalLibrarySchema = z.object({
  libId: z.string().min(1),
  matchPattern: z.string().min(1),
  source: z.object({
    type: z.literal('local-path'),
    path: z.string().min(1),
  }),
  kind: z.enum(['partially-beaver-backed', 'fully-custom']),
});

export type LocalLibrary = z.infer<typeof LocalLibrarySchema>;

export const GlobalConfigSchema = z.object({
  beaverUrl: z.string().min(1).describe('SSH URL to Beaver repo'),
  repositoriesFile: z.string().default('./repositories.json'),

  output: z
    .object({
      dir: z.string().default('./results'),
      formats: z
        .array(z.enum(['jsonl', 'aggregates', 'html']))
        .default(['jsonl', 'aggregates', 'html']),
    })
    .default({ dir: './results', formats: ['jsonl', 'aggregates', 'html'] }),

  thresholds: z
    .object({
      reusableLocalFiles: z.number().int().positive().default(2),
      substantialMarkupElements: z.number().int().positive().default(5),
      unresolvedDynamicWarningPct: z.number().min(0).max(1).default(0.05),
      shadowFalsePositiveTarget: z.number().min(0).max(1).default(0.15),
      codeSnippetMaxLines: z.number().int().positive().default(200),
    })
    .default({
      reusableLocalFiles: 2,
      substantialMarkupElements: 5,
      unresolvedDynamicWarningPct: 0.05,
      shadowFalsePositiveTarget: 0.15,
      codeSnippetMaxLines: 200,
    }),

  routeResolution: z
    .object({
      enabled: z.boolean().default(true),
      router: z.enum(['react-router-v6']).default('react-router-v6'),
      entryPoints: z.array(z.string()).optional(),
      propagationBoundary: z.enum(['repo', 'src']).default('repo'),
      importGraphDepthLimit: z.number().int().positive().default(20),
      collapseNestedRoutes: z.boolean().default(true),
    })
    .optional(),

  primitiveNames: z.array(z.string()).optional(),

  /**
   * Declared once, applied to every scanned consumer repo. Useful for design
   * systems / utility kits that live next to (or above) the consumer repos
   * and don't change shape across them. Per-repo `localLibraries` with the
   * same libId override entries here for that one repo. `source.path` is
   * resolved relative to the directory holding the global config (`configDir`)
   * — that way the same path string works regardless of which consumer is
   * being scanned.
   */
  sharedLibraries: z.array(LocalLibrarySchema).default([]),
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

export const RepositoryEntrySchema = z.object({
  name: z.string().optional(),
  gitUrl: z.string().min(1),
  // MVP-only: when running on local fixtures, allow a pre-checked-out path
  // to skip cloning. Removed once Stage-1 clone is implemented.
  localPath: z.string().optional(),
  /**
   * Inline per-repo config. Takes effect when the consumer repo does not
   * ship its own `.beaver-scan.json`. A consumer-side file, if present,
   * wins over this override. Both are merged onto Zod defaults, so
   * operators can keep the entry minimal.
   */
  config: z.unknown().optional(),
});

export type RepositoryEntry = z.infer<typeof RepositoryEntrySchema>;

export const RepositoriesFileSchema = z.array(RepositoryEntrySchema).min(1);

export const PerRepoConfigSchema = z.object({
  include: z
    .array(z.string())
    .default(['src/**/*.{ts,tsx,js,jsx}']),
  exclude: z.array(z.string()).default([]),
  tsconfig: z.string().default('tsconfig.json'),

  localLibraries: z.array(LocalLibrarySchema).default([]),

  routeResolution: z
    .object({
      enabled: z.boolean().optional(),
      entryPoints: z.array(z.string()).optional(),
    })
    .optional(),

  primitiveNamesOverride: z.array(z.string()).optional(),
});

export type PerRepoConfig = z.infer<typeof PerRepoConfigSchema>;

/**
 * Stable Warning shape persisted in warnings.json (§8.3). Every new warning
 * code must register here AND in docs/warnings.md. Unknown codes are not
 * rejected at read time — consumers are forward-compatible — but producers
 * should use one of these values.
 */
export const WARNING_CODES = [
  'file-read-failed',
  'parse-failed',
  'local-lib-prescan-failed',
  'unresolved-dynamic-rate-exceeded',
  'route-resolution-warning',
  'repo-clone-failed',
  'stage7-disabled',
] as const;

export const WarningSchema = z.object({
  repoId: z.string().optional(),
  filePath: z.string().optional(),
  code: z.string(),
  message: z.string(),
});

export type WarningFromSchema = z.infer<typeof WarningSchema>;

export const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*.stories.*',
  // Mocks / fixtures — test scaffolding that distorts metrics if included.
  // Operators can opt back in by overriding `exclude` in per-repo config.
  '**/__mocks__/**',
  '**/__fixtures__/**',
  '**/mocks/**',
  '**/*.mock.*',
  '**/*.fixture.*',
];
