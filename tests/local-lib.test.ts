import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prescanBeaver } from '../src/prescan/beaver.js';
import { prescanLocalLibs } from '../src/prescan/local-lib.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_BEAVER = resolve(__dirname, 'fixtures/beaver-ui');
const LOCAL_LIB_FIXTURE = resolve(__dirname, 'fixtures/fixture-local-lib-backed');

describe('local-lib prescan', () => {
  it('flags Beaver-importing file as backed, non-importing file as custom', async () => {
    const beaver = await prescanBeaver({
      beaverUrl: 'ssh://unused',
      cacheDir: '/nowhere',
      localOverride: FAKE_BEAVER,
    });
    const registry = await prescanLocalLibs(
      {
        include: ['src/**/*.{ts,tsx,js,jsx}'],
        exclude: [],
        tsconfig: 'tsconfig.json',
        localLibraries: [
          {
            libId: 'team-kit',
            matchPattern: 'src/shared/kit/**',
            source: { type: 'local-path', path: 'src/shared/kit' },
            kind: 'partially-beaver-backed',
          },
        ],
      },
      LOCAL_LIB_FIXTURE,
      beaver,
      'tsconfig.json',
    );
    const byLib = registry.byLib.get('team-kit');
    expect(byLib).toBeDefined();
    expect(byLib!.get('AuthButton')).toBe(true);
    expect(byLib!.get('BrandLogo')).toBe(false);
  });

  it('handles missing library directory gracefully', async () => {
    const beaver = await prescanBeaver({
      beaverUrl: 'ssh://unused',
      cacheDir: '/nowhere',
      localOverride: FAKE_BEAVER,
    });
    const registry = await prescanLocalLibs(
      {
        include: [],
        exclude: [],
        tsconfig: 'tsconfig.json',
        localLibraries: [
          {
            libId: 'ghost',
            matchPattern: 'src/ghost/**',
            source: { type: 'local-path', path: 'src/does-not-exist' },
            kind: 'fully-custom',
          },
        ],
      },
      LOCAL_LIB_FIXTURE,
      beaver,
      'tsconfig.json',
    );
    expect(registry.byLib.get('ghost')?.size ?? 0).toBe(0);
  });
});
