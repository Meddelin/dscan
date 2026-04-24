import { GlobalConfigSchema, type GlobalConfig } from './config/schema.js';

export type {
  GlobalConfig,
  PerRepoConfig,
  RepositoryEntry,
} from './config/schema.js';
export type * from './types/dataset.js';
export { runScan, type RunResult, SCANNER_VERSION } from './pipeline/run.js';
export { buildAggregates } from './pipeline/aggregate.js';
export { renderReport, writeReport } from './viewer/render.js';

/**
 * Type-safe helper for authoring `.beaver-scan.config.ts`.
 * Mirrors the defineConfig idiom in vite/vitest/playwright.
 */
export function defineConfig(config: GlobalConfig): GlobalConfig {
  return GlobalConfigSchema.parse(config);
}
