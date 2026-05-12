import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, resolve as resolvePath } from 'node:path';
import { parse, type TSESTree } from '@typescript-eslint/typescript-estree';
const JSX_EXT = new Set(['.tsx', '.jsx']);
import type { LocalLibrary } from '../config/schema.js';
import type { BeaverRegistry, LocalLibRegistry } from '../types/prescan.js';
import { createTsResolver, type TsResolver } from '../resolve/ts-resolver.js';

const BARREL_DEPTH_LIMIT = 5;
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

/**
 * A library declaration after path resolution. Used by both global (shared)
 * and per-repo prescans — the caller resolves `source.path` against the
 * appropriate base (configDir for shared libs, repoRoot for per-repo) and
 * stores it as `sourceAbsPath`.
 */
export interface ResolvedLibrary {
  libId: string;
  matchPattern: string;
  sourceAbsPath: string;
  kind: 'partially-beaver-backed' | 'fully-custom';
  /** Diagnostic: where this declaration came from. */
  scope: 'shared' | 'repo';
}

export function resolveLibraries(
  libs: LocalLibrary[],
  baseDir: string,
  scope: 'shared' | 'repo',
): ResolvedLibrary[] {
  return libs.map((lib) => ({
    libId: lib.libId,
    matchPattern: lib.matchPattern,
    sourceAbsPath: resolvePath(baseDir, lib.source.path),
    kind: lib.kind,
    scope,
  }));
}

/**
 * Merge two ResolvedLibrary arrays by libId. Entries from {@link override}
 * (typically per-repo) win on conflict. Order: overrides first, then any
 * shared entries not overridden — gives operators predictable iteration
 * order when debugging.
 */
export function mergeLibraries(
  base: ResolvedLibrary[],
  override: ResolvedLibrary[],
): ResolvedLibrary[] {
  const out: ResolvedLibrary[] = [...override];
  const overriddenIds = new Set(override.map((l) => l.libId));
  for (const lib of base) {
    if (!overriddenIds.has(lib.libId)) out.push(lib);
  }
  return out;
}

/**
 * Stage 5b (§4.5) prescan. Walks each library's resolved source directory,
 * decides for every exported component whether it's Beaver-backed.
 *
 * Generic over scope: callers pass a pre-resolved {@link ResolvedLibrary[]}
 * (use {@link resolveLibraries} + {@link mergeLibraries}) and a base
 * directory for `tsconfig.json` lookup (configDir for shared, repoRoot for
 * per-repo).
 */
export async function prescanLibraries(
  libs: ResolvedLibrary[],
  tsconfigBaseDir: string,
  beaverRegistry: BeaverRegistry,
  tsconfigRel: string,
): Promise<LocalLibRegistry> {
  const byLib = new Map<string, Map<string, boolean>>();
  const prescanFailed: string[] = [];

  if (libs.length === 0) {
    return { byLib, prescanFailed };
  }

  const resolver = await createTsResolver(tsconfigBaseDir, tsconfigRel);

  for (const lib of libs) {
    try {
      const scan = await scanLibrary(lib.sourceAbsPath, resolver, beaverRegistry);
      byLib.set(lib.libId, flattenBacking(scan));
    } catch {
      prescanFailed.push(lib.libId);
      byLib.set(lib.libId, new Map());
    }
  }

  return { byLib, prescanFailed };
}

/**
 * Backward-compatible wrapper for the original per-repo signature. Tests
 * still call this; production code goes through `prescanLibraries` with
 * pre-merged libraries.
 */
export async function prescanLocalLibs(
  perRepo: { localLibraries: LocalLibrary[] },
  repoRoot: string,
  beaverRegistry: BeaverRegistry,
  tsconfigRel: string,
): Promise<LocalLibRegistry> {
  const resolved = resolveLibraries(perRepo.localLibraries, repoRoot, 'repo');
  return prescanLibraries(resolved, repoRoot, beaverRegistry, tsconfigRel);
}

/** Merge two registries — overrides win per libId, matching {@link mergeLibraries}. */
export function mergeRegistries(
  base: LocalLibRegistry,
  override: LocalLibRegistry,
): LocalLibRegistry {
  const byLib = new Map(base.byLib);
  for (const [libId, entries] of override.byLib) {
    byLib.set(libId, entries);
  }
  return {
    byLib,
    prescanFailed: [...new Set([...base.prescanFailed, ...override.prescanFailed])],
  };
}

interface FileScan {
  absPath: string;
  hasBeaverImport: boolean;
  ownComponents: Set<string>;
  reExports: Array<{
    localSymbol: string;
    sourceSymbol: string;
    sourceFile: string | null;
  }>;
}

async function scanLibrary(
  libRoot: string,
  resolver: TsResolver,
  beaverRegistry: BeaverRegistry,
): Promise<Map<string, FileScan>> {
  const files = await collectFiles(libRoot);
  const scans = new Map<string, FileScan>();

  for (const absPath of files) {
    const raw = await readFile(absPath, 'utf-8').catch(() => null);
    if (raw === null) continue;
    let ast: TSESTree.Program;
    try {
      ast = parse(raw, {
        loc: true,
        jsx: JSX_EXT.has(extname(absPath).toLowerCase()),
      });
    } catch {
      continue;
    }
    scans.set(normalize(absPath), analyzeFile(absPath, ast, resolver, beaverRegistry));
  }

  return scans;
}

async function collectFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const stats = await stat(root).catch(() => null);
  if (!stats?.isDirectory()) return out;

  const queue: string[] = [root];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (
          e.name === 'node_modules' ||
          e.name === 'dist' ||
          e.name === 'build' ||
          e.name === '.git'
        ) continue;
        queue.push(full);
      } else if (e.isFile() && SCAN_EXTENSIONS.has(extname(e.name))) {
        out.push(full);
      }
    }
  }
  return out;
}

function analyzeFile(
  absPath: string,
  ast: TSESTree.Program,
  resolver: TsResolver,
  beaverRegistry: BeaverRegistry,
): FileScan {
  const scan: FileScan = {
    absPath,
    hasBeaverImport: false,
    ownComponents: new Set<string>(),
    reExports: [],
  };

  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      const resolved = resolver.resolve(node.source.value, absPath);
      if (
        resolved.kind === 'external' &&
        beaverRegistry.packages.has(resolved.packageName)
      ) {
        scan.hasBeaverImport = true;
      }
    } else if (node.type === 'ExportNamedDeclaration') {
      if (node.source) {
        const resolved = resolver.resolve(node.source.value, absPath);
        const sourceFile = resolved.kind === 'in-repo' ? normalize(resolved.absPath) : null;
        for (const spec of node.specifiers) {
          if (spec.type !== 'ExportSpecifier') continue;
          const exported = nameOf(spec.exported);
          const local = nameOf(spec.local);
          if (!exported || !local) continue;
          scan.reExports.push({
            localSymbol: exported,
            sourceSymbol: local,
            sourceFile,
          });
        }
      } else if (node.declaration) {
        for (const name of collectDeclNames(node.declaration)) {
          if (isCapitalised(name)) scan.ownComponents.add(name);
        }
      } else {
        for (const spec of node.specifiers) {
          if (spec.type !== 'ExportSpecifier') continue;
          const exported = nameOf(spec.exported);
          if (exported && isCapitalised(exported)) scan.ownComponents.add(exported);
        }
      }
    } else if (node.type === 'ExportAllDeclaration') {
      const resolved = resolver.resolve(node.source.value, absPath);
      const sourceFile = resolved.kind === 'in-repo' ? normalize(resolved.absPath) : null;
      scan.reExports.push({
        localSymbol: '*',
        sourceSymbol: '*',
        sourceFile,
      });
    } else if (node.type === 'ExportDefaultDeclaration') {
      scan.ownComponents.add('default');
    }
  }

  return scan;
}

/**
 * Walk every exposed (own + re-export) symbol of every file and compute
 * its Beaver-backing flag.
 */
function flattenBacking(scans: Map<string, FileScan>): Map<string, boolean> {
  const out = new Map<string, boolean>();

  for (const file of scans.values()) {
    for (const own of file.ownComponents) {
      const cur = out.get(own);
      out.set(own, cur === true ? true : file.hasBeaverImport);
    }
    for (const re of file.reExports) {
      if (re.localSymbol === '*') continue;
      if (!isCapitalised(re.localSymbol)) continue;
      const backed = traceBacking(re.sourceFile, re.sourceSymbol, scans, new Set(), 0);
      const existing = out.get(re.localSymbol);
      out.set(re.localSymbol, existing === true ? true : backed);
    }
  }

  // Star re-exports: fan out after we know each file's own components.
  for (const file of scans.values()) {
    for (const re of file.reExports) {
      if (re.localSymbol !== '*' || !re.sourceFile) continue;
      const source = scans.get(re.sourceFile);
      if (!source) continue;
      for (const own of source.ownComponents) {
        const existing = out.get(own);
        out.set(own, existing === true ? true : source.hasBeaverImport);
      }
    }
  }

  return out;
}

function traceBacking(
  sourceFile: string | null,
  symbol: string,
  scans: Map<string, FileScan>,
  visited: Set<string>,
  depth: number,
): boolean {
  if (!sourceFile) return false;
  if (depth > BARREL_DEPTH_LIMIT) return false;
  if (visited.has(sourceFile)) return false;

  const scan = scans.get(sourceFile);
  if (!scan) return false;

  if (scan.ownComponents.has(symbol)) {
    return scan.hasBeaverImport;
  }

  const next = new Set(visited).add(sourceFile);
  // Direct re-export hop.
  for (const re of scan.reExports) {
    if (re.localSymbol === symbol) {
      if (traceBacking(re.sourceFile, re.sourceSymbol, scans, next, depth + 1)) {
        return true;
      }
    }
  }
  // Star re-exports: try each.
  for (const re of scan.reExports) {
    if (re.localSymbol === '*' && re.sourceFile) {
      if (traceBacking(re.sourceFile, symbol, scans, next, depth + 1)) return true;
    }
  }
  return false;
}

function nameOf(node: TSESTree.Node): string | null {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

function collectDeclNames(decl: TSESTree.Node): string[] {
  switch (decl.type) {
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
      return decl.id ? [decl.id.name] : [];
    case 'VariableDeclaration':
      return decl.declarations
        .map((d) => (d.id.type === 'Identifier' ? d.id.name : null))
        .filter((x): x is string => x !== null);
    default:
      return [];
  }
}

function isCapitalised(name: string): boolean {
  const first = name.charAt(0);
  return first === first.toUpperCase() && first !== first.toLowerCase();
}

function normalize(p: string): string {
  return resolvePath(p).replace(/\\/g, '/').toLowerCase();
}
