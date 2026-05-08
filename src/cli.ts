#!/usr/bin/env node
import { Command } from 'commander';
import { readFile, writeFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, join } from 'node:path';
import { runScan, SCANNER_VERSION } from './pipeline/run.js';
import { readJsonl } from './writer/jsonl.js';
import { buildAggregates } from './pipeline/aggregate.js';
import { renderReport, writeReport } from './viewer/render.js';
import type { Aggregates, Warning } from './types/dataset.js';
import { ConfigError, loadGlobalConfig } from './config/loader.js';
import { gitPull, isGitRepo } from './ops/git.js';

const program = new Command();
// The bin entry registers both `beaver-scan` and `ds-scanner`. argv[1]
// resolves to whichever the user invoked; pick that as the displayed name.
const invokedAs = (process.argv[1] ?? '').includes('ds-scanner')
  ? 'ds-scanner'
  : 'beaver-scan';
program.name(invokedAs).version(SCANNER_VERSION);

async function executeRun(opts: {
  config: string;
  output?: string;
  failOnInvariant: boolean;
}) {
  const runOpts: { configPath: string; outputDir?: string } = {
    configPath: opts.config,
  };
  if (opts.output) runOpts.outputDir = opts.output;
  const result = await runScan(runOpts);
  process.stdout.write(
    `Scanned ${result.stats.reposScanned} repos · ${result.stats.filesScanned} files · ` +
      `${result.stats.usages} usages (${result.stats.unresolved} unresolved) · ` +
      `${result.stats.warnings} warnings · ${result.stats.durationMs}ms\n`,
  );
  process.stdout.write(`dataset:    ${result.datasetPath}\n`);
  process.stdout.write(`aggregates: ${result.aggregatesPath}\n`);
  if (result.reportPath) process.stdout.write(`report:     ${result.reportPath}\n`);

  if (opts.failOnInvariant) {
    const text = await readFile(result.aggregatesPath, 'utf-8');
    const agg = JSON.parse(text) as Aggregates;
    if (agg.invariants.failed > 0) {
      process.stderr.write(
        `Invariant violations (${agg.invariants.failed}):\n`,
      );
      for (const v of agg.invariants.violations) {
        process.stderr.write(`  ${v.code} × ${v.count} — ${v.message}\n`);
      }
      process.exit(3);
    }
  }
}

program
  .command('run')
  .description('Run full pipeline: scan → dataset.jsonl + aggregates.json + report.html')
  .requiredOption('-c, --config <path>', 'path to global config (.ts/.js/.json)')
  .option('-o, --output <dir>', 'override output.dir from config')
  .option('--no-fail-on-invariant', 'do not exit 3 when domain invariants fail (§10.1)')
  .action(
    async (opts: { config: string; output?: string; failOnInvariant: boolean }) => {
      try {
        await executeRun(opts);
      } catch (err) {
        handleFatal(err);
      }
    },
  );

// `analyze` is the operator-facing alias for `run` per the runbook
// (`npx ds-scanner analyze --output .ds-metrics/report`).
program
  .command('analyze')
  .description('Alias for `run` with explicit --output (operator workflow)')
  .option('-c, --config <path>', 'path to global config', 'ds-scanner.config.ts')
  .option('-o, --output <dir>', 'output directory for artefacts', '.ds-metrics/report')
  .option('--no-fail-on-invariant', 'do not exit 3 when domain invariants fail')
  .action(
    async (opts: { config: string; output: string; failOnInvariant: boolean }) => {
      try {
        await executeRun(opts);
      } catch (err) {
        handleFatal(err);
      }
    },
  );

program
  .command('aggregate')
  .description('Recompute aggregates.json from existing dataset.jsonl')
  .requiredOption('-d, --dataset <path>', 'path to dataset.jsonl')
  .requiredOption('-o, --out <dir>', 'output directory for aggregates.json')
  .option('--warnings <path>', 'path to warnings.json (optional)')
  .action(
    async (opts: { dataset: string; out: string; warnings?: string }) => {
      try {
        const datasetAbs = resolveArg(opts.dataset);
        const outAbs = resolveArg(opts.out);
        const records = await readJsonl(datasetAbs);
        const warnings = await loadWarnings(opts.warnings);
        const aggregates = buildAggregates({
          records,
          warnings,
          scannerVersion: SCANNER_VERSION,
          scannedAt: new Date().toISOString(),
          scanDurationMs: 0,
          beaverVersion: 'unprescanned',
          reposScanned: distinctCount(records, (r) => r.repoId),
          filesScanned: distinctCount(records, (r) => `${r.repoId}::${r.filePath}`),
        });
        await mkdir(outAbs, { recursive: true });
        const outPath = resolve(outAbs, 'aggregates.json');
        await writeFile(outPath, JSON.stringify(aggregates, null, 2), 'utf-8');
        process.stdout.write(`aggregates: ${outPath}\n`);
      } catch (err) {
        handleFatal(err);
      }
    },
  );

program
  .command('viewer')
  .description('Render self-contained report.html from aggregates.json')
  .requiredOption('-a, --aggregates <path>', 'path to aggregates.json')
  .requiredOption('-o, --out <path>', 'path to output report.html')
  .action(async (opts: { aggregates: string; out: string }) => {
    try {
      const aggsPath = resolveArg(opts.aggregates);
      const outPath = resolveArg(opts.out);
      const text = await readFile(aggsPath, 'utf-8');
      const aggregates = JSON.parse(text) as Aggregates;
      const html = renderReport(aggregates);
      await mkdir(dirname(outPath), { recursive: true });
      await writeReport(outPath, html);
      process.stdout.write(`report: ${outPath}\n`);
    } catch (err) {
      handleFatal(err);
    }
  });

program
  .command('update')
  .description('`git pull --ff-only` every cached repo (consumer + Beaver)')
  .requiredOption('-c, --config <path>', 'path to global config')
  .action(async (opts: { config: string }) => {
    try {
      const { configDir } = await loadGlobalConfig(opts.config);
      const cacheDir = resolve(configDir, '.cache');
      const stats = await stat(cacheDir).catch(() => null);
      if (!stats?.isDirectory()) {
        process.stdout.write(`No cache at ${cacheDir}; nothing to update.\n`);
        return;
      }
      const entries: string[] = [];
      const beaverDir = join(cacheDir, 'beaver-ui');
      if (await isGitRepo(beaverDir)) entries.push(beaverDir);
      const reposDir = join(cacheDir, 'repos');
      const reposDirStat = await stat(reposDir).catch(() => null);
      if (reposDirStat?.isDirectory()) {
        const repoNames = await readdir(reposDir);
        for (const name of repoNames) {
          const full = join(reposDir, name);
          if (await isGitRepo(full)) entries.push(full);
        }
      }
      for (const dir of entries) {
        try {
          await gitPull(dir);
          process.stdout.write(`pulled: ${dir}\n`);
        } catch (err) {
          process.stderr.write(`failed: ${dir} — ${(err as Error).message}\n`);
        }
      }
    } catch (err) {
      handleFatal(err);
    }
  });

program
  .command('clean')
  .description('Remove .cache/ adjacent to the config')
  .requiredOption('-c, --config <path>', 'path to global config')
  .action(async (opts: { config: string }) => {
    try {
      const { configDir } = await loadGlobalConfig(opts.config);
      const cacheDir = resolve(configDir, '.cache');
      const stats = await stat(cacheDir).catch(() => null);
      if (!stats?.isDirectory()) {
        process.stdout.write(`No cache at ${cacheDir}; nothing to clean.\n`);
        return;
      }
      await rm(cacheDir, { recursive: true, force: true });
      process.stdout.write(`removed: ${cacheDir}\n`);
    } catch (err) {
      handleFatal(err);
    }
  });

program.parseAsync(process.argv).catch(handleFatal);

function resolveArg(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

async function loadWarnings(path: string | undefined): Promise<Warning[]> {
  if (!path) return [];
  const text = await readFile(resolveArg(path), 'utf-8');
  return JSON.parse(text) as Warning[];
}

function distinctCount<T, K>(items: T[], keyFn: (t: T) => K): number {
  const set = new Set<K>();
  for (const item of items) set.add(keyFn(item));
  return set.size;
}

function handleFatal(err: unknown): never {
  if (err instanceof ConfigError) {
    process.stderr.write(`config error: ${err.message}\n`);
    if (err.details) {
      process.stderr.write(JSON.stringify(err.details, null, 2) + '\n');
    }
    process.exit(2);
  }
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  if ((err as Error).stack) process.stderr.write((err as Error).stack + '\n');
  process.exit(1);
}
