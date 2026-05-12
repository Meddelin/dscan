import picomatch from 'picomatch';
import type { TSESTree } from '@typescript-eslint/typescript-estree';
import type { ParsedFile } from './parse.js';
import type { PerRepoConfig } from '../config/schema.js';
import type { BeaverRegistry, LocalLibRegistry } from '../types/prescan.js';
import type { ResolvedLibrary } from '../prescan/local-lib.js';
import type { TsResolver } from '../resolve/ts-resolver.js';
import type {
  ClassificationSource,
  Resolution,
  ShadowLevel,
  StructuralCategory,
  UnresolvedRecord,
  UsageRecord,
  Warning,
} from '../types/dataset.js';
import { SCHEMA_VERSION } from '../types/dataset.js';

interface ImportBinding {
  source: string;
  importedName: string | null; // null for default, '*' for namespace
  localName: string;
}

interface LocalLibraryResolver {
  libId: string;
  kind: 'partially-beaver-backed' | 'fully-custom';
  matchSource: (source: string) => boolean;
  pathPrefix: string; // lowercased, forward-slashed, trailing '/'
}

/**
 * A raw usage that Pass-A could NOT classify fully because it needs the
 * component profile built across all files. Owns enough info for run.ts
 * to resolve the profile in Pass-B and emit the final UsageRecord.
 */
export interface PendingUsage {
  /** Absolute path of the file containing the JSX element. */
  importerAbsPath: string;
  /** Absolute path of the file where the component is defined (may equal importer). */
  definingAbsPath: string;
  /** Symbol name on the defining side (may differ from JSX name when aliased). */
  definingSymbol: string;
  /** The JSX tag name as it appeared in source. */
  componentName: string;
  /** Partial UsageRecord already filled except bucket/source/shadowLevel. */
  partial: UsagePartial;
  /** Was the binding a local-library match? (affects libId metadata) */
  localLibId: string | null;
  /** Local-library kind if matched — 'fully-custom' flows through Pass-B. */
  localLibKind: 'partially-beaver-backed' | 'fully-custom' | null;
}

export interface UsagePartial {
  repoId: string;
  filePath: string;
  line: number;
  column: number;
  componentName: string;
  category: StructuralCategory;
  resolution: Resolution;
}

export type PreClassified =
  | { kind: 'finalized'; record: UsageRecord }
  | { kind: 'pending'; pending: PendingUsage };

export interface CollectContext {
  parsed: ParsedFile;
  perRepo: PerRepoConfig;
  repoRoot: string;
  resolver: TsResolver;
  beaverRegistry: BeaverRegistry;
  localLibRegistry: LocalLibRegistry;
  /**
   * Pre-merged (shared + per-repo) libraries with paths already resolved.
   * collect.ts no longer needs to know about per-repo vs global scope;
   * run.ts hands it the effective list.
   */
  effectiveLibraries: ResolvedLibrary[];
}

export interface CollectResult {
  preClassified: PreClassified[];
  unresolved: UnresolvedRecord[];
  warnings: Warning[];
}

/**
 * Pass-A collector. Emits:
 *   - fully-classified records for html-native / beaver / third-party /
 *     partially-beaver-backed local-library (Stage 6 Этап A per §4.6).
 *   - PendingUsage rows for `local` + fully-custom `local-library`, deferred
 *     to Pass-B after profiles are available.
 */
export function collectUsages(ctx: CollectContext): CollectResult {
  const imports = collectImports(ctx.parsed.ast);
  const localLibs = buildLocalLibResolvers(ctx.effectiveLibraries);

  const preClassified: PreClassified[] = [];
  const unresolved: UnresolvedRecord[] = [];
  const warnings: Warning[] = [];

  walkJsx(ctx.parsed.ast, (element) => {
    const tag = readJsxTagName(element.name);
    if (tag === null) {
      unresolved.push({
        schemaVersion: SCHEMA_VERSION,
        kind: 'unresolved-dynamic',
        repoId: ctx.parsed.file.repoId,
        filePath: ctx.parsed.file.relPath,
        line: element.loc.start.line,
        reason: 'member-expression-not-supported',
        context: ctx.parsed.source
          .slice(element.range[0], element.range[1])
          .slice(0, 80),
      });
      return;
    }

    const componentName = tag.full;
    const partial: UsagePartial = {
      repoId: ctx.parsed.file.repoId,
      filePath: ctx.parsed.file.relPath,
      line: element.loc.start.line,
      column: element.loc.start.column,
      componentName,
      category: 'html-native',
      resolution: 'static',
    };

    if (isLowercaseTag(componentName)) {
      preClassified.push({
        kind: 'finalized',
        record: finalize(partial, {
          bucket: 'neither',
          classificationSource: 'utility-heuristic',
        }),
      });
      return;
    }

    // Look up by the BASE identifier — `<Form.Item/>` resolves through
    // `Form`'s import binding (§5.5).
    const binding = imports.get(tag.base) ?? null;
    const isMember = tag.full !== tag.base;

    // Priority 1: Beaver (canonicalized).
    if (binding) {
      const resolved = ctx.resolver.resolve(binding.source, ctx.parsed.file.absPath);
      if (
        resolved.kind === 'external' &&
        ctx.beaverRegistry.packages.has(resolved.packageName)
      ) {
        const pkgName = resolved.packageName;
        const symbol = binding.importedName ?? 'default';
        const reExport = ctx.beaverRegistry.reExports.get(pkgName)?.get(symbol);
        const extra: Partial<UsageRecord> = {
          beaverPackage:
            reExport && reExport.sourcePackage !== pkgName
              ? reExport.sourcePackage
              : pkgName,
        };
        if (reExport && reExport.sourcePackage !== pkgName) {
          extra.canonicalizedVia = pkgName;
        }
        const beaverPartial = { ...partial, category: 'beaver' as const };
        preClassified.push({
          kind: 'finalized',
          record: finalize(beaverPartial, {
            bucket: 'adoption',
            classificationSource: 'direct-beaver',
            extra,
          }),
        });
        return;
      }

      // Priority 2: local-library match — per-component backing from prescan.
      const libHit = matchLocalLib(binding.source, resolved, localLibs);
      if (libHit) {
        const libPartial = { ...partial, category: 'local-library' as const };
        const symbol = binding.importedName ?? 'default';
        const prescanned = ctx.localLibRegistry.byLib.get(libHit.libId)?.get(symbol);
        const backed =
          prescanned !== undefined
            ? prescanned
            : libHit.kind === 'partially-beaver-backed';
        if (backed) {
          preClassified.push({
            kind: 'finalized',
            record: finalize(libPartial, {
              bucket: 'adoption',
              classificationSource: 'beaver-backed-wrapper',
              extra: {
                localLibId: libHit.libId,
                beaverBackedByLib: true,
              },
            }),
          });
          return;
        }
        preClassified.push({
          kind: 'pending',
          pending: buildPending(ctx, resolved, binding, libPartial, {
            localLibId: libHit.libId,
            localLibKind: 'fully-custom',
          }),
        });
        return;
      }

      // Priority 3: relative / alias resolved in-repo → local.
      if (resolved.kind === 'in-repo') {
        const localPartial = { ...partial, category: 'local' as const };
        preClassified.push({
          kind: 'pending',
          pending: buildPending(ctx, resolved, binding, localPartial, {
            localLibId: null,
            localLibKind: null,
            // For member expressions like `<NS.Comp/>` the profile we want
            // lives at (importedFile, "Comp"), not (importedFile, "NS").
            symbolOverride: isMember ? lastSegment(tag.full) : null,
          }),
        });
        return;
      }

      // Priority 4: source-shape fallback when TS couldn't resolve.
      if (
        resolved.kind === 'unresolved' &&
        (binding.source.startsWith('./') ||
          binding.source.startsWith('../') ||
          binding.source.startsWith('/'))
      ) {
        const localPartial = { ...partial, category: 'local' as const };
        preClassified.push({
          kind: 'pending',
          pending: buildPending(ctx, resolved, binding, localPartial, {
            localLibId: null,
            localLibKind: null,
            symbolOverride: isMember ? lastSegment(tag.full) : null,
          }),
        });
        return;
      }

      // Priority 5: third-party (npm package, not Beaver).
      preClassified.push({
        kind: 'finalized',
        record: finalize(
          { ...partial, category: 'third-party' },
          {
            bucket: 'neither',
            classificationSource: 'utility-heuristic',
          },
        ),
      });
      return;
    }

    // Capitalised JSX without an import binding: defined in-file.
    preClassified.push({
      kind: 'pending',
      pending: {
        importerAbsPath: ctx.parsed.file.absPath,
        definingAbsPath: ctx.parsed.file.absPath,
        definingSymbol: componentName,
        componentName,
        partial: { ...partial, category: 'local' },
        localLibId: null,
        localLibKind: null,
      },
    });
  });

  return { preClassified, unresolved, warnings };
}

function buildPending(
  ctx: CollectContext,
  resolved: ReturnType<TsResolver['resolve']>,
  binding: ImportBinding,
  partial: UsagePartial,
  lib: {
    localLibId: string | null;
    localLibKind: 'partially-beaver-backed' | 'fully-custom' | null;
    symbolOverride?: string | null;
  },
): PendingUsage {
  const definingAbsPath =
    resolved.kind === 'in-repo' ? resolved.absPath : ctx.parsed.file.absPath;
  const definingSymbol =
    lib.symbolOverride ?? binding.importedName ?? binding.localName;
  return {
    importerAbsPath: ctx.parsed.file.absPath,
    definingAbsPath,
    definingSymbol,
    componentName: partial.componentName,
    partial,
    localLibId: lib.localLibId,
    localLibKind: lib.localLibKind,
  };
}

function lastSegment(dotted: string): string {
  const idx = dotted.lastIndexOf('.');
  return idx === -1 ? dotted : dotted.slice(idx + 1);
}

function finalize(
  partial: UsagePartial,
  args: {
    bucket: UsageRecord['bucket'];
    classificationSource: ClassificationSource;
    shadowLevel?: ShadowLevel;
    extra?: Partial<UsageRecord>;
  },
): UsageRecord {
  const record: UsageRecord = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'usage',
    repoId: partial.repoId,
    filePath: partial.filePath,
    line: partial.line,
    column: partial.column,
    componentName: partial.componentName,
    category: partial.category,
    bucket: args.bucket,
    classificationSource: args.classificationSource,
    route: { kind: 'unsupported' },
    resolution: partial.resolution,
  };
  if (args.shadowLevel !== undefined) record.shadowLevel = args.shadowLevel;
  if (args.extra) {
    Object.assign(record, args.extra);
  }
  return record;
}

function buildLocalLibResolvers(
  libs: ResolvedLibrary[],
): LocalLibraryResolver[] {
  return libs.map((lib) => {
    const matchSource = picomatch(lib.matchPattern);
    const normalized = lib.sourceAbsPath.replace(/\\/g, '/').toLowerCase();
    return {
      libId: lib.libId,
      kind: lib.kind,
      matchSource,
      pathPrefix: normalized.endsWith('/') ? normalized : normalized + '/',
    };
  });
}

function matchLocalLib(
  source: string,
  resolved: ReturnType<TsResolver['resolve']>,
  localLibs: LocalLibraryResolver[],
): LocalLibraryResolver | null {
  for (const lib of localLibs) {
    if (lib.matchSource(source)) return lib;
    if (resolved.kind === 'in-repo') {
      const normalized = resolved.absPath.replace(/\\/g, '/').toLowerCase();
      if (normalized.startsWith(lib.pathPrefix)) return lib;
    }
  }
  return null;
}

function collectImports(ast: TSESTree.Program): Map<string, ImportBinding> {
  const out = new Map<string, ImportBinding>();
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const source = node.source.value;
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportDefaultSpecifier') {
        out.set(spec.local.name, {
          source,
          importedName: null,
          localName: spec.local.name,
        });
      } else if (spec.type === 'ImportNamespaceSpecifier') {
        out.set(spec.local.name, {
          source,
          importedName: '*',
          localName: spec.local.name,
        });
      } else if (spec.type === 'ImportSpecifier') {
        const imported =
          spec.imported.type === 'Identifier'
            ? spec.imported.name
            : String(spec.imported.value);
        out.set(spec.local.name, {
          source,
          importedName: imported,
          localName: spec.local.name,
        });
      }
    }
  }
  return out;
}

function walkJsx(
  ast: TSESTree.Program,
  visit: (element: TSESTree.JSXOpeningElement) => void,
): void {
  const stack: TSESTree.Node[] = [ast];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'JSXElement') {
      visit(node.openingElement);
    }
    pushChildren(node, stack);
  }
}

function pushChildren(node: TSESTree.Node, stack: TSESTree.Node[]): void {
  for (const key of Object.keys(node) as Array<keyof typeof node>) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue;
    const value = node[key] as unknown;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && 'type' in item) {
          stack.push(item as TSESTree.Node);
        }
      }
    } else if (value && typeof value === 'object' && 'type' in value) {
      stack.push(value as TSESTree.Node);
    }
  }
}

/**
 * §5.5 — JSX member expressions like `<Form.Item/>` or `<NS.Sub.X/>`.
 * Returns:
 *   - `full`: dotted/joined display name (`Form.Item`, `NS.Sub.X`,
 *     `svg:path` for namespaced).
 *   - `base`: the leftmost identifier — what we look up in the file's
 *     ImportDeclarations to determine origin.
 */
function readJsxTagName(
  name: TSESTree.JSXTagNameExpression,
): { full: string; base: string } | null {
  if (name.type === 'JSXIdentifier') {
    return { full: name.name, base: name.name };
  }
  if (name.type === 'JSXNamespacedName') {
    return {
      full: `${name.namespace.name}:${name.name.name}`,
      base: name.namespace.name,
    };
  }
  if (name.type === 'JSXMemberExpression') {
    const left = readJsxTagName(name.object);
    if (!left) return null;
    return {
      full: `${left.full}.${name.property.name}`,
      base: left.base,
    };
  }
  return null;
}

function isLowercaseTag(name: string): boolean {
  const first = name.charAt(0);
  return first === first.toLowerCase() && first !== first.toUpperCase();
}
