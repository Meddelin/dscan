import picomatch from 'picomatch';
import { resolve as resolvePath } from 'node:path';
import type { TSESTree } from '@typescript-eslint/typescript-estree';
import type { ParsedFile } from './parse.js';
import type { PerRepoConfig } from '../config/schema.js';
import type { BeaverRegistry } from '../types/prescan.js';
import type { TsResolver } from '../resolve/ts-resolver.js';
import type {
  Bucket,
  ClassificationSource,
  Resolution,
  ShadowLevel,
  StructuralCategory,
  UnresolvedRecord,
  UsageRecord,
  Warning,
} from '../types/dataset.js';
import { SCHEMA_VERSION } from '../types/dataset.js';

const DEFAULT_PRIMITIVE_NAMES = new Set([
  'Button', 'Input', 'TextField', 'Select', 'Checkbox', 'Radio', 'Switch',
  'Toggle', 'Text', 'Heading', 'Title', 'Label', 'Icon', 'Avatar', 'Badge',
  'Tag', 'Chip', 'Card', 'Modal', 'Dialog', 'Drawer', 'Tooltip', 'Popover',
  'Popup', 'Menu', 'Dropdown', 'Tab', 'Tabs', 'Panel', 'Accordion',
  'Divider', 'Spacer', 'Stack', 'Flex', 'Grid', 'Box', 'Container',
  'Alert', 'Notification', 'Toast', 'Skeleton', 'Spinner', 'Loader',
  'Progress',
]);

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

export interface CategorizeContext {
  parsed: ParsedFile;
  perRepo: PerRepoConfig;
  repoRoot: string;
  resolver: TsResolver;
  beaverRegistry: BeaverRegistry;
  globalPrimitiveNames?: string[];
}

export interface CategorizeOutput {
  usages: UsageRecord[];
  unresolved: UnresolvedRecord[];
  warnings: Warning[];
}

/**
 * Runs Stages 3 (Resolve), 4 (Categorize), and 6 Этап A from the PRD on a
 * single parsed file (§4.4 / §4.6). Stage 6 Этап B is stubbed as the
 * primitive-name-only heuristic from M0 — real Stage 6 signals land in M2.
 */
export function categorizeFile(ctx: CategorizeContext): CategorizeOutput {
  const imports = collectImports(ctx.parsed.ast);
  const primitiveNames = new Set<string>(
    ctx.perRepo.primitiveNamesOverride ??
      ctx.globalPrimitiveNames ??
      [...DEFAULT_PRIMITIVE_NAMES],
  );
  const localLibs = buildLocalLibResolvers(ctx.perRepo, ctx.repoRoot);

  const usages: UsageRecord[] = [];
  const unresolved: UnresolvedRecord[] = [];
  const warnings: Warning[] = [];

  walkJsx(ctx.parsed.ast, (element) => {
    const tag = element.name;
    const componentName = readJsxTagName(tag);
    if (componentName === null) {
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

    if (isLowercaseTag(componentName)) {
      usages.push(
        buildUsage({
          parsed: ctx.parsed,
          element,
          componentName,
          category: 'html-native',
          bucket: 'neither',
          classificationSource: 'utility-heuristic',
          resolution: 'static',
        }),
      );
      return;
    }

    const binding = imports.get(componentName) ?? null;
    const classified = classifyImport({
      componentName,
      binding,
      ctx,
      localLibs,
      primitiveNames,
    });

    usages.push(
      buildUsage({
        parsed: ctx.parsed,
        element,
        componentName,
        ...classified,
        resolution: 'static',
      }),
    );
  });

  return { usages, unresolved, warnings };
}

function buildLocalLibResolvers(
  perRepo: PerRepoConfig,
  repoRoot: string,
): LocalLibraryResolver[] {
  return perRepo.localLibraries.map((lib) => {
    const matchSource = picomatch(lib.matchPattern);
    const abs = resolvePath(repoRoot, lib.source.path);
    const normalized = abs.replace(/\\/g, '/').toLowerCase();
    return {
      libId: lib.libId,
      kind: lib.kind,
      matchSource,
      pathPrefix: normalized.endsWith('/') ? normalized : normalized + '/',
    };
  });
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

function readJsxTagName(name: TSESTree.JSXTagNameExpression): string | null {
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXNamespacedName') {
    return `${name.namespace.name}:${name.name.name}`;
  }
  return null;
}

function isLowercaseTag(name: string): boolean {
  const first = name.charAt(0);
  return first === first.toLowerCase() && first !== first.toUpperCase();
}

interface ClassifyResult {
  category: StructuralCategory;
  bucket: Bucket;
  classificationSource: ClassificationSource;
  shadowLevel?: ShadowLevel;
  beaverPackage?: string;
  canonicalizedVia?: string;
  localLibId?: string;
  beaverBackedByLib?: boolean;
}

function classifyImport(args: {
  componentName: string;
  binding: ImportBinding | null;
  ctx: CategorizeContext;
  localLibs: LocalLibraryResolver[];
  primitiveNames: Set<string>;
}): ClassifyResult {
  const { componentName, binding, ctx, localLibs, primitiveNames } = args;

  if (!binding) {
    // Capitalized tag without a matching ImportDeclaration. Either defined
    // in-file (locally) or referenced via closure from outer scope. Treated
    // as `local` for Stage 6 Этап B purposes.
    return classifyLocal(componentName, primitiveNames);
  }

  const resolved = ctx.resolver.resolve(
    binding.source,
    ctx.parsed.file.absPath,
  );

  // Priority 1: Beaver package, canonicalized through the re-export map.
  if (resolved.kind === 'external' && ctx.beaverRegistry.packages.has(resolved.packageName)) {
    const pkgName = resolved.packageName;
    const symbol = binding.importedName ?? 'default';
    const reExport = ctx.beaverRegistry.reExports.get(pkgName)?.get(symbol);
    if (reExport && reExport.sourcePackage !== pkgName) {
      return {
        category: 'beaver',
        bucket: 'adoption',
        classificationSource: 'direct-beaver',
        beaverPackage: reExport.sourcePackage,
        canonicalizedVia: pkgName,
      };
    }
    return {
      category: 'beaver',
      bucket: 'adoption',
      classificationSource: 'direct-beaver',
      beaverPackage: pkgName,
    };
  }

  // Priority 2: local-library (per-repo config). Match by either import source
  // (for package-style locals like @team/kit) or resolved path (for directory
  // locals like src/shared/ui-kit/**).
  const libHit = matchLocalLib(binding.source, resolved, localLibs);
  if (libHit) {
    if (libHit.kind === 'partially-beaver-backed') {
      return {
        category: 'local-library',
        bucket: 'adoption',
        classificationSource: 'beaver-backed-wrapper',
        localLibId: libHit.libId,
        beaverBackedByLib: true,
      };
    }
    return {
      category: 'local-library',
      bucket: 'shadow',
      classificationSource: 'parallel-local-ui',
      shadowLevel: 'possible',
      localLibId: libHit.libId,
      beaverBackedByLib: false,
    };
  }

  // Priority 3: relative / alias resolved inside repo → local.
  if (resolved.kind === 'in-repo') {
    return classifyLocal(componentName, primitiveNames);
  }

  // Priority 4: fallback by source-shape when TS couldn't resolve.
  if (
    resolved.kind === 'unresolved' &&
    (binding.source.startsWith('./') ||
      binding.source.startsWith('../') ||
      binding.source.startsWith('/'))
  ) {
    return classifyLocal(componentName, primitiveNames);
  }

  // Priority 5: third-party (npm package, not Beaver).
  return {
    category: 'third-party',
    bucket: 'neither',
    classificationSource: 'utility-heuristic',
  };
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

function classifyLocal(
  componentName: string,
  primitiveNames: Set<string>,
): ClassifyResult {
  // Stage 6 Этап B stub (§4.6) — real signals + levels land in M2.
  if (primitiveNames.has(componentName)) {
    return {
      category: 'local',
      bucket: 'shadow',
      classificationSource: 'parallel-local-ui',
      shadowLevel: 'possible',
    };
  }
  return {
    category: 'local',
    bucket: 'neither',
    classificationSource: 'utility-heuristic',
  };
}

function buildUsage(args: {
  parsed: ParsedFile;
  element: TSESTree.JSXOpeningElement;
  componentName: string;
  category: StructuralCategory;
  bucket: Bucket;
  classificationSource: ClassificationSource;
  shadowLevel?: ShadowLevel | undefined;
  beaverPackage?: string | undefined;
  canonicalizedVia?: string | undefined;
  localLibId?: string | undefined;
  beaverBackedByLib?: boolean | undefined;
  resolution: Resolution;
}): UsageRecord {
  const {
    parsed,
    element,
    componentName,
    category,
    bucket,
    classificationSource,
    shadowLevel,
    beaverPackage,
    canonicalizedVia,
    localLibId,
    beaverBackedByLib,
    resolution,
  } = args;
  const record: UsageRecord = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'usage',
    repoId: parsed.file.repoId,
    filePath: parsed.file.relPath,
    line: element.loc.start.line,
    column: element.loc.start.column,
    componentName,
    category,
    bucket,
    classificationSource,
    route: { kind: 'unsupported' },
    resolution,
  };
  if (shadowLevel !== undefined) record.shadowLevel = shadowLevel;
  if (beaverPackage !== undefined) record.beaverPackage = beaverPackage;
  if (canonicalizedVia !== undefined) record.canonicalizedVia = canonicalizedVia;
  if (localLibId !== undefined) record.localLibId = localLibId;
  if (beaverBackedByLib !== undefined) record.beaverBackedByLib = beaverBackedByLib;
  return record;
}

