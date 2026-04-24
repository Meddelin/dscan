import picomatch from 'picomatch';
import type { TSESTree } from '@typescript-eslint/typescript-estree';
import type { ParsedFile } from './parse.js';
import type { GlobalConfig, PerRepoConfig } from '../config/schema.js';
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
  match: (source: string) => boolean;
}

export interface CategorizeOutput {
  usages: UsageRecord[];
  unresolved: UnresolvedRecord[];
  warnings: Warning[];
}

/**
 * Combines Stages 3 (Resolve — MVP-simplified to raw import-source),
 * 4 (Categorize), and 6 (Classify — structural-only) from §4.4/§4.6 Этап A.
 *
 * MVP trade-offs:
 * - No TS module resolution — import source string used as-is.
 * - No Beaver prescan — `beaverPackages` comes from global config.
 * - `local` components classified as shadow/possible iff name matches the
 *   primitive whitelist (stand-in for Stage 6 Этап B).
 * - Routes are filled as `{ kind: 'unsupported' }` (Stage 7 not implemented).
 */
export function categorizeFile(
  parsed: ParsedFile,
  global: GlobalConfig,
  perRepo: PerRepoConfig,
): CategorizeOutput {
  const imports = collectImports(parsed.ast);
  const primitiveNames = new Set<string>(
    perRepo.primitiveNamesOverride ??
      global.primitiveNames ??
      [...DEFAULT_PRIMITIVE_NAMES],
  );
  const beaverPackages = new Set(global.beaverPackages);
  const localLibs = buildLocalLibResolvers(perRepo);

  const usages: UsageRecord[] = [];
  const unresolved: UnresolvedRecord[] = [];
  const warnings: Warning[] = [];

  walkJsx(parsed.ast, (element) => {
    const tag = element.name;
    const componentName = readJsxTagName(tag);
    if (componentName === null) {
      unresolved.push({
        schemaVersion: SCHEMA_VERSION,
        kind: 'unresolved-dynamic',
        repoId: parsed.file.repoId,
        filePath: parsed.file.relPath,
        line: element.loc.start.line,
        reason: 'member-expression-not-supported',
        context: parsed.source
          .slice(element.range[0], element.range[1])
          .slice(0, 80),
      });
      return;
    }

    if (isLowercaseTag(componentName)) {
      usages.push(
        buildUsage({
          parsed,
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
    const {
      category,
      bucket,
      classificationSource,
      shadowLevel,
      beaverPackage,
      localLibId,
      beaverBackedByLib,
    } = classifyImport({
      componentName,
      binding,
      beaverPackages,
      localLibs,
      primitiveNames,
    });

    usages.push(
      buildUsage({
        parsed,
        element,
        componentName,
        category,
        bucket,
        classificationSource,
        shadowLevel,
        beaverPackage,
        localLibId,
        beaverBackedByLib,
        resolution: 'static',
      }),
    );
  });

  return { usages, unresolved, warnings };
}

function buildLocalLibResolvers(perRepo: PerRepoConfig): LocalLibraryResolver[] {
  return perRepo.localLibraries.map((lib) => ({
    libId: lib.libId,
    kind: lib.kind,
    match: picomatch(lib.matchPattern),
  }));
}

function collectImports(ast: TSESTree.Program): Map<string, ImportBinding> {
  const out = new Map<string, ImportBinding>();
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const source = node.source.value;
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportDefaultSpecifier') {
        out.set(spec.local.name, { source, importedName: null, localName: spec.local.name });
      } else if (spec.type === 'ImportNamespaceSpecifier') {
        out.set(spec.local.name, { source, importedName: '*', localName: spec.local.name });
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
  // JSXMemberExpression (e.g. <Form.Item/>) — MVP: unresolved (§5.5)
  // JSXNamespacedName (e.g. <svg:path>) — treat like lowercase tag name
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
  localLibId?: string;
  beaverBackedByLib?: boolean;
}

function classifyImport(args: {
  componentName: string;
  binding: ImportBinding | null;
  beaverPackages: Set<string>;
  localLibs: LocalLibraryResolver[];
  primitiveNames: Set<string>;
}): ClassifyResult {
  const { componentName, binding, beaverPackages, localLibs, primitiveNames } = args;

  if (!binding) {
    // Capitalized JSX tag with no matching import — likely defined in-file or
    // referenced via global scope. Treat as `local` + classify below.
    return classifyLocal(componentName, primitiveNames);
  }

  const source = binding.source;

  // Priority 1: Beaver package (exact match or aggregator) — §4.4.2
  if (beaverPackages.has(source)) {
    return {
      category: 'beaver',
      bucket: 'adoption',
      classificationSource: 'direct-beaver',
      beaverPackage: source,
    };
  }

  // Priority 2: local-library (per-repo config)
  for (const lib of localLibs) {
    if (lib.match(source)) {
      if (lib.kind === 'partially-beaver-backed') {
        return {
          category: 'local-library',
          bucket: 'adoption',
          classificationSource: 'beaver-backed-wrapper',
          localLibId: lib.libId,
          beaverBackedByLib: true,
        };
      }
      return {
        category: 'local-library',
        bucket: 'shadow',
        classificationSource: 'parallel-local-ui',
        shadowLevel: 'possible',
        localLibId: lib.libId,
        beaverBackedByLib: false,
      };
    }
  }

  // Priority 3: relative → local
  if (source.startsWith('./') || source.startsWith('../') || source.startsWith('/')) {
    return classifyLocal(componentName, primitiveNames);
  }

  // Priority 4: third-party (npm package, not Beaver)
  return {
    category: 'third-party',
    bucket: 'neither',
    classificationSource: 'utility-heuristic',
  };
}

function classifyLocal(
  componentName: string,
  primitiveNames: Set<string>,
): ClassifyResult {
  // MVP stand-in for Stage 6 Этап B (§4.6): a locally-defined component with
  // a primitive-like name counts as possible shadow. Real Stage 6 will also
  // apply substantial-markup, reusable-local, and beaver-import checks.
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
  if (localLibId !== undefined) record.localLibId = localLibId;
  if (beaverBackedByLib !== undefined) record.beaverBackedByLib = beaverBackedByLib;
  return record;
}
