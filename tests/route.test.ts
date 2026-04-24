import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverFiles } from '../src/pipeline/discovery.js';
import { parseFiles } from '../src/pipeline/parse.js';
import { createTsResolver } from '../src/resolve/ts-resolver.js';
import { resolveRoutes } from '../src/route/resolve.js';
import { normalize } from '../src/route/import-graph.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/fixture-route-data-router');

async function prepare() {
  const files = await discoverFiles('r', FIXTURE, {
    include: ['src/**/*.{ts,tsx,js,jsx}'],
    exclude: [],
    tsconfig: 'tsconfig.json',
    localLibraries: [],
  });
  const { parsed } = await parseFiles(files);
  const resolver = await createTsResolver(FIXTURE, 'tsconfig.json');
  return { parsed, resolver };
}

describe('route resolver — data-router fixture', () => {
  it('discovers both createBrowserRouter routes', async () => {
    const { parsed, resolver } = await prepare();
    const resolution = resolveRoutes({ parsed, resolver, depthLimit: 20 });
    const paths = resolution.entries.map((e) => e.path).sort();
    expect(paths).toEqual(['/dashboard', '/settings']);
  });

  it('binds Dashboard page file to /dashboard only', async () => {
    const { parsed, resolver } = await prepare();
    const resolution = resolveRoutes({ parsed, resolver, depthLimit: 20 });
    const key = normalize(resolve(FIXTURE, 'src/pages/Dashboard.tsx'));
    expect(resolution.byFile.get(key)).toEqual({
      kind: 'bound',
      path: '/dashboard',
    });
  });

  it('marks Header (used by both pages) as shared', async () => {
    const { parsed, resolver } = await prepare();
    const resolution = resolveRoutes({ parsed, resolver, depthLimit: 20 });
    const key = normalize(resolve(FIXTURE, 'src/shared/Header.tsx'));
    const binding = resolution.byFile.get(key);
    expect(binding?.kind).toBe('shared');
    if (binding?.kind === 'shared') {
      expect(binding.paths).toEqual(['/dashboard', '/settings']);
    }
  });

  it('marks PermissionGate (Settings-only) as bound to /settings', async () => {
    const { parsed, resolver } = await prepare();
    const resolution = resolveRoutes({ parsed, resolver, depthLimit: 20 });
    const key = normalize(resolve(FIXTURE, 'src/providers/PermissionGate.tsx'));
    expect(resolution.byFile.get(key)).toEqual({
      kind: 'bound',
      path: '/settings',
    });
  });

  it('marks Logger (not imported by any page) as unmapped', async () => {
    const { parsed, resolver } = await prepare();
    const resolution = resolveRoutes({ parsed, resolver, depthLimit: 20 });
    const key = normalize(resolve(FIXTURE, 'src/utils/Logger.tsx'));
    expect(resolution.byFile.get(key)).toEqual({ kind: 'unmapped' });
  });

  it('returns empty result for repo with no router config', async () => {
    const NO_ROUTER = resolve(__dirname, 'fixtures/fixture-pure-adoption');
    const files = await discoverFiles('r', NO_ROUTER, {
      include: ['src/**/*.{ts,tsx,js,jsx}'],
      exclude: [],
      tsconfig: 'tsconfig.json',
      localLibraries: [],
    });
    const { parsed } = await parseFiles(files);
    const resolver = await createTsResolver(NO_ROUTER, 'tsconfig.json');
    const resolution = resolveRoutes({ parsed, resolver, depthLimit: 20 });
    expect(resolution.entries.length).toBe(0);
    expect(resolution.byFile.size).toBe(0);
  });
});
