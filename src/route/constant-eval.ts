import { readFile } from 'node:fs/promises';
import { parse, type TSESTree } from '@typescript-eslint/typescript-estree';
import { extname } from 'node:path';
import type { ParsedFile } from '../pipeline/parse.js';
import type { TsResolver } from '../resolve/ts-resolver.js';

const PATH_CONST_DEPTH_LIMIT = 5;
const JSX_EXT = new Set(['.tsx', '.jsx']);

/**
 * Evaluate a string-typed expression statically. Returns the resolved
 * value, or null with a warning code if the expression can't be reduced.
 *
 * Supported (PRD §4.7.2 PF2.4):
 *   - `'literal'`                                 → string literal
 *   - `PATH`                                       → identifier, traced locally
 *   - `ROUTER_PATHS.root`                          → member access on local obj
 *   - `ROUTER_PATHS.nested.level.path` (≤5 hops)
 *   - `import { ROUTER_PATHS } from '@shared/c'`   → cross-file via resolver
 *
 * NOT supported (warning, fall through to dynamic-path-skipped):
 *   - template literals (`${BASE}/x`)
 *   - computed property access (`PATHS[key]`)
 *   - function calls (`getPath()`)
 *   - spread / dynamic mixtures
 */
export interface EvalResult {
  value: string | null;
  /** Subcode if value is null. e.g. `dynamic-path-template-literal`. */
  warning?: string;
}

export class ConstantEvaluator {
  /** File AST cache for cross-file lookups; keyed by normalised absPath. */
  private readonly fileCache = new Map<string, TSESTree.Program | null>();

  constructor(private readonly resolver: TsResolver) {}

  async evalStringConstant(
    expr: TSESTree.Node,
    file: ParsedFile,
  ): Promise<EvalResult> {
    return this.evalInternal(expr, file.ast, file.file.absPath, new Set(), 0);
  }

  private async evalInternal(
    expr: TSESTree.Node,
    ast: TSESTree.Program,
    fileAbsPath: string,
    visited: Set<string>,
    depth: number,
  ): Promise<EvalResult> {
    if (depth > PATH_CONST_DEPTH_LIMIT) {
      return { value: null, warning: 'dynamic-path-depth-exceeded' };
    }

    // 0. Strip transparent TS wrappers: `x as const`, `x satisfies T`,
    //    legacy `<T>x`. They don't affect the runtime value.
    const unwrapped = stripTsTypeWrappers(expr);
    if (unwrapped !== expr) {
      return this.evalInternal(unwrapped, ast, fileAbsPath, visited, depth);
    }

    // 1. Plain string literal — done.
    if (expr.type === 'Literal' && typeof expr.value === 'string') {
      return { value: expr.value };
    }

    // 2. Template literal — supported only when zero expressions
    //    (`\`/foo\`` is just a string).
    if (expr.type === 'TemplateLiteral') {
      if (expr.expressions.length === 0 && expr.quasis.length === 1) {
        const first = expr.quasis[0];
        if (first) return { value: first.value.cooked ?? first.value.raw };
      }
      return { value: null, warning: 'dynamic-path-template-literal' };
    }

    // 3. Identifier — look up the binding, then recurse on its value.
    if (expr.type === 'Identifier') {
      return this.resolveBinding(expr.name, [], ast, fileAbsPath, visited, depth);
    }

    // 4. Member expression — split into base + path[].
    if (expr.type === 'MemberExpression') {
      const flat = flattenMemberExpression(expr);
      if (!flat) {
        return { value: null, warning: 'dynamic-path-non-static-member' };
      }
      return this.resolveBinding(
        flat.base,
        flat.path,
        ast,
        fileAbsPath,
        visited,
        depth,
      );
    }

    return { value: null, warning: `dynamic-path-unsupported:${expr.type}` };
  }

  private async resolveBinding(
    base: string,
    path: string[],
    ast: TSESTree.Program,
    fileAbsPath: string,
    visited: Set<string>,
    depth: number,
  ): Promise<EvalResult> {
    const visitedKey = `${fileAbsPath}::${base}::${path.join('.')}`;
    if (visited.has(visitedKey)) {
      return { value: null, warning: 'dynamic-path-cycle' };
    }
    const nextVisited = new Set(visited).add(visitedKey);

    // (a) Local const? `const PATH = '...'` or `const PATHS = { ... }`.
    for (const node of ast.body) {
      // `const X = ...`
      if (node.type === 'VariableDeclaration') {
        for (const d of node.declarations) {
          if (d.id.type !== 'Identifier' || d.id.name !== base || !d.init) continue;
          return this.descendInto(
            d.init,
            path,
            ast,
            fileAbsPath,
            nextVisited,
            depth,
          );
        }
      }
      // `export const X = ...`
      if (
        node.type === 'ExportNamedDeclaration' &&
        node.declaration?.type === 'VariableDeclaration'
      ) {
        for (const d of node.declaration.declarations) {
          if (d.id.type !== 'Identifier' || d.id.name !== base || !d.init) continue;
          return this.descendInto(
            d.init,
            path,
            ast,
            fileAbsPath,
            nextVisited,
            depth,
          );
        }
      }
    }

    // (b) Imported binding? Follow to the source file.
    const binding = findImportBindingByLocal(ast, base);
    if (!binding) {
      return { value: null, warning: `dynamic-path-binding-not-found:${base}` };
    }
    const resolved = this.resolver.resolve(binding.source, fileAbsPath);
    if (resolved.kind !== 'in-repo') {
      return {
        value: null,
        warning: `dynamic-path-import-not-in-repo:${base} from ${binding.source}`,
      };
    }
    const sourceAst = await this.loadAst(resolved.absPath);
    if (!sourceAst) {
      return {
        value: null,
        warning: `dynamic-path-source-unparseable:${resolved.absPath}`,
      };
    }
    // The export symbol may differ from the local binding (e.g. `export { foo
    // as bar }` then `import { bar } from`); look it up by `imported` name.
    const remoteName =
      binding.imported && binding.imported !== '*' ? binding.imported : base;
    // Find `export const <remoteName>` (named or default) in sourceAst.
    return this.findExportedConstAndDescend(
      sourceAst,
      resolved.absPath,
      remoteName,
      path,
      nextVisited,
      depth + 1,
    );
  }

  private async descendInto(
    init: TSESTree.Node,
    path: string[],
    ast: TSESTree.Program,
    fileAbsPath: string,
    visited: Set<string>,
    depth: number,
  ): Promise<EvalResult> {
    // Same TS-wrapper unwrap as in evalInternal (handles `{...} as const`,
    // `{...} satisfies T`).
    init = stripTsTypeWrappers(init);
    if (path.length === 0) {
      // No further path segments — `init` itself should be a string-typed value.
      return this.evalInternal(init, ast, fileAbsPath, visited, depth + 1);
    }
    if (init.type !== 'ObjectExpression') {
      // Path segments remain but `init` is not an object — could be an
      // identifier alias (chase it), else dead end.
      if (init.type === 'Identifier') {
        return this.resolveBinding(
          init.name,
          path,
          ast,
          fileAbsPath,
          visited,
          depth + 1,
        );
      }
      return {
        value: null,
        warning: `dynamic-path-non-object-segment:${init.type}`,
      };
    }
    const [head, ...rest] = path;
    if (head === undefined) {
      return {
        value: null,
        warning: 'dynamic-path-empty-segment',
      };
    }
    for (const prop of init.properties) {
      if (prop.type !== 'Property') continue;
      const key =
        prop.key.type === 'Identifier'
          ? prop.key.name
          : prop.key.type === 'Literal' && typeof prop.key.value === 'string'
            ? prop.key.value
            : null;
      if (key !== head) continue;
      return this.descendInto(prop.value, rest, ast, fileAbsPath, visited, depth + 1);
    }
    return {
      value: null,
      warning: `dynamic-path-missing-property:${head}`,
    };
  }

  private async findExportedConstAndDescend(
    sourceAst: TSESTree.Program,
    sourceAbsPath: string,
    name: string,
    path: string[],
    visited: Set<string>,
    depth: number,
  ): Promise<EvalResult> {
    for (const node of sourceAst.body) {
      // `export const X = ...`
      if (
        node.type === 'ExportNamedDeclaration' &&
        node.declaration?.type === 'VariableDeclaration'
      ) {
        for (const d of node.declaration.declarations) {
          if (d.id.type !== 'Identifier' || d.id.name !== name || !d.init) continue;
          return this.descendInto(
            d.init,
            path,
            sourceAst,
            sourceAbsPath,
            visited,
            depth,
          );
        }
      }
      // `const X = ...; export { X };`
      if (node.type === 'ExportNamedDeclaration' && !node.declaration) {
        for (const spec of node.specifiers) {
          if (spec.type !== 'ExportSpecifier') continue;
          const exported =
            spec.exported.type === 'Identifier' ? spec.exported.name : null;
          if (exported !== name) continue;
          const local =
            spec.local.type === 'Identifier' ? spec.local.name : null;
          if (!local) continue;
          // Trace the local binding in the source file.
          return this.resolveBinding(local, path, sourceAst, sourceAbsPath, visited, depth);
        }
      }
      // `export * from './other'` — follow through to the other file.
      if (
        node.type === 'ExportAllDeclaration' &&
        typeof node.source.value === 'string'
      ) {
        const next = this.resolver.resolve(node.source.value, sourceAbsPath);
        if (next.kind === 'in-repo') {
          const ast = await this.loadAst(next.absPath);
          if (ast) {
            const result = await this.findExportedConstAndDescend(
              ast,
              next.absPath,
              name,
              path,
              visited,
              depth + 1,
            );
            if (result.value !== null) return result;
          }
        }
      }
    }
    return {
      value: null,
      warning: `dynamic-path-export-not-found:${name} in ${sourceAbsPath}`,
    };
  }

  private async loadAst(absPath: string): Promise<TSESTree.Program | null> {
    const key = absPath.replace(/\\/g, '/').toLowerCase();
    const cached = this.fileCache.get(key);
    if (cached !== undefined) return cached;
    try {
      const text = await readFile(absPath, 'utf-8');
      const ext = extname(absPath).toLowerCase();
      const ast = parse(text, {
        loc: true,
        range: true,
        jsx: JSX_EXT.has(ext),
      });
      this.fileCache.set(key, ast);
      return ast;
    } catch {
      this.fileCache.set(key, null);
      return null;
    }
  }
}

/**
 * `expr as Foo`, `expr satisfies Foo`, `<Foo>expr` — all wrap a value without
 * changing it at runtime. Strip them so downstream eval sees the actual
 * payload (e.g. `{ ... } as const` → `{ ... }`).
 */
function stripTsTypeWrappers(node: TSESTree.Node): TSESTree.Node {
  let cur: TSESTree.Node = node;
  while (
    cur.type === 'TSAsExpression' ||
    cur.type === 'TSSatisfiesExpression' ||
    cur.type === 'TSTypeAssertion' ||
    cur.type === 'TSNonNullExpression'
  ) {
    cur = cur.expression;
  }
  return cur;
}

function flattenMemberExpression(
  expr: TSESTree.MemberExpression,
): { base: string; path: string[] } | null {
  const path: string[] = [];
  let cur: TSESTree.Node = expr;
  while (cur.type === 'MemberExpression') {
    if (cur.computed) return null; // PATHS[key] — out of scope
    if (cur.property.type !== 'Identifier') return null;
    path.unshift(cur.property.name);
    cur = cur.object;
  }
  if (cur.type !== 'Identifier') return null;
  return { base: cur.name, path };
}

function findImportBindingByLocal(
  ast: TSESTree.Program,
  localName: string,
): { source: string; imported: string | null } | null {
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue;
    for (const spec of node.specifiers) {
      if (spec.local.name !== localName) continue;
      if (spec.type === 'ImportDefaultSpecifier') {
        return { source: node.source.value, imported: 'default' };
      }
      if (spec.type === 'ImportNamespaceSpecifier') {
        return { source: node.source.value, imported: '*' };
      }
      if (spec.type === 'ImportSpecifier') {
        const imported =
          spec.imported.type === 'Identifier'
            ? spec.imported.name
            : String(spec.imported.value);
        return { source: node.source.value, imported };
      }
    }
  }
  return null;
}
