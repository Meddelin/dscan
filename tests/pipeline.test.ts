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
  repos: Array<{ name: string; localPath: string }>,
): Promise<string> {
  const cfg = {
    beaverUrl: 'ssh://fake-unused-because-of-env',
    repositoriesFile: './repositories.json',
    output: { dir: './results', formats: ['jsonl', 'aggregates', 'html'] },
  };
  const cfgPath = join(dir, '.beaver-scan.config.json');
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
  await writeFile(
    join(dir, 'repositories.json'),
    JSON.stringify(
      repos.map((r) => ({
        name: r.name,
        gitUrl: 'ssh://x/' + r.name,
        localPath: r.localPath,
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
