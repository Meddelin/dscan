import { z } from 'zod';

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

  // MVP-only: since Beaver prescan is not implemented yet, beaver packages must
  // be enumerated in config explicitly. Will be replaced by prescan output (§4.5).
  beaverPackages: z.array(z.string()).default([]),
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

export const RepositoryEntrySchema = z.object({
  name: z.string().optional(),
  gitUrl: z.string().min(1),
  // MVP-only: when running on local fixtures, allow a pre-checked-out path
  // to skip cloning. Removed once Stage-1 clone is implemented.
  localPath: z.string().optional(),
});

export type RepositoryEntry = z.infer<typeof RepositoryEntrySchema>;

export const RepositoriesFileSchema = z.array(RepositoryEntrySchema).min(1);

export const PerRepoConfigSchema = z.object({
  include: z
    .array(z.string())
    .default(['src/**/*.{ts,tsx,js,jsx}']),
  exclude: z.array(z.string()).default([]),
  tsconfig: z.string().default('tsconfig.json'),

  localLibraries: z
    .array(
      z.object({
        libId: z.string().min(1),
        matchPattern: z.string().min(1),
        source: z.object({
          type: z.literal('local-path'),
          path: z.string().min(1),
        }),
        kind: z.enum(['partially-beaver-backed', 'fully-custom']),
      }),
    )
    .default([]),

  routeResolution: z
    .object({
      enabled: z.boolean().optional(),
      entryPoints: z.array(z.string()).optional(),
    })
    .optional(),

  primitiveNamesOverride: z.array(z.string()).optional(),
});

export type PerRepoConfig = z.infer<typeof PerRepoConfigSchema>;

export const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*.stories.*',
];
