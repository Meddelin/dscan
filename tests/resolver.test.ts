import { describe, it, expect } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTsResolver, extractPackageName } from '../src/resolve/ts-resolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TSCONFIG_PATHS_FIXTURE = resolve(__dirname, 'fixtures/fixture-tsconfig-paths');

describe('extractPackageName', () => {
  it('scoped package with subpath → scope + name', () => {
    expect(extractPackageName('@beaver-ui/button/sub')).toBe('@beaver-ui/button');
  });
  it('scoped package root → returns self', () => {
    expect(extractPackageName('@beaver-ui/button')).toBe('@beaver-ui/button');
  });
  it('non-scoped package with subpath', () => {
    expect(extractPackageName('react-dom/server')).toBe('react-dom');
  });
  it('non-scoped package root', () => {
    expect(extractPackageName('react')).toBe('react');
  });
});

describe('TsResolver', () => {
  it('classifies relative import as in-repo', async () => {
    const resolver = await createTsResolver(TSCONFIG_PATHS_FIXTURE, 'tsconfig.json');
    const importer = join(TSCONFIG_PATHS_FIXTURE, 'src/App.tsx');
    const result = resolver.resolve('./components/LocalPanel', importer);
    expect(result.kind).toBe('in-repo');
    if (result.kind === 'in-repo') {
      expect(result.absPath.replace(/\\/g, '/')).toContain(
        'src/components/LocalPanel',
      );
    }
  });

  it('resolves tsconfig path alias to in-repo file', async () => {
    const resolver = await createTsResolver(TSCONFIG_PATHS_FIXTURE, 'tsconfig.json');
    const importer = join(TSCONFIG_PATHS_FIXTURE, 'src/App.tsx');
    const result = resolver.resolve('@/components/LocalPanel', importer);
    expect(result.kind).toBe('in-repo');
  });

  it('classifies bare specifier not in repo as external', async () => {
    const resolver = await createTsResolver(TSCONFIG_PATHS_FIXTURE, 'tsconfig.json');
    const importer = join(TSCONFIG_PATHS_FIXTURE, 'src/App.tsx');
    const result = resolver.resolve('react', importer);
    expect(result.kind).toBe('external');
    if (result.kind === 'external') {
      expect(result.packageName).toBe('react');
    }
  });

  it('classifies unknown Beaver package as external (by source name)', async () => {
    const resolver = await createTsResolver(TSCONFIG_PATHS_FIXTURE, 'tsconfig.json');
    const importer = join(TSCONFIG_PATHS_FIXTURE, 'src/App.tsx');
    const result = resolver.resolve('@beaver-ui/totally-unknown', importer);
    expect(result.kind).toBe('external');
    if (result.kind === 'external') {
      expect(result.packageName).toBe('@beaver-ui/totally-unknown');
    }
  });

  it('falls back to defaults on missing tsconfig', async () => {
    // No tsconfig at non-existent path.
    const resolver = await createTsResolver(TSCONFIG_PATHS_FIXTURE, 'nonexistent.json');
    const importer = join(TSCONFIG_PATHS_FIXTURE, 'src/App.tsx');
    const result = resolver.resolve('react', importer);
    expect(result.kind).toBe('external');
  });

  it('caches repeated lookups (same instance → same result)', async () => {
    const resolver = await createTsResolver(TSCONFIG_PATHS_FIXTURE, 'tsconfig.json');
    const importer = join(TSCONFIG_PATHS_FIXTURE, 'src/App.tsx');
    const r1 = resolver.resolve('./components/LocalPanel', importer);
    const r2 = resolver.resolve('./components/LocalPanel', importer);
    expect(r1).toBe(r2); // identity (cache hit)
  });
});
