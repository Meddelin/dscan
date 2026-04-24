import { fdir } from 'fdir';
import picomatch from 'picomatch';
import { resolve } from 'node:path';
import type { PerRepoConfig } from '../config/schema.js';
import { DEFAULT_EXCLUDES } from '../config/schema.js';

export interface DiscoveredFile {
  repoId: string;
  repoRoot: string;
  relPath: string;
  absPath: string;
}

/**
 * Stage 1: Discovery (§4.1).
 * Walks repoRoot, applies include/exclude globs, returns relative paths
 * sorted by string order for determinism (§8.4).
 */
export async function discoverFiles(
  repoId: string,
  repoRoot: string,
  config: PerRepoConfig,
): Promise<DiscoveredFile[]> {
  const absRoot = resolve(repoRoot);

  const include = config.include.length > 0 ? config.include : ['src/**/*.{ts,tsx,js,jsx}'];
  const excludes = [...DEFAULT_EXCLUDES, ...config.exclude];

  const includeMatch = picomatch(include, { dot: false });
  const excludeMatch = picomatch(excludes, { dot: true });

  const crawler = new fdir()
    .withRelativePaths()
    .exclude((dirName) => {
      return (
        dirName === 'node_modules' ||
        dirName === 'dist' ||
        dirName === 'build' ||
        dirName === '.next' ||
        dirName === '.git'
      );
    })
    .filter((path) => {
      const normalized = path.replace(/\\/g, '/');
      if (excludeMatch(normalized)) return false;
      return includeMatch(normalized);
    })
    .crawl(absRoot);

  const rels = (await crawler.withPromise()) as string[];
  const normalized = rels.map((r) => r.replace(/\\/g, '/')).sort();

  return normalized.map((relPath) => ({
    repoId,
    repoRoot: absRoot,
    relPath,
    absPath: resolve(absRoot, relPath),
  }));
}
