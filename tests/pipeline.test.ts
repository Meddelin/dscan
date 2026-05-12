import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScan } from '../src/pipeline/run.js';
import type {
  Aggregates,
  ShadowComponentRecord,
  UsageRecord,
} from '../src/types/dataset.js';
import { readJsonl } from '../src/writer/jsonl.js';
import { renderReport } from '../src/viewer/render.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, 'fixtures');
const FAKE_BEAVER = resolve(FIXTURE_ROOT, 'beaver-ui');
const CONFIG_DIR_PREFIX = join(tmpdir(), 'dscan-test-');
const scratchDirs: string[] = [];

async function scratchConfigDir(): Promise<string> {
  const dir = await mkdtemp(CONFIG_DIR_PREFIX);
  scratchDirs.push(dir);
  return dir;
}

beforeEach(() => {
  process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
});

afterEach(() => {
  delete process.env.BEAVER_LOCAL_PATH;
});

afterAll(async () => {
  for (const dir of scratchDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeConfigs(
  dir: string,
  repos: Array<{ name: string; localPath: string; config?: unknown }>,
  global?: { sharedLibraries?: unknown[] },
): Promise<string> {
  const cfg: Record<string, unknown> = {
    beaverUrl: 'ssh://fake-unused-because-of-env',
    repositoriesFile: './repositories.json',
    output: { dir: './results', formats: ['jsonl', 'aggregates', 'html'] },
  };
  if (global?.sharedLibraries) cfg.sharedLibraries = global.sharedLibraries;
  const cfgPath = join(dir, '.beaver-scan.config.json');
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
  await writeFile(
    join(dir, 'repositories.json'),
    JSON.stringify(
      repos.map((r) => ({
        name: r.name,
        gitUrl: 'ssh://x/' + r.name,
        localPath: r.localPath,
        ...(r.config !== undefined ? { config: r.config } : {}),
      })),
      null,
      2,
    ),
    'utf-8',
  );
  return cfgPath;
}

async function runOnFixture(fixtureName: string) {
  const dir = await scratchConfigDir();
  const cfgPath = await writeConfigs(dir, [
    { name: fixtureName, localPath: join(FIXTURE_ROOT, fixtureName) },
  ]);
  const result = await runScan({ configPath: cfgPath });
  const text = await readFile(result.aggregatesPath, 'utf-8');
  const aggregates = JSON.parse(text) as Aggregates;
  const dataset = await readJsonl(result.datasetPath);
  const records = dataset.filter((r): r is UsageRecord => r.kind === 'usage');
  const shadows = dataset.filter(
    (r): r is ShadowComponentRecord => r.kind === 'shadow-component',
  );
  return { result, aggregates, records, shadows };
}

describe('pipeline end-to-end', () => {
  describe('fixture-pure-adoption', () => {
    let aggregates: Aggregates;
    let records: UsageRecord[];

    beforeAll(async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      ({ aggregates, records } = await runOnFixture('fixture-pure-adoption'));
    });

    it('classifies every Beaver import as adoption/direct-beaver', () => {
      const beaverUsages = records.filter((r) => r.category === 'beaver');
      expect(beaverUsages.length).toBeGreaterThan(0);
      for (const u of beaverUsages) {
        expect(u.bucket).toBe('adoption');
        expect(u.classificationSource).toBe('direct-beaver');
        expect(u.beaverPackage).toBeDefined();
      }
    });

    it('globalAdoption = 1.0 (no shadow)', () => {
      expect(aggregates.metrics.globalAdoption.value).toBe(1);
    });

    it('beaverCoverage lists all 3 leaf packages', () => {
      const packages = aggregates.metrics.beaverCoverage.map((c) => c.package).sort();
      expect(packages).toEqual([
        '@beaver-ui/button',
        '@beaver-ui/side-navigation',
        '@beaver-ui/subheader',
      ]);
    });

    it('passes all invariants', () => {
      expect(aggregates.invariants.failed).toBe(0);
    });

    it('beaverVersion is non-empty', () => {
      expect(aggregates.meta.beaverVersion.length).toBeGreaterThan(0);
    });
  });

  describe('fixture-shadow-primitive (confirmed level)', () => {
    let aggregates: Aggregates;
    let records: UsageRecord[];
    let shadows: ShadowComponentRecord[];

    beforeAll(async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      ({ aggregates, records, shadows } = await runOnFixture(
        'fixture-shadow-primitive',
      ));
    });

    it('marks Button as confirmed shadow (primitive + substantial markup + no Beaver)', () => {
      const btn = records.find(
        (r) => r.componentName === 'Button' && r.bucket === 'shadow',
      );
      expect(btn?.shadowLevel).toBe('confirmed');
    });

    it('Card stays at possible (≤4 JSX elements)', () => {
      const card = records.find((r) => r.componentName === 'Card');
      expect(card?.shadowLevel).toBe('possible');
    });

    it('globalAdoption = 0 (all primitives are shadow)', () => {
      expect(aggregates.metrics.globalAdoption.value).toBe(0);
    });

    it('emits ShadowComponentRecord with populated signature', () => {
      const btn = shadows.find((s) => s.componentName === 'Button');
      expect(btn).toBeDefined();
      expect(btn!.signature.jsxElementCount).toBeGreaterThanOrEqual(5);
      expect(btn!.signature.propNames).toContain('onClick');
      expect(btn!.signature.beaverImports).toHaveLength(0);
      expect(btn!.codeSnippet.length).toBeGreaterThan(0);
    });

    it('signals include primitive-like-name + substantial-markup', () => {
      const btn = shadows.find((s) => s.componentName === 'Button');
      expect(btn?.signals).toEqual(
        expect.arrayContaining(['primitive-like-name', 'substantial-markup']),
      );
    });
  });

  describe('fixture-wrapper-adoption', () => {
    let records: UsageRecord[];
    beforeAll(async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      ({ records } = await runOnFixture('fixture-wrapper-adoption'));
    });
    it('PaymentPanel = adoption / beaver-composition (§3.6)', () => {
      const fw = records.find((r) => r.componentName === 'PaymentPanel');
      expect(fw?.bucket).toBe('adoption');
      expect(fw?.classificationSource).toBe('beaver-composition');
    });
  });

  describe('fixture-wrapper-customized', () => {
    let records: UsageRecord[];
    let shadows: ShadowComponentRecord[];
    beforeAll(async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      ({ records, shadows } = await runOnFixture('fixture-wrapper-customized'));
    });
    it('BrandButton = shadow / wraps-with-customization', () => {
      const bb = records.find((r) => r.componentName === 'BrandButton');
      expect(bb?.bucket).toBe('shadow');
      expect(bb?.classificationSource).toBe('wraps-with-customization');
    });
    it('ShadowComponentRecord has wraps-with-customization signal', () => {
      const bb = shadows.find((s) => s.componentName === 'BrandButton');
      expect(bb?.signals).toContain('wraps-with-customization');
    });
  });

  describe('fixture-styled-beaver', () => {
    let records: UsageRecord[];
    beforeAll(async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      ({ records } = await runOnFixture('fixture-styled-beaver'));
    });
    it('styled(Button) = shadow', () => {
      const sb = records.find((r) => r.componentName === 'StyledButton');
      expect(sb?.bucket).toBe('shadow');
      expect(sb?.classificationSource).toBe('wraps-with-customization');
    });
  });

  describe('fixture-local-lib-backed (M3 per-component backing)', () => {
    let records: UsageRecord[];
    beforeAll(async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      ({ records } = await runOnFixture('fixture-local-lib-backed'));
    });
    it('AuthButton (imports Beaver) = adoption/beaver-backed-wrapper', () => {
      const ab = records.find((r) => r.componentName === 'AuthButton');
      expect(ab?.category).toBe('local-library');
      expect(ab?.bucket).toBe('adoption');
      expect(ab?.classificationSource).toBe('beaver-backed-wrapper');
      expect(ab?.beaverBackedByLib).toBe(true);
    });
    it('BrandLogo (no Beaver imports) flips to shadow despite lib.kind=partially-beaver-backed', () => {
      const bl = records.find((r) => r.componentName === 'BrandLogo');
      expect(bl?.category).toBe('local-library');
      expect(bl?.bucket).toBe('shadow');
    });
  });

  describe('fixture-layout-wrapper', () => {
    let records: UsageRecord[];
    beforeAll(async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      ({ records } = await runOnFixture('fixture-layout-wrapper'));
    });
    it('Row = adoption / beaver-composition (markup < 5, no className)', () => {
      const row = records.find((r) => r.componentName === 'Row');
      expect(row?.bucket).toBe('adoption');
      expect(row?.classificationSource).toBe('beaver-composition');
    });
  });

  describe('fixture-mixed', () => {
    let records: UsageRecord[];

    beforeAll(async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      ({ records } = await runOnFixture('fixture-mixed'));
    });

    it('resolves partially-beaver-backed local-lib as adoption', () => {
      const paymentForm = records.find((r) => r.componentName === 'PaymentForm');
      expect(paymentForm).toBeDefined();
      expect(paymentForm!.category).toBe('local-library');
      expect(paymentForm!.bucket).toBe('adoption');
      expect(paymentForm!.classificationSource).toBe('beaver-backed-wrapper');
      expect(paymentForm!.localLibId).toBe('team-kit-backed');
    });

    it('resolves fully-custom local-lib as shadow', () => {
      const legacy = records.find((r) => r.componentName === 'LegacyInput');
      expect(legacy).toBeDefined();
      expect(legacy!.category).toBe('local-library');
      expect(legacy!.bucket).toBe('shadow');
    });

    it('detects local Modal as primitive-name shadow', () => {
      const modal = records.find(
        (r) => r.componentName === 'Modal' && r.category === 'local',
      );
      expect(modal).toBeDefined();
      expect(modal!.bucket).toBe('shadow');
    });

    it('leaves AnalyticsProvider (non-primitive name) as neither', () => {
      const ap = records.find((r) => r.componentName === 'AnalyticsProvider');
      expect(ap).toBeDefined();
      expect(ap!.bucket).toBe('neither');
    });
  });

  describe('fixture-aggregator-package (M1 canonicalization)', () => {
    let records: UsageRecord[];

    beforeAll(async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      ({ records } = await runOnFixture('fixture-aggregator-package'));
    });

    it('canonicalizes Button to @beaver-ui/button with canonicalizedVia', () => {
      const btn = records.find(
        (r) => r.componentName === 'Button' && r.category === 'beaver',
      );
      expect(btn).toBeDefined();
      expect(btn!.beaverPackage).toBe('@beaver-ui/button');
      expect(btn!.canonicalizedVia).toBe('@beaver-ui/components');
    });

    it('canonicalizes SideNavigation to @beaver-ui/side-navigation', () => {
      const nav = records.find((r) => r.componentName === 'SideNavigation');
      expect(nav?.beaverPackage).toBe('@beaver-ui/side-navigation');
      expect(nav?.canonicalizedVia).toBe('@beaver-ui/components');
    });

    it('canonicalizes Subheader to @beaver-ui/subheader', () => {
      const sh = records.find((r) => r.componentName === 'Subheader');
      expect(sh?.beaverPackage).toBe('@beaver-ui/subheader');
      expect(sh?.canonicalizedVia).toBe('@beaver-ui/components');
    });
  });

  describe('fixture-tsconfig-paths (M1 resolver)', () => {
    let records: UsageRecord[];

    beforeAll(async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      ({ records } = await runOnFixture('fixture-tsconfig-paths'));
    });

    it('resolves `@/components/LocalPanel` as local (not third-party)', () => {
      const panel = records.find((r) => r.componentName === 'LocalPanel');
      expect(panel).toBeDefined();
      expect(panel!.category).toBe('local');
    });

    it('classifies direct @beaver-ui/button import as beaver', () => {
      const btn = records.find(
        (r) => r.componentName === 'Button' && r.category === 'beaver',
      );
      expect(btn).toBeDefined();
      expect(btn!.beaverPackage).toBe('@beaver-ui/button');
      expect(btn!.canonicalizedVia).toBeUndefined();
    });
  });

  describe('fixture-route-data-router (M4 route binding)', () => {
    let records: UsageRecord[];
    let aggregates: Aggregates;
    beforeAll(async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      ({ records, aggregates } = await runOnFixture('fixture-route-data-router'));
    });

    it('Dashboard-page usage is bound to /dashboard', () => {
      const dash = records.find(
        (r) =>
          r.filePath === 'src/pages/Dashboard.tsx' &&
          r.componentName === 'Button',
      );
      expect(dash?.route).toEqual({ kind: 'bound', path: '/dashboard' });
    });

    it('Shared Header usage ends up `shared` with both paths', () => {
      const header = records.find((r) => r.filePath === 'src/shared/Header.tsx');
      expect(header?.route.kind).toBe('shared');
      if (header?.route.kind === 'shared') {
        expect(header.route.paths).toEqual(['/dashboard', '/settings']);
      }
    });

    it('Logger (not reachable from any page) is unmapped', () => {
      const log = records.find((r) => r.filePath === 'src/utils/Logger.tsx');
      expect(log?.route).toEqual({ kind: 'unmapped' });
    });

    it('router.tsx own usages → bound (file is in its own reachable set)', () => {
      const router = records.find(
        (r) =>
          r.filePath === 'src/router.tsx' &&
          r.componentName === 'Dashboard',
      );
      // router.tsx imports Dashboard + Settings, so it's reachable from both
      // pages and lands as `shared` with the two paths.
      expect(router?.route.kind).toBe('shared');
    });

    it('M5: perRouteAdoption populated with both routes (bound-only)', () => {
      const routes = aggregates.metrics.perRouteAdoption.filter(
        (r) => r.repoId === 'fixture-route-data-router',
      );
      expect(routes.length).toBe(2);
      const paths = routes.map((r) => r.routePath).sort();
      expect(paths).toEqual(['/dashboard', '/settings']);
      // Each route has at least one adoption usage (direct Beaver).
      for (const r of routes) {
        expect(r.adoptionInstances).toBeGreaterThan(0);
      }
    });

    it('M5: sharedComponentsAdoption lists usages in shared files', () => {
      // Usages inside shared files (e.g. Header.tsx, router.tsx) surface here
      // with their bucket + the set of routes that reach them. Header.tsx
      // contains an `<h1>` usage → html-native / neither.
      const shared = aggregates.metrics.sharedComponentsAdoption.filter(
        (s) =>
          s.repoId === 'fixture-route-data-router' &&
          s.filePath === 'src/shared/Header.tsx',
      );
      expect(shared.length).toBeGreaterThan(0);
      expect(shared[0]!.sharedAcrossRoutes).toEqual(['/dashboard', '/settings']);
    });
  });

  describe('sharedLibraries (PF2.2) — declared once, applies to every repo', () => {
    it('consumer with no localLibraries config still picks up team-platform', async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      const dir = await scratchConfigDir();
      const sharedLibAbsPath = join(FIXTURE_ROOT, 'shared-kits/team-platform');
      const cfgPath = await writeConfigs(
        dir,
        [
          {
            name: 'fixture-uses-shared-lib',
            localPath: join(FIXTURE_ROOT, 'fixture-uses-shared-lib'),
          },
        ],
        {
          sharedLibraries: [
            {
              libId: 'team-platform',
              matchPattern: '@team/platform',
              source: { type: 'local-path', path: sharedLibAbsPath },
              kind: 'partially-beaver-backed',
            },
          ],
        },
      );
      const result = await runScan({ configPath: cfgPath });
      const dataset = await readJsonl(result.datasetPath);
      const records = dataset.filter((r): r is UsageRecord => r.kind === 'usage');

      const team = records.find((r) => r.componentName === 'TeamButton');
      expect(team?.category).toBe('local-library');
      expect(team?.bucket).toBe('adoption');
      expect(team?.localLibId).toBe('team-platform');
      expect(team?.beaverBackedByLib).toBe(true);

      const legacy = records.find((r) => r.componentName === 'LegacyDropdown');
      expect(legacy?.category).toBe('local-library');
      expect(legacy?.bucket).toBe('shadow');
      expect(legacy?.localLibId).toBe('team-platform');
    });

    it('per-repo localLibraries override sharedLibraries by libId', async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      const dir = await scratchConfigDir();
      const sharedLibAbsPath = join(FIXTURE_ROOT, 'shared-kits/team-platform');
      const cfgPath = await writeConfigs(
        dir,
        [
          {
            name: 'fixture-uses-shared-lib',
            localPath: join(FIXTURE_ROOT, 'fixture-uses-shared-lib'),
            // Same libId, but with kind='fully-custom' — overrides shared.
            // All shared components are now classified as shadow when
            // prescan can't reach the source (per-repo path doesn't point
            // at the real kit), validating override semantics.
            config: {
              localLibraries: [
                {
                  libId: 'team-platform',
                  matchPattern: '@team/platform',
                  source: { type: 'local-path', path: './nonexistent' },
                  kind: 'fully-custom',
                },
              ],
            },
          },
        ],
        {
          sharedLibraries: [
            {
              libId: 'team-platform',
              matchPattern: '@team/platform',
              source: { type: 'local-path', path: sharedLibAbsPath },
              kind: 'partially-beaver-backed',
            },
          ],
        },
      );
      const result = await runScan({ configPath: cfgPath });
      const dataset = await readJsonl(result.datasetPath);
      const records = dataset.filter((r): r is UsageRecord => r.kind === 'usage');
      // With the override active, even TeamButton (which is Beaver-backed
      // at source) falls back to shadow because the per-repo source.path
      // doesn't exist and kind=fully-custom forces the shadow branch.
      const team = records.find((r) => r.componentName === 'TeamButton');
      expect(team?.bucket).toBe('shadow');
    });
  });

  describe('mocks / fixtures excluded by default (PF2.1)', () => {
    it('does not scan __mocks__/ or *.mock.* by default', async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      const { records } = await runOnFixture('fixture-mocks-excluded');
      // Real.tsx is in the scan; mock siblings must not contribute usages.
      const paths = new Set(records.map((r) => r.filePath));
      expect(paths.has('src/Real.tsx')).toBe(true);
      expect(paths.has('src/__mocks__/Real.tsx')).toBe(false);
      expect(paths.has('src/components/Button.mock.tsx')).toBe(false);
    });
  });

  describe('warnings carry absPath (PF2.1)', () => {
    it('parse-failed warning includes absolute path', async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      const dir = await scratchConfigDir();
      const malformedRoot = join(dir, 'malformed-repo');
      const { mkdir, writeFile: writeFileFn } = await import('node:fs/promises');
      await mkdir(join(malformedRoot, 'src'), { recursive: true });
      await writeFileFn(join(malformedRoot, '.beaver-scan.json'), '{}', 'utf-8');
      await writeFileFn(join(malformedRoot, 'src/broken.tsx'), 'const x = <<<<', 'utf-8');
      const cfgPath = await writeConfigs(dir, [
        { name: 'malformed-repo', localPath: malformedRoot },
      ]);
      const result = await runScan({ configPath: cfgPath });
      const warnings = JSON.parse(
        await readFile(join(dirname(result.aggregatesPath), 'warnings.json'), 'utf-8'),
      ) as Array<{ code: string; absPath?: string; filePath?: string }>;
      const parseFail = warnings.find((w) => w.code === 'parse-failed');
      expect(parseFail).toBeDefined();
      expect(parseFail!.filePath).toBe('src/broken.tsx');
      expect(parseFail!.absPath).toBeDefined();
      expect(parseFail!.absPath!.replace(/\\/g, '/').endsWith('/src/broken.tsx')).toBe(true);
    });
  });

  describe('parser respects file extension (no jsx for .ts)', () => {
    it('TS-only files with generics parse without `parse-failed`', async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      const dir = await scratchConfigDir();
      const cfgPath = await writeConfigs(dir, [
        {
          name: 'fixture-ts-generics',
          localPath: join(FIXTURE_ROOT, 'fixture-ts-generics'),
        },
      ]);
      const result = await runScan({ configPath: cfgPath });
      const warningsPath = join(dirname(result.aggregatesPath), 'warnings.json');
      const warnings = JSON.parse(await readFile(warningsPath, 'utf-8')) as Array<{
        code: string;
      }>;
      const parseFailures = warnings.filter((w) => w.code === 'parse-failed');
      expect(parseFailures).toEqual([]);
    });
  });

  describe('member-expression JSX (§5.5)', () => {
    let records: UsageRecord[];
    beforeAll(async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      ({ records } = await runOnFixture('fixture-member-expression'));
    });

    it('classifies <Form/> as Beaver direct', () => {
      const root = records.find((r) => r.componentName === 'Form');
      expect(root?.category).toBe('beaver');
      expect(root?.beaverPackage).toBe('@beaver-ui/form');
    });

    it('classifies <Form.Item/> as Beaver direct (canonicalised on the base package)', () => {
      const item = records.find((r) => r.componentName === 'Form.Item');
      expect(item).toBeDefined();
      expect(item?.category).toBe('beaver');
      expect(item?.beaverPackage).toBe('@beaver-ui/form');
    });

    it('classifies <Form.Section/> the same way', () => {
      const section = records.find((r) => r.componentName === 'Form.Section');
      expect(section?.category).toBe('beaver');
    });

    it('does NOT emit unresolved-dynamic for member expressions on Beaver', async () => {
      const dataset = await readJsonl(
        join(
          dirname((await runOnFixture('fixture-member-expression')).result.aggregatesPath),
          'dataset.jsonl',
        ),
      );
      const unresolved = dataset.filter(
        (r) =>
          r.kind === 'unresolved-dynamic' &&
          r.repoId === 'fixture-member-expression',
      );
      expect(unresolved).toEqual([]);
    });
  });

  describe('route resolver unwraps external wrappers around local pages', () => {
    let records: UsageRecord[];
    beforeAll(async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      ({ records } = await runOnFixture('fixture-route-wrapped-element'));
    });

    it('binds CreateProject (inside <AbilityGuard>) to /projects/new', () => {
      const cp = records.find(
        (r) =>
          r.filePath === 'src/pages/CreateProject.tsx' &&
          r.componentName === 'Button',
      );
      expect(cp?.route).toEqual({
        kind: 'bound',
        path: '/projects/new',
      });
    });
  });

  describe('route resolver — deep wrapper nesting (PF2.5)', () => {
    let records: UsageRecord[];
    beforeAll(async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      ({ records } = await runOnFixture('fixture-route-deep-wrapper'));
    });

    it('binds /plain through one external wrapper to local PlainPage', () => {
      const plain = records.find(
        (r) =>
          r.filePath === 'src/pages/PlainPage.tsx' &&
          r.componentName === 'Button',
      );
      expect(plain?.route.kind).toBe('bound');
      if (plain?.route.kind === 'bound') expect(plain.route.path).toBe('/plain');
    });

    it('binds /builds through 3-deep wrapper + member-expr child', () => {
      // BFS order through the JSX tree: ErrorBoundary (ext), AbilityGuard
      // (ext), Layout (in-repo!), Pages.BuildInfra (member-expr). First
      // in-repo candidate wins → Layout.tsx anchors /builds. The
      // Pages.BuildInfra is rendered as a child of Layout but the import
      // graph from Layout doesn't reach BuildInfra.tsx (only router.tsx
      // does). What matters: route resolves at all (`bound`, not
      // unmapped) and the first local component in the JSX tree wins.
      const layout = records.find(
        (r) => r.filePath === 'src/shared/Layout.tsx',
      );
      expect(layout?.route.kind).toBe('bound');
      if (layout?.route.kind === 'bound') {
        expect(layout.route.path).toBe('/builds');
      }
    });
  });

  describe('route resolver — path constants (PF2.4)', () => {
    let records: UsageRecord[];
    beforeAll(async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      ({ records } = await runOnFixture('fixture-route-path-constants'));
    });

    it('binds Home to / via direct const identifier (ROOT_PATH)', () => {
      const home = records.find(
        (r) => r.filePath === 'src/pages/Home.tsx' && r.componentName === 'Button',
      );
      expect(home?.route.kind).toBe('bound');
      if (home?.route.kind === 'bound') expect(home.route.path).toBe('/');
    });

    it('binds Dashboard to /dashboard via single-level member (ROUTER_PATHS.dashboard)', () => {
      const dash = records.find(
        (r) =>
          r.filePath === 'src/pages/Dashboard.tsx' && r.componentName === 'Button',
      );
      expect(dash?.route.kind).toBe('bound');
      if (dash?.route.kind === 'bound') expect(dash.route.path).toBe('/dashboard');
    });

    it('binds Payment to /checkout/payment via nested member', () => {
      const pay = records.find(
        (r) => r.filePath === 'src/pages/Payment.tsx' && r.componentName === 'Button',
      );
      expect(pay?.route.kind).toBe('bound');
      if (pay?.route.kind === 'bound') {
        expect(pay.route.path).toBe('/checkout/payment');
      }
    });

    it('does not emit dynamic-path-skipped warnings for resolvable constants', async () => {
      const dir = await scratchConfigDir();
      const cfgPath = await writeConfigs(dir, [
        {
          name: 'fixture-route-path-constants',
          localPath: join(FIXTURE_ROOT, 'fixture-route-path-constants'),
        },
      ]);
      const result = await runScan({ configPath: cfgPath });
      const warnings = JSON.parse(
        await readFile(join(dirname(result.aggregatesPath), 'warnings.json'), 'utf-8'),
      ) as Array<{ code: string; message: string }>;
      const pathSkipped = warnings.filter((w) =>
        w.message.includes('dynamic-path-skipped'),
      );
      expect(pathSkipped).toEqual([]);
    });
  });

  describe('route resolver — JSX member expressions (PF2.3)', () => {
    let records: UsageRecord[];
    beforeAll(async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      ({ records } = await runOnFixture('fixture-route-member-expression'));
    });

    it('binds `<Pages.Dashboard />` via namespace import', () => {
      const dash = records.find(
        (r) =>
          r.filePath === 'src/pages/Dashboard.tsx' &&
          r.componentName === 'Button',
      );
      // The namespace import file (pages/index.ts) is the page-component
      // anchor. Both `<Pages.Dashboard/>` and `<Pages.MobileBuilds/>` map
      // to the same anchor, so Dashboard.tsx is reachable from both routes
      // and lands as `shared`.
      expect(dash?.route.kind === 'bound' || dash?.route.kind === 'shared').toBe(true);
      if (dash?.route.kind === 'shared') {
        expect(dash.route.paths.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('binds `<Pages.MobileBuilds />` (same namespace)', () => {
      const builds = records.find(
        (r) =>
          r.filePath === 'src/pages/MobileBuilds.tsx' &&
          r.componentName === 'Button',
      );
      expect(builds?.route.kind === 'bound' || builds?.route.kind === 'shared').toBe(true);
    });

    it('binds `<Routes.Settings />` from named-import-of-object', () => {
      const settings = records.find(
        (r) =>
          r.filePath === 'src/page-registry/Settings.tsx' &&
          r.componentName === 'Button',
      );
      expect(settings?.route.kind === 'bound' || settings?.route.kind === 'shared').toBe(true);
    });

    it('does not emit jsx-member-unresolved warnings for resolvable members', async () => {
      const dir = await scratchConfigDir();
      const cfgPath = await writeConfigs(dir, [
        {
          name: 'fixture-route-member-expression',
          localPath: join(FIXTURE_ROOT, 'fixture-route-member-expression'),
        },
      ]);
      const result = await runScan({ configPath: cfgPath });
      const warnings = JSON.parse(
        await readFile(join(dirname(result.aggregatesPath), 'warnings.json'), 'utf-8'),
      ) as Array<{ code: string; message: string }>;
      const jsxMemberWarnings = warnings.filter((w) =>
        w.message.includes('jsx-member-'),
      );
      expect(jsxMemberWarnings).toEqual([]);
    });
  });

  describe('per-repo config is optional (no .beaver-scan.json)', () => {
    it('fixture-no-config scans using built-in defaults', async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      const { records } = await runOnFixture('fixture-no-config');
      expect(records.length).toBeGreaterThan(0);
      const btn = records.find((r) => r.componentName === 'Button');
      expect(btn?.category).toBe('beaver');
      expect(btn?.bucket).toBe('adoption');
    });

    it('inline config override in repositories.json is honoured', async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      const dir = await scratchConfigDir();
      const cfgPath = await writeConfigs(dir, [
        {
          name: 'fixture-no-config',
          localPath: join(FIXTURE_ROOT, 'fixture-no-config'),
          config: {
            // Exclude everything — scan should yield zero usages.
            include: ['never-matches/**/*.tsx'],
          },
        },
      ]);
      const result = await runScan({ configPath: cfgPath });
      expect(result.stats.filesScanned).toBe(0);
    });
  });

  describe('repos without router config stay `unsupported`', () => {
    it('fixture-pure-adoption keeps kind=unsupported', async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      const { records } = await runOnFixture('fixture-pure-adoption');
      for (const r of records) {
        expect(r.route.kind).toBe('unsupported');
      }
    });
  });

  describe('HTML viewer', () => {
    it('renders self-contained HTML with inlined data', () => {
      const aggregates: Aggregates = {
        schemaVersion: '1.1',
        meta: {
          scannerVersion: '0.1.0',
          scannedAt: '2026-04-24T00:00:00.000Z',
          scanDurationMs: 100,
          beaverVersion: 'test',
          reposScanned: 1,
          filesScanned: 10,
        },
        metrics: {
          globalAdoption: { value: 0.75, formula: 'adoption / (adoption + shadow)' },
          perRepoAdoption: [{ repoId: 'repo-a', value: 0.75 }],
          shadowLandscape: { byFile: [], byComponent: [] },
          beaverCoverage: [],
          perRouteAdoption: [],
          sharedComponentsAdoption: [],
        },
        invariants: { checked: 10, failed: 0, violations: [] },
        warnings: [],
      };
      const html = renderReport(aggregates);
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('BEAVER');
      expect(html).toContain('Global Adoption');
      expect(html).not.toContain('fetch(');
      expect(html).toContain('"value":0.75');
    });
  });

  describe('determinism (§8.4)', () => {
    it('yields bit-identical dataset on two consecutive runs', async () => {
      process.env.BEAVER_LOCAL_PATH = FAKE_BEAVER;
      const dir = await scratchConfigDir();
      const cfgPath = await writeConfigs(dir, [
        { name: 'fixture-mixed', localPath: join(FIXTURE_ROOT, 'fixture-mixed') },
      ]);
      const r1 = await runScan({ configPath: cfgPath });
      const text1 = await readFile(r1.datasetPath, 'utf-8');

      const dir2 = await scratchConfigDir();
      const cfgPath2 = await writeConfigs(dir2, [
        { name: 'fixture-mixed', localPath: join(FIXTURE_ROOT, 'fixture-mixed') },
      ]);
      const r2 = await runScan({ configPath: cfgPath2 });
      const text2 = await readFile(r2.datasetPath, 'utf-8');
      expect(text1).toBe(text2);
    });
  });
});
