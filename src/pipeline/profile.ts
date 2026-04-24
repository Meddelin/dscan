import { readFile } from 'node:fs/promises';
import type { TSESTree } from '@typescript-eslint/typescript-estree';
import type { ParsedFile } from './parse.js';
import type { TsResolver } from '../resolve/ts-resolver.js';
import type { BeaverRegistry } from '../types/prescan.js';

/**
 * Structural information extracted from a local component's source code.
 * Feeds every Stage-6 Этап B signal (§5.1), Adoption-wrapper rules (§3.6),
 * neither-heuristics (§5.3), and the ShadowComponentRecord schema (§6.1).
 *
 * One profile = one exported component symbol in one file. A file with
 * multiple exported components yields multiple profiles.
 */
export interface ComponentProfile {
  repoId: string;
  filePath: string;           // repo-relative, forward-slash normalised
  absPath: string;
  componentName: string;

  // From the component's own body
  jsxElementCount: number;
  htmlTags: string[];         // sorted, deduped
  propNames: string[];        // sorted
  usesStyled: boolean;

  // Imports referenced from within the component body
  beaverImports: string[];    // Beaver symbols actually used inside the body
  localImports: string[];     // local component names referenced (capitalised)

  // Signal flags derived during profiling
  passesClassNameToBeaver: boolean; // any Beaver-imported JSX had className/style/css prop
  wrapsBeaverWithStyled: boolean;   // styled(BeaverImport) or styled(Beaver.Comp)
  hasBeaverImport: boolean;         // module imports anything from Beaver

  // Cross-file aggregation (filled in after all profiles built)
  filesUsedIn: number;
  usageCount: number;

  // Source code snippet (truncated per config), for AI layer
  codeSnippet: string;
  codeSnippetTruncated: boolean;
}

export interface ProfileInput {
  parsed: ParsedFile;
  resolver: TsResolver;
  beaverRegistry: BeaverRegistry;
  codeSnippetMaxLines: number;
}

/**
 * Extract one profile per exported capitalised identifier that looks like a
 * React component (function, arrow function, or class).
 */
export async function buildProfilesForFile(
  input: ProfileInput,
): Promise<ComponentProfile[]> {
  const { parsed, resolver, beaverRegistry } = input;
  const imports = collectImportMeta(parsed.ast);
  const beaverNameBindings = classifyBeaverBindings(imports, resolver, parsed.file.absPath, beaverRegistry);

  const profiles: ComponentProfile[] = [];
  const exported = findExportedComponents(parsed.ast);

  const hasBeaverImport = [...beaverNameBindings.values()].some(
    (b) => b.kind === 'beaver',
  );

  for (const comp of exported) {
    const bodyStats = collectBodyStats(comp.body, beaverNameBindings);
    const propNames = extractPropNames(comp.signature);

    const snippet = extractSnippet(
      parsed.source,
      comp.range,
      input.codeSnippetMaxLines,
    );

    profiles.push({
      repoId: parsed.file.repoId,
      filePath: parsed.file.relPath,
      absPath: parsed.file.absPath,
      componentName: comp.name,
      jsxElementCount: bodyStats.jsxElementCount,
      htmlTags: [...bodyStats.htmlTags].sort(),
      propNames,
      usesStyled: bodyStats.usesStyled,
      beaverImports: [...bodyStats.beaverImportsUsed].sort(),
      localImports: [...bodyStats.localImportsUsed].sort(),
      passesClassNameToBeaver: bodyStats.passesClassNameToBeaver,
      wrapsBeaverWithStyled: bodyStats.wrapsBeaverWithStyled,
      hasBeaverImport,
      filesUsedIn: 0,
      usageCount: 0,
      codeSnippet: snippet.text,
      codeSnippetTruncated: snippet.truncated,
    });
  }

  return profiles;
}

/**
 * Thin wrapper kept for symmetry with test helpers that want to pre-load the
 * file content explicitly (parseFiles already reads it, so we use what's
 * attached to ParsedFile.source).
 */
export function _readFile(abs: string): Promise<string> {
  return readFile(abs, 'utf-8');
}

interface ImportMeta {
  source: string;
  importedName: string | null; // null for default
  isNamespace: boolean;
}

function collectImportMeta(
  ast: TSESTree.Program,
): Map<string, ImportMeta> {
  const map = new Map<string, ImportMeta>();
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue;
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportDefaultSpecifier') {
        map.set(spec.local.name, {
          source: node.source.value,
          importedName: null,
          isNamespace: false,
        });
      } else if (spec.type === 'ImportNamespaceSpecifier') {
        map.set(spec.local.name, {
          source: node.source.value,
          importedName: null,
          isNamespace: true,
        });
      } else if (spec.type === 'ImportSpecifier') {
        const imported =
          spec.imported.type === 'Identifier'
            ? spec.imported.name
            : String(spec.imported.value);
        map.set(spec.local.name, {
          source: node.source.value,
          importedName: imported,
          isNamespace: false,
        });
      }
    }
  }
  return map;
}

interface BeaverBindingInfo {
  kind: 'beaver' | 'other';
  /** Leaf Beaver package, post-canonicalisation. Undefined when kind !== 'beaver'. */
  beaverPackage?: string;
  importedSymbol: string;
}

function classifyBeaverBindings(
  imports: Map<string, ImportMeta>,
  resolver: TsResolver,
  importerFile: string,
  beaverRegistry: BeaverRegistry,
): Map<string, BeaverBindingInfo> {
  const out = new Map<string, BeaverBindingInfo>();
  for (const [localName, meta] of imports) {
    const resolved = resolver.resolve(meta.source, importerFile);
    const sym = meta.importedName ?? 'default';
    if (resolved.kind === 'external' && beaverRegistry.packages.has(resolved.packageName)) {
      const canonical = beaverRegistry.reExports
        .get(resolved.packageName)
        ?.get(sym);
      out.set(localName, {
        kind: 'beaver',
        beaverPackage: canonical?.sourcePackage ?? resolved.packageName,
        importedSymbol: sym,
      });
    } else {
      out.set(localName, { kind: 'other', importedSymbol: sym });
    }
  }
  return out;
}

interface BodyStats {
  jsxElementCount: number;
  htmlTags: Set<string>;
  beaverImportsUsed: Set<string>;
  localImportsUsed: Set<string>;
  usesStyled: boolean;
  passesClassNameToBeaver: boolean;
  wrapsBeaverWithStyled: boolean;
}

const CUSTOMIZATION_PROPS = new Set(['className', 'style', 'css']);

function collectBodyStats(
  body: TSESTree.Node,
  bindings: Map<string, BeaverBindingInfo>,
): BodyStats {
  const stats: BodyStats = {
    jsxElementCount: 0,
    htmlTags: new Set(),
    beaverImportsUsed: new Set(),
    localImportsUsed: new Set(),
    usesStyled: false,
    passesClassNameToBeaver: false,
    wrapsBeaverWithStyled: false,
  };

  const stack: TSESTree.Node[] = [body];
  while (stack.length > 0) {
    const node = stack.pop()!;

    if (node.type === 'JSXElement') {
      stats.jsxElementCount++;
      const tagName = readJsxTagName(node.openingElement.name);
      if (tagName) {
        if (isLowercaseTag(tagName)) {
          stats.htmlTags.add(tagName);
        } else {
          const base = tagName.split('.')[0] ?? tagName;
          const binding = bindings.get(base);
          if (binding?.kind === 'beaver') {
            stats.beaverImportsUsed.add(binding.importedSymbol);
            if (hasCustomizationProp(node.openingElement)) {
              stats.passesClassNameToBeaver = true;
            }
          } else {
            stats.localImportsUsed.add(base);
          }
        }
      }
    } else if (node.type === 'CallExpression') {
      const calleeName = readCalleeIdentifier(node.callee);
      if (calleeName === 'styled' || calleeName?.endsWith('.styled')) {
        stats.usesStyled = true;
        const firstArg = node.arguments[0];
        if (firstArg) {
          const argName = readCalleeIdentifier(firstArg);
          if (argName) {
            const base = argName.split('.')[0] ?? argName;
            const binding = bindings.get(base);
            if (binding?.kind === 'beaver') {
              stats.wrapsBeaverWithStyled = true;
              stats.beaverImportsUsed.add(binding.importedSymbol);
            }
          }
        }
      }
    } else if (node.type === 'MemberExpression') {
      // styled.button`...`  → styled identifier with .button property.
      if (
        node.object.type === 'Identifier' &&
        node.object.name === 'styled'
      ) {
        stats.usesStyled = true;
      }
    } else if (node.type === 'TaggedTemplateExpression') {
      const tagName = readCalleeIdentifier(node.tag);
      if (tagName === 'styled' || tagName?.startsWith('styled.')) {
        stats.usesStyled = true;
      }
    }

    pushChildren(node, stack);
  }

  return stats;
}

function hasCustomizationProp(opening: TSESTree.JSXOpeningElement): boolean {
  for (const attr of opening.attributes) {
    if (attr.type !== 'JSXAttribute') continue;
    if (attr.name.type !== 'JSXIdentifier') continue;
    if (CUSTOMIZATION_PROPS.has(attr.name.name)) return true;
  }
  return false;
}

function readCalleeIdentifier(node: TSESTree.Node): string | null {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed) {
    const left = readCalleeIdentifier(node.object);
    const right =
      node.property.type === 'Identifier' ? node.property.name : null;
    if (left && right) return `${left}.${right}`;
  }
  return null;
}

function readJsxTagName(name: TSESTree.JSXTagNameExpression): string | null {
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXMemberExpression') {
    const left = readJsxTagName(name.object);
    const right = name.property.name;
    if (left) return `${left}.${right}`;
  }
  if (name.type === 'JSXNamespacedName') {
    return `${name.namespace.name}:${name.name.name}`;
  }
  return null;
}

function isLowercaseTag(name: string): boolean {
  const first = name.charAt(0);
  return first === first.toLowerCase() && first !== first.toUpperCase();
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

interface ExportedComponent {
  name: string;
  signature: TSESTree.Node; // function params or arrow params
  body: TSESTree.Node;
  range: [number, number];
}

function findExportedComponents(ast: TSESTree.Program): ExportedComponent[] {
  const out: ExportedComponent[] = [];

  for (const node of ast.body) {
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      pushComponents(node.declaration, out);
    } else if (node.type === 'ExportDefaultDeclaration') {
      pushComponents(node.declaration, out, 'default');
    }
  }

  return out;
}

function pushComponents(
  decl: TSESTree.Node,
  out: ExportedComponent[],
  forcedName: string | null = null,
): void {
  if (decl.type === 'FunctionDeclaration') {
    const name = forcedName ?? decl.id?.name ?? null;
    if (name && (forcedName === 'default' || isComponentName(name))) {
      out.push({
        name,
        signature: decl.params[0] ?? decl,
        body: decl.body,
        range: decl.range,
      });
    }
  } else if (decl.type === 'VariableDeclaration') {
    for (const v of decl.declarations) {
      if (v.id.type !== 'Identifier') continue;
      const name = v.id.name;
      if (!isComponentName(name)) continue;
      const init = v.init;
      if (!init) continue;
      if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
        out.push({
          name,
          signature: init.params[0] ?? init,
          body: init.body,
          range: v.range,
        });
      } else if (
        init.type === 'CallExpression' ||
        init.type === 'TaggedTemplateExpression'
      ) {
        // `const Foo = styled(Bar)\`...\`` / `const Foo = styled(Bar)` — the
        // expression itself is the "body" we need to profile for
        // wraps-with-customization / uses-styled signals (§5.1).
        out.push({
          name,
          signature: init,
          body: init,
          range: v.range,
        });
      }
    }
  } else if (decl.type === 'ClassDeclaration') {
    const name = forcedName ?? decl.id?.name ?? null;
    if (name && isComponentName(name)) {
      out.push({
        name,
        signature: decl,
        body: decl.body,
        range: decl.range,
      });
    }
  }
}

function isComponentName(name: string): boolean {
  if (name === 'default') return true;
  const first = name.charAt(0);
  return first === first.toUpperCase() && first !== first.toLowerCase();
}

function extractPropNames(signature: TSESTree.Node): string[] {
  const names = new Set<string>();
  const param = signature;

  // Look at TS type annotations: `({ foo, bar }: Props)` or `(props: Props)`.
  // We extract from the object pattern destructuring OR from a TSTypeReference.
  // For MVP we only grab destructured names — type-reference inspection requires
  // cross-file type resolution (v2 via props registry).
  if (param.type === 'ObjectPattern') {
    for (const prop of param.properties) {
      if (prop.type === 'Property' && prop.key.type === 'Identifier') {
        names.add(prop.key.name);
      }
    }
  } else if (param.type === 'Identifier' && param.typeAnnotation) {
    const ann = param.typeAnnotation.typeAnnotation;
    if (ann.type === 'TSTypeLiteral') {
      for (const member of ann.members) {
        if (member.type === 'TSPropertySignature' && member.key.type === 'Identifier') {
          names.add(member.key.name);
        }
      }
    }
  }
  return [...names].sort();
}

interface SnippetResult {
  text: string;
  truncated: boolean;
}

function extractSnippet(
  source: string,
  range: [number, number],
  maxLines: number,
): SnippetResult {
  const raw = source.slice(range[0], range[1]);
  const lines = raw.split('\n');
  if (lines.length <= maxLines) {
    return { text: raw, truncated: false };
  }
  return { text: lines.slice(0, maxLines).join('\n'), truncated: true };
}

/**
 * After all per-file profiles exist, compute cross-file aggregation:
 * for every Usage whose import resolves to a profile's file + symbol,
 * bump usageCount and track distinct files.
 */
export function annotateCrossFileUsage(
  profiles: ComponentProfile[],
  resolveUsage: (profileKey: string) => { files: Set<string>; count: number } | null,
): void {
  for (const p of profiles) {
    const key = profileKey(p);
    const stats = resolveUsage(key);
    if (stats) {
      p.filesUsedIn = stats.files.size;
      p.usageCount = stats.count;
    }
  }
}

export function profileKey(p: { absPath: string; componentName: string }): string {
  return `${p.absPath.replace(/\\/g, '/').toLowerCase()}::${p.componentName}`;
}
