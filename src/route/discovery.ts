import type { TSESTree } from '@typescript-eslint/typescript-estree';
import type { ParsedFile } from '../pipeline/parse.js';

const ROUTER_FACTORY_NAMES = new Set([
  'createBrowserRouter',
  'createHashRouter',
  'createMemoryRouter',
]);

export interface DiscoveredConfigSite {
  file: ParsedFile;
  /** The ArrayExpression node containing the route list. */
  routesArray: TSESTree.ArrayExpression;
}

/**
 * Stage 7.1 (§4.7.1) — find files that host a router config.
 *
 * MVP heuristics (covering the React Router v6 data-router surface):
 *   1. `createBrowserRouter([...])` / `createHashRouter([...])` /
 *      `createMemoryRouter([...])` — first argument is the ArrayExpression.
 *   2. Named export of an array literal whose elements look like RouteObjects
 *      (`{ path: ..., element|lazy|children|Component: ... }`).
 *
 * Opt-out via config.routeResolution.entryPoints is honoured upstream; this
 * discovery layer itself is purely structural.
 */
export function discoverRouteConfigs(parsed: ParsedFile[]): DiscoveredConfigSite[] {
  const sites: DiscoveredConfigSite[] = [];
  for (const file of parsed) {
    collectFromProgram(file, sites);
  }
  return sites;
}

function collectFromProgram(
  file: ParsedFile,
  sites: DiscoveredConfigSite[],
): void {
  const stack: TSESTree.Node[] = [file.ast];
  while (stack.length > 0) {
    const node = stack.pop()!;

    if (node.type === 'CallExpression' && isRouterFactoryCall(node.callee)) {
      const first = node.arguments[0];
      if (first?.type === 'ArrayExpression') {
        sites.push({ file, routesArray: first });
      }
    }

    if (node.type === 'VariableDeclarator' && node.init?.type === 'ArrayExpression') {
      if (looksLikeRouteArray(node.init)) {
        sites.push({ file, routesArray: node.init });
      }
    }

    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      if (
        node.declaration.type === 'VariableDeclaration'
      ) {
        for (const d of node.declaration.declarations) {
          if (d.init?.type === 'ArrayExpression' && looksLikeRouteArray(d.init)) {
            sites.push({ file, routesArray: d.init });
          }
        }
      }
    }

    pushChildren(node, stack);
  }
}

function isRouterFactoryCall(callee: TSESTree.Expression): boolean {
  if (callee.type === 'Identifier') return ROUTER_FACTORY_NAMES.has(callee.name);
  if (
    callee.type === 'MemberExpression' &&
    callee.property.type === 'Identifier' &&
    ROUTER_FACTORY_NAMES.has(callee.property.name)
  ) {
    return true;
  }
  return false;
}

function looksLikeRouteArray(arr: TSESTree.ArrayExpression): boolean {
  if (arr.elements.length === 0) return false;
  for (const el of arr.elements) {
    if (!el) continue;
    if (el.type !== 'ObjectExpression') return false;
    let hasPath = false;
    let hasElementOrLazy = false;
    for (const prop of el.properties) {
      if (prop.type !== 'Property' || prop.key.type !== 'Identifier') continue;
      if (prop.key.name === 'path') hasPath = true;
      if (['element', 'Component', 'lazy', 'children'].includes(prop.key.name)) {
        hasElementOrLazy = true;
      }
    }
    if (!hasPath && !hasElementOrLazy) return false;
  }
  return true;
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
