import type { TSESTree } from '@typescript-eslint/typescript-estree';
import type { TsResolver } from '../resolve/ts-resolver.js';
import type { ParsedFile } from '../pipeline/parse.js';
import type { DiscoveredConfigSite } from './discovery.js';
import type { RouteEntry } from './types.js';

/**
 * Stage 7.2 (§4.7.2) — for every discovered route-array, extract
 * (path, pageComponentFile) per entry, recursing through `children` and
 * concatenating paths.
 *
 * Supported forms in this MVP pass:
 *   - `{ path, element: <Foo/> }`
 *   - `{ path, Component: Foo }`
 *   - `{ path, lazy: () => import('./path') }` (default export of target)
 *   - `{ path, children: [...] }` (recursive; path concat; layout routes)
 *
 * Deferred (warning on sight, route still registered with pageComponentFile=null):
 *   - conditional `element: flag ? <A/> : <B/>` — lands with full
 *     M4 branch enumeration.
 *   - spread children `[...base, ...feature]` — variable following deferred.
 *   - dynamic path `path: getPath(...)` — skipped with warning per §4.7.2.
 */
export function extractRoutes(
  sites: DiscoveredConfigSite[],
  resolver: TsResolver,
): RouteEntry[] {
  const out: RouteEntry[] = [];
  for (const site of sites) {
    for (const element of site.routesArray.elements) {
      if (!element || element.type !== 'ObjectExpression') continue;
      walk(element, '', site.file, resolver, out);
    }
  }
  return out;
}

function walk(
  routeObject: TSESTree.ObjectExpression,
  parentPath: string,
  file: ParsedFile,
  resolver: TsResolver,
  out: RouteEntry[],
): void {
  let pathSegment: string | null = null;
  let pathIsDynamic = false;
  let pageSpec: PageSpec = { kind: 'none' };
  let childrenArray: TSESTree.ArrayExpression | null = null;

  for (const prop of routeObject.properties) {
    if (prop.type !== 'Property' || prop.key.type !== 'Identifier') continue;
    const name = prop.key.name;

    if (name === 'path') {
      if (prop.value.type === 'Literal' && typeof prop.value.value === 'string') {
        pathSegment = prop.value.value;
      } else {
        pathIsDynamic = true;
      }
    } else if (name === 'element') {
      pageSpec = readElement(prop.value);
    } else if (name === 'Component') {
      if (prop.value.type === 'Identifier') {
        pageSpec = { kind: 'identifier', name: prop.value.name };
      } else {
        pageSpec = { kind: 'dynamic', reason: 'non-identifier-component' };
      }
    } else if (name === 'lazy') {
      pageSpec = readLazy(prop.value);
    } else if (name === 'children' && prop.value.type === 'ArrayExpression') {
      childrenArray = prop.value;
    }
  }

  const joinedPath = joinPath(parentPath, pathSegment);
  const warnings: string[] = [];
  if (pathIsDynamic) {
    warnings.push('dynamic-path-skipped');
  }

  let pageComponentFile: string | null = null;
  let pageComponentSymbol: string | null = null;
  if (!pathIsDynamic) {
    const resolved = resolvePage(pageSpec, file, resolver);
    pageComponentFile = resolved.file;
    pageComponentSymbol = resolved.symbol;
    if (resolved.warning) warnings.push(resolved.warning);
  }

  if (!pathIsDynamic) {
    out.push({
      path: joinedPath,
      configFilePath: file.file.relPath,
      configAbsPath: file.file.absPath,
      pageComponentFile,
      pageComponentSymbol,
      warnings,
    });
  }

  if (childrenArray) {
    for (const child of childrenArray.elements) {
      if (!child || child.type !== 'ObjectExpression') continue;
      walk(child, joinedPath, file, resolver, out);
    }
  }
}

type PageSpec =
  /**
   * Candidates ordered by preference. We try them in sequence and pick the
   * first that resolves in-repo — this is how we "unwrap" external guards
   * around a local page (`<AbilityGuard><CreateProject/></AbilityGuard>`):
   * the JSX walker collects identifiers from the wrapper down to its
   * children, and resolvePage picks the first one that lives in the repo.
   */
  | { kind: 'none' }
  | { kind: 'jsx-candidates'; names: string[] }
  | { kind: 'identifier'; name: string }
  | { kind: 'lazy-import'; importSource: string }
  | { kind: 'dynamic'; reason: string };

function readElement(value: TSESTree.Node): PageSpec {
  if (value.type === 'JSXElement') {
    const candidates = collectJsxCandidates(value);
    if (candidates.length === 0) {
      return { kind: 'dynamic', reason: 'jsx-member-or-namespace' };
    }
    return { kind: 'jsx-candidates', names: candidates };
  }
  if (value.type === 'Identifier') {
    return { kind: 'identifier', name: value.name };
  }
  if (value.type === 'ConditionalExpression') {
    return { kind: 'dynamic', reason: 'conditional-element' };
  }
  if (value.type === 'CallExpression') {
    return { kind: 'dynamic', reason: 'hoc-wrapped-element' };
  }
  return { kind: 'dynamic', reason: 'unknown-element-form' };
}

const JSX_TREE_DEPTH_LIMIT = 5;

/**
 * Walk a JSXElement tree top-down, collecting tags.
 * Order: parent first, then children left-to-right (BFS).
 *   `<AbilityGuard><CreateProject/></AbilityGuard>` →
 *   ['AbilityGuard', 'CreateProject'].
 *   `<AbilityGuard><Pages.BuildInfra/></AbilityGuard>` →
 *   ['AbilityGuard', 'Pages.BuildInfra'].
 * `resolvePage` prefers the first one that resolves in-repo, so a local
 * `CreateProject` / member-expr child correctly wins over an external
 * `AbilityGuard` wrapper.
 *
 * Member-expression tags (`Pages.Sub.Comp`) are emitted as a dotted
 * string — `resolvePageCandidate` splits on `.` to look up the base
 * binding and then descends. Tree depth capped at 5 (§4.7.3 / PF2.5).
 */
function collectJsxCandidates(root: TSESTree.JSXElement): string[] {
  const out: string[] = [];
  const stack: Array<{ node: TSESTree.JSXElement; depth: number }> = [
    { node: root, depth: 0 },
  ];
  while (stack.length > 0) {
    const { node, depth } = stack.shift()!;
    if (depth > JSX_TREE_DEPTH_LIMIT) continue;
    const tag = node.openingElement.name;
    const dotted = readJsxTagDotted(tag);
    if (dotted && /^[A-Z]/.test(dotted)) {
      out.push(dotted);
    }
    for (const child of node.children) {
      if (child.type === 'JSXElement') {
        stack.push({ node: child, depth: depth + 1 });
      } else if (child.type === 'JSXExpressionContainer') {
        // `{condition && <Page/>}` and similar — recurse.
        const expr = child.expression;
        if (expr.type === 'JSXElement') {
          stack.push({ node: expr, depth: depth + 1 });
        } else if (
          expr.type === 'LogicalExpression' &&
          expr.right.type === 'JSXElement'
        ) {
          stack.push({ node: expr.right, depth: depth + 1 });
        }
      }
    }
  }
  return out;
}

/**
 * Render a JSX tag as a dotted identifier name. Returns null for tags we
 * can't statically name (computed attributes, namespaced HTML-like tags).
 */
function readJsxTagDotted(name: TSESTree.JSXTagNameExpression): string | null {
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXMemberExpression') {
    const left = readJsxTagDotted(name.object);
    if (!left) return null;
    return `${left}.${name.property.name}`;
  }
  return null;
}

function readLazy(value: TSESTree.Node): PageSpec {
  // Expected: () => import('./foo')  OR  async () => await import('./foo')
  if (
    value.type !== 'ArrowFunctionExpression' &&
    value.type !== 'FunctionExpression'
  ) {
    return { kind: 'dynamic', reason: 'non-function-lazy' };
  }
  const body = value.body;
  const expr = extractImportCall(body);
  if (!expr) return { kind: 'dynamic', reason: 'no-import-in-lazy' };
  if (expr.source.type !== 'Literal' || typeof expr.source.value !== 'string') {
    return { kind: 'dynamic', reason: 'dynamic-import-source' };
  }
  return { kind: 'lazy-import', importSource: expr.source.value };
}

function extractImportCall(
  body: TSESTree.Node,
): TSESTree.ImportExpression | null {
  if (body.type === 'ImportExpression') return body;
  if (body.type === 'AwaitExpression' && body.argument.type === 'ImportExpression') {
    return body.argument;
  }
  if (body.type === 'BlockStatement') {
    for (const stmt of body.body) {
      if (stmt.type === 'ReturnStatement' && stmt.argument) {
        if (stmt.argument.type === 'ImportExpression') return stmt.argument;
        if (
          stmt.argument.type === 'AwaitExpression' &&
          stmt.argument.argument.type === 'ImportExpression'
        ) {
          return stmt.argument.argument;
        }
      }
    }
  }
  return null;
}

function resolvePage(
  spec: PageSpec,
  file: ParsedFile,
  resolver: TsResolver,
): { file: string | null; symbol: string | null; warning?: string } {
  if (spec.kind === 'none') {
    return { file: null, symbol: null };
  }
  if (spec.kind === 'dynamic') {
    return { file: null, symbol: null, warning: `page-unresolved:${spec.reason}` };
  }
  if (spec.kind === 'lazy-import') {
    const resolved = resolver.resolve(spec.importSource, file.file.absPath);
    if (resolved.kind === 'in-repo') {
      return { file: resolved.absPath, symbol: 'default' };
    }
    return { file: null, symbol: null, warning: 'lazy-import-not-in-repo' };
  }
  if (spec.kind === 'identifier') {
    return resolveIdentifierCandidate(spec.name, file, resolver);
  }
  // jsx-candidates: try each in order, preferring in-repo resolutions over
  // external ones. This is what unwraps `<Guard><Page/></Guard>` correctly.
  let firstWarning: string | undefined;
  for (const name of spec.names) {
    const r = resolveIdentifierCandidate(name, file, resolver);
    if (r.file !== null) return r;
    if (firstWarning === undefined && r.warning) {
      firstWarning = r.warning;
    }
  }
  return {
    file: null,
    symbol: null,
    warning: firstWarning ?? 'no-jsx-candidate-resolved',
  };
}

function resolveIdentifierCandidate(
  dotted: string,
  file: ParsedFile,
  resolver: TsResolver,
): { file: string | null; symbol: string | null; warning?: string } {
  // For member expressions (`Pages.MobileBuilds`), the import-binding lookup
  // uses the base identifier; the rest of the dotted chain is positional info
  // for diagnostics. The reachable set from the resolved file already includes
  // its re-exports, so binding to that file is sufficient — finer-grained
  // member resolution (cross-file chains) is a v2 refinement.
  const dotIdx = dotted.indexOf('.');
  const base = dotIdx === -1 ? dotted : dotted.slice(0, dotIdx);
  const isMember = dotIdx !== -1;

  const binding = findImportBinding(file, base);
  if (!binding) {
    return {
      file: null,
      symbol: dotted,
      warning: isMember
        ? `jsx-member-base-not-imported:${base} (in tag <${dotted}/>)`
        : `page-not-imported:${dotted}`,
    };
  }
  const resolved = resolver.resolve(binding.source, file.file.absPath);
  if (resolved.kind === 'in-repo') {
    return {
      file: resolved.absPath,
      symbol: isMember ? dotted : binding.imported ?? dotted,
    };
  }
  return {
    file: null,
    symbol: dotted,
    warning: isMember
      ? `jsx-member-unresolved:${dotted} (base ${base} from ${binding.source})`
      : `page-import-not-in-repo:${dotted} from ${binding.source}`,
  };
}

function findImportBinding(
  file: ParsedFile,
  localName: string,
): { source: string; imported: string | null } | null {
  for (const node of file.ast.body) {
    if (node.type !== 'ImportDeclaration') continue;
    for (const spec of node.specifiers) {
      if (spec.local.name !== localName) continue;
      if (spec.type === 'ImportDefaultSpecifier') {
        return { source: node.source.value, imported: null };
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

function joinPath(parent: string, segment: string | null): string {
  if (segment === null) return parent;
  if (segment === '') return parent || '/';
  if (segment.startsWith('/')) return segment;
  if (parent === '' || parent === '/') return '/' + segment.replace(/^\//, '');
  return parent.replace(/\/$/, '') + '/' + segment.replace(/^\//, '');
}
