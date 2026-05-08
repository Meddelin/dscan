import { describe, it, expect } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prescanBeaver } from '../src/prescan/beaver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_BEAVER = resolve(__dirname, 'fixtures/beaver-ui');

describe('Beaver prescan', () => {
  it('discovers all packages in packages/*', async () => {
    const registry = await prescanBeaver({
      beaverUrl: 'ssh://unused',
      cacheDir: '/nowhere',
      localOverride: FAKE_BEAVER,
    });
    expect([...registry.packages].sort()).toEqual([
      '@beaver-ui/button',
      '@beaver-ui/components',
      '@beaver-ui/form',
      '@beaver-ui/side-navigation',
      '@beaver-ui/subheader',
    ]);
  });

  it('collects own exports per leaf package', async () => {
    const registry = await prescanBeaver({
      beaverUrl: 'ssh://unused',
      cacheDir: '/nowhere',
      localOverride: FAKE_BEAVER,
    });
    // Leaf packages: own exports populated via `export { X } from './X'`.
    const btn = registry.reExports.get('@beaver-ui/button');
    expect(btn?.has('Button')).toBe(true);
    expect(btn?.has('IconButton')).toBe(true);
    const nav = registry.reExports.get('@beaver-ui/side-navigation');
    expect(nav?.has('SideNavigation')).toBe(true);
    expect(nav?.has('SideNavigationItem')).toBe(true);
  });

  it('builds re-export map from aggregator → leaf packages', async () => {
    const registry = await prescanBeaver({
      beaverUrl: 'ssh://unused',
      cacheDir: '/nowhere',
      localOverride: FAKE_BEAVER,
    });
    const aggregator = registry.reExports.get('@beaver-ui/components');
    expect(aggregator).toBeDefined();
    expect(aggregator!.get('Button')).toMatchObject({
      sourcePackage: '@beaver-ui/button',
      sourceSymbol: 'Button',
    });
    expect(aggregator!.get('SideNavigation')).toMatchObject({
      sourcePackage: '@beaver-ui/side-navigation',
    });
    expect(aggregator!.get('Subheader')).toMatchObject({
      sourcePackage: '@beaver-ui/subheader',
    });
  });

  it('records hop count for re-exports', async () => {
    const registry = await prescanBeaver({
      beaverUrl: 'ssh://unused',
      cacheDir: '/nowhere',
      localOverride: FAKE_BEAVER,
    });
    // Aggregator → leaf is one hop from the aggregator's perspective.
    const btn = registry.reExports.get('@beaver-ui/components')?.get('Button');
    expect(btn?.hops).toBeGreaterThanOrEqual(1);
    // Leaf package own export is hop 0.
    const btnOwn = registry.reExports.get('@beaver-ui/button')?.get('Button');
    expect(btnOwn?.hops).toBe(0);
  });

  it('returns a non-empty version string', async () => {
    const registry = await prescanBeaver({
      beaverUrl: 'ssh://unused',
      cacheDir: '/nowhere',
      localOverride: FAKE_BEAVER,
    });
    expect(typeof registry.version).toBe('string');
    expect(registry.version.length).toBeGreaterThan(0);
  });

  it('fails fast when localOverride does not exist', async () => {
    await expect(
      prescanBeaver({
        beaverUrl: 'ssh://unused',
        cacheDir: '/nowhere',
        localOverride: join(FAKE_BEAVER, 'nope'),
      }),
    ).rejects.toThrow();
  });
});
