import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { parse, type TSESTree } from '@typescript-eslint/typescript-estree';
import type { BeaverRegistry, ReExportEntry } from '../types/prescan.js';
import { createTsResolver, type TsResolver } from '../resolve/ts-resolver.js';
import { gitClone, gitDescribe, isGitRepo } from '../ops/git.js';

const RE_EXPORT_DEPTH_LIMIT = 5;
const ENTRY_CANDIDATES = ['src/index.ts', 'src/index.tsx', 'index.ts', 'src/index.js'];

export interface PrescanBeaverOptions {
  /** SSH URL from global config (§9.1). Required unless localOverride supplied. */
  beaverUrl: string;
  /** Absolute cache directory (usually `.cache/beaver-ui/`). */
  cacheDir: string;
  /**
   * Skip clone: assume Beaver is already checked out at this path.
   * Populated from `BEAVER_LOCAL_PATH` env for tests/CI (see §10.2).
   */
  localOverride?: string;
}

export async function prescanBeaver(
  opts: PrescanBeaverOptions,
): Promise<BeaverRegistry> {
  const rootPath = await ensureBeaverCheckout(opts);
  const version = await gitDescribe(rootPath).catch(() => 'unknown');

  const packageRoots = await discoverPackages(rootPath);
  const packageByPath = new Map<string, string>();
  for (const [name, absPath] of packageRoots) {
    packageByPath.set(normalize(absPath), name);
  }

  const resolver = await createTsResolver(rootPath, 'tsconfig.base.json');

  const packages = new Set<string>();
  const ownExports = new Map<string, Set<string>>();
  const rawReExports = new Map<string, Array<RawReExport>>();
  const unresolvedPackages: string[] = [];

  for (const [pkgName, pkgRoot] of packageRoots) {
    packages.add(pkgName);
    const entryFile = await findEntryFile(pkgRoot);
    if (!entryFile) {
      unresolvedPackages.push(pkgName);
      continue;
    }
    try {
      const source = await readFile(entryFile, 'utf-8');
      const ast = parse(source, { loc: true, jsx: true });
      const parsed = parseEntryFile(
        ast,
        entryFile,
        pkgName,
        resolver,
        packageByPath,
      );
      ownExports.set(pkgName, parsed.ownExports);
      rawReExports.set(pkgName, parsed.reExports);
    } catch {
      unresolvedPackages.push(pkgName);
    }
  }

  const reExports = flattenReExports(packages, ownExports, rawReExports);

  return {
    version,
    rootPath,
    packages,
    exports: ownExports,
    reExports,
    unresolvedPackages,
  };
}

/**
 * Returns path to Beaver checkout. BEAVER_LOCAL_PATH / opts.localOverride
 * take precedence over `cacheDir`; cache hit reuses existing clone.
 */
async function ensureBeaverCheckout(opts: PrescanBeaverOptions): Promise<string> {
  const override = opts.localOverride ?? process.env.BEAVER_LOCAL_PATH;
  if (override) {
    const abs = resolvePath(override);
    const exists = await stat(abs).catch(() => null);
    if (!exists?.isDirectory()) {
      throw new Error(`BEAVER_LOCAL_PATH does not exist or is not a directory: ${abs}`);
    }
    return abs;
  }
  const absCache = resolvePath(opts.cacheDir);
  if (await isGitRepo(absCache)) {
    return absCache;
  }
  // Fail-fast per PRD §8.3: no retry on git clone failure.
  await gitClone(opts.beaverUrl, absCache, {
    depth: 1,
    singleBranch: true,
  });
  return absCache;
}

async function discoverPackages(rootPath: string): Promise<Array<[string, string]>> {
  const pkgsDir = join(rootPath, 'packages');
  const entries = await readdir(pkgsDir).catch(() => [] as string[]);
  const out: Array<[string, string]> = [];
  for (const entry of entries) {
    const absPkg = join(pkgsDir, entry);
    const stats = await stat(absPkg).catch(() => null);
    if (!stats?.isDirectory()) continue;
    const pkgJsonPath = join(absPkg, 'package.json');
    const text = await readFile(pkgJsonPath, 'utf-8').catch(() => null);
    if (!text) continue;
    let parsed: { name?: unknown };
    try {
      parsed = JSON.parse(text) as { name?: unknown };
    } catch {
      continue;
    }
    if (typeof parsed.name !== 'string' || parsed.name.length === 0) continue;
    out.push([parsed.name, absPkg]);
  }
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

async function findEntryFile(pkgRoot: string): Promise<string | null> {
  for (const candidate of ENTRY_CANDIDATES) {
    const abs = join(pkgRoot, candidate);
    const stats = await stat(abs).catch(() => null);
    if (stats?.isFile()) return abs;
  }
  return null;
}

interface RawReExport {
  /** Local symbol name as the package exposes it. */
  localSymbol: string;
  /** Symbol as named in the source (may differ if aliased via `export { X as Y }`). */
  sourceSymbol: string;
  /** Resolved source — either another Beaver package or null (external/unknown). */
  sourcePackage: string | null;
  /** True if `export *` with no rename — all source exports pass through. */
  isStarReExport: boolean;
}

interface ParsedEntry {
  ownExports: Set<string>;
  reExports: RawReExport[];
}

function parseEntryFile(
  ast: TSESTree.Program,
  entryFile: string,
  currentPackage: string,
  resolver: TsResolver,
  packageByPath: Map<string, string>,
): ParsedEntry {
  const ownExports = new Set<string>();
  const reExports: RawReExport[] = [];

  for (const node of ast.body) {
    if (node.type === 'ExportNamedDeclaration') {
      if (node.source) {
        // `export { X [as Y] } from 'source'` — classify by where 'source'
        // lives: same package → own export; different package → re-export.
        const sourcePackage = resolveToPackage(
          node.source.value,
          entryFile,
          resolver,
          packageByPath,
        );
        const isSelf = sourcePackage === currentPackage || sourcePackage === null;
        for (const spec of node.specifiers) {
          if (spec.type !== 'ExportSpecifier') continue;
          const exported = readIdentifierOrString(spec.exported);
          const local = readIdentifierOrString(spec.local);
          if (exported === null || local === null) continue;
          if (isSelf) {
            ownExports.add(exported);
          } else {
            reExports.push({
              localSymbol: exported,
              sourceSymbol: local,
              sourcePackage,
              isStarReExport: false,
            });
          }
        }
      } else if (node.declaration) {
        for (const name of collectDeclaredNames(node.declaration)) {
          ownExports.add(name);
        }
      } else {
        // `export { X }` without source → re-export of a local binding.
        for (const spec of node.specifiers) {
          if (spec.type !== 'ExportSpecifier') continue;
          const exported = readIdentifierOrString(spec.exported);
          if (exported !== null) ownExports.add(exported);
        }
      }
    } else if (node.type === 'ExportAllDeclaration') {
      const sourcePackage = resolveToPackage(
        node.source.value,
        entryFile,
        resolver,
        packageByPath,
      );
      const alias =
        node.exported && node.exported.type === 'Identifier'
          ? node.exported.name
          : null;
      if (alias) {
        ownExports.add(alias);
      } else if (sourcePackage === currentPackage || sourcePackage === null) {
        // `export * from './file'` — stays internal; nothing to do at this layer.
        // Individual symbols are already surfaced via each file's index re-exports.
      } else {
        reExports.push({
          localSymbol: '*',
          sourceSymbol: '*',
          sourcePackage,
          isStarReExport: true,
        });
      }
    } else if (node.type === 'ExportDefaultDeclaration') {
      ownExports.add('default');
    }
  }

  return { ownExports, reExports };
}

function resolveToPackage(
  source: string,
  importerFile: string,
  resolver: TsResolver,
  packageByPath: Map<string, string>,
): string | null {
  const result = resolver.resolve(source, importerFile);
  if (result.kind === 'in-repo') {
    const normalized = normalize(result.absPath);
    // Walk up until we find a directory registered as a package root.
    let cur = dirname(normalized);
    while (cur.length > 1) {
      const hit = packageByPath.get(cur);
      if (hit) return hit;
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return null;
  }
  if (result.kind === 'external') {
    return result.packageName;
  }
  return null;
}

function collectDeclaredNames(decl: TSESTree.Node): string[] {
  const names: string[] = [];
  switch (decl.type) {
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
      if (decl.id) names.push(decl.id.name);
      break;
    case 'VariableDeclaration':
      for (const v of decl.declarations) {
        if (v.id.type === 'Identifier') names.push(v.id.name);
      }
      break;
    case 'TSInterfaceDeclaration':
    case 'TSTypeAliasDeclaration':
    case 'TSEnumDeclaration':
      names.push(decl.id.name);
      break;
    default:
      break;
  }
  return names;
}

function readIdentifierOrString(node: TSESTree.Node): string | null {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

/**
 * Flatten re-export chains: follow `packageA → packageB → packageC` up to
 * depth 5 (§4.5). Cycles are detected by visited-set, not depth alone.
 */
function flattenReExports(
  packages: Set<string>,
  ownExports: Map<string, Set<string>>,
  rawReExports: Map<string, RawReExport[]>,
): Map<string, Map<string, ReExportEntry>> {
  const out = new Map<string, Map<string, ReExportEntry>>();

  for (const [pkg, reEx] of rawReExports) {
    const entries = new Map<string, ReExportEntry>();
    // Own exports are recorded as hop-0 entries so consumers importing directly
    // from this package still get a registry hit (useful for non-aggregators).
    for (const sym of ownExports.get(pkg) ?? []) {
      entries.set(sym, { sourcePackage: pkg, sourceSymbol: sym, hops: 0 });
    }

    for (const re of reEx) {
      if (re.isStarReExport) {
        // `export * from 'pkg'` — fan out: every symbol that `pkg` exports is
        // also available under `this package`, canonicalized to `pkg`.
        if (re.sourcePackage && packages.has(re.sourcePackage)) {
          const chain = followChain(re.sourcePackage, ownExports, rawReExports);
          for (const [sym, entry] of chain) {
            if (!entries.has(sym)) {
              entries.set(sym, { ...entry, hops: entry.hops + 1 });
            }
          }
        }
        continue;
      }
      if (!re.sourcePackage) continue; // unresolved / external non-Beaver
      const entry = traceSymbol(
        re.sourcePackage,
        re.sourceSymbol,
        ownExports,
        rawReExports,
        packages,
        new Set([pkg]),
        0,
      );
      if (entry) {
        entries.set(re.localSymbol, { ...entry, hops: entry.hops + 1 });
      }
    }

    if (entries.size > 0) out.set(pkg, entries);
  }

  return out;
}

function traceSymbol(
  pkg: string,
  symbol: string,
  ownExports: Map<string, Set<string>>,
  rawReExports: Map<string, RawReExport[]>,
  packages: Set<string>,
  visited: Set<string>,
  depth: number,
): ReExportEntry | null {
  if (visited.has(pkg)) return null;
  if (depth > RE_EXPORT_DEPTH_LIMIT) return null;
  if (!packages.has(pkg)) return null;

  if (ownExports.get(pkg)?.has(symbol)) {
    return { sourcePackage: pkg, sourceSymbol: symbol, hops: 0 };
  }

  const reEx = rawReExports.get(pkg) ?? [];
  const direct = reEx.find((r) => !r.isStarReExport && r.localSymbol === symbol);
  if (direct) {
    if (!direct.sourcePackage) return null;
    const nextVisited = new Set(visited).add(pkg);
    const nested = traceSymbol(
      direct.sourcePackage,
      direct.sourceSymbol,
      ownExports,
      rawReExports,
      packages,
      nextVisited,
      depth + 1,
    );
    return nested ? { ...nested, hops: nested.hops + 1 } : null;
  }

  // Fallback: this package has `export * from 'src'`; check each star source.
  for (const re of reEx) {
    if (!re.isStarReExport || !re.sourcePackage) continue;
    const nextVisited = new Set(visited).add(pkg);
    const nested = traceSymbol(
      re.sourcePackage,
      symbol,
      ownExports,
      rawReExports,
      packages,
      nextVisited,
      depth + 1,
    );
    if (nested) return { ...nested, hops: nested.hops + 1 };
  }

  return null;
}

function followChain(
  pkg: string,
  ownExports: Map<string, Set<string>>,
  rawReExports: Map<string, RawReExport[]>,
): Map<string, ReExportEntry> {
  const out = new Map<string, ReExportEntry>();
  for (const sym of ownExports.get(pkg) ?? []) {
    out.set(sym, { sourcePackage: pkg, sourceSymbol: sym, hops: 0 });
  }
  return out;
}

function normalize(p: string): string {
  return resolvePath(p).replace(/\\/g, '/').toLowerCase();
}
