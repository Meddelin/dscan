import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parse, type TSESTree } from '@typescript-eslint/typescript-estree';
import type { TsResolver } from '../resolve/ts-resolver.js';

const CHAIN_DEPTH_LIMIT = 3;
const JSX_EXT = new Set(['.tsx', '.jsx']);

/**
 * Given a file + symbol-name reachable from it, trace through `export ... from`
 * chains to find the file that actually OWNS the symbol (i.e. has a direct
 * declaration like `export const Foo = ...` or `export function Foo`).
 *
 * Use cases:
 *   - PF2.3: `<Pages.Dashboard/>` resolves the namespace to `pages/index.ts`
 *     (a barrel). Chasing further yields `pages/Dashboard.tsx`, so each route
 *     binds to the defining file and per-route metric E is accurate.
 *   - PF2.6: shared-library page components — same chase logic, depth-3
 *     limit honours the explicit requirement.
 *
 * If we can't reduce further (no matching re-export, file unparseable,
 * depth exceeded, cycle), we return the last successfully-resolved absPath.
 * That keeps callers honest — they always get *some* in-repo file to anchor
 * the route, just possibly the barrel one.
 */
export class MemberChaser {
  private readonly fileCache = new Map<string, TSESTree.Program | null>();

  constructor(private readonly resolver: TsResolver) {}

  async chaseDefiningFile(
    absPath: string,
    symbol: string,
  ): Promise<{ absPath: string; symbol: string }> {
    return this.step(absPath, symbol, 0, new Set());
  }

  private async step(
    absPath: string,
    symbol: string,
    depth: number,
    visited: Set<string>,
  ): Promise<{ absPath: string; symbol: string }> {
    if (depth > CHAIN_DEPTH_LIMIT) return { absPath, symbol };
    const key = `${absPath.replace(/\\/g, '/').toLowerCase()}::${symbol}`;
    if (visited.has(key)) return { absPath, symbol };
    visited.add(key);

    const ast = await this.loadAst(absPath);
    if (!ast) return { absPath, symbol };

    // Look for `export { X [as Y] } from 'source'` re-exports matching `symbol`.
    // Also handle `export * from 'source'` — descend into each `*` source and
    // check (one extra hop).
    for (const node of ast.body) {
      if (
        node.type === 'ExportNamedDeclaration' &&
        node.source &&
        typeof node.source.value === 'string'
      ) {
        for (const spec of node.specifiers) {
          if (spec.type !== 'ExportSpecifier') continue;
          const exported =
            spec.exported.type === 'Identifier' ? spec.exported.name : null;
          const local =
            spec.local.type === 'Identifier' ? spec.local.name : null;
          if (!exported || !local) continue;
          if (exported !== symbol) continue;
          // Match — descend into source with `local` as the next-step name.
          const next = this.resolver.resolve(node.source.value, absPath);
          if (next.kind === 'in-repo') {
            return this.step(next.absPath, local, depth + 1, visited);
          }
          return { absPath, symbol };
        }
      } else if (
        node.type === 'ExportAllDeclaration' &&
        typeof node.source.value === 'string'
      ) {
        const next = this.resolver.resolve(node.source.value, absPath);
        if (next.kind === 'in-repo') {
          // Best-effort: see if `symbol` is an own export of the star source;
          // if so, that's where it lives. Otherwise keep chaining within `*`.
          const result = await this.step(
            next.absPath,
            symbol,
            depth + 1,
            visited,
          );
          if (result.absPath !== next.absPath) {
            // The recursion advanced — propagate.
            return result;
          }
          // Recursion didn't advance; check if next.absPath itself owns it.
          const ownAst = await this.loadAst(next.absPath);
          if (ownAst && ownsSymbol(ownAst, symbol)) {
            return { absPath: next.absPath, symbol };
          }
        }
      }
    }

    return { absPath, symbol };
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

function ownsSymbol(ast: TSESTree.Program, name: string): boolean {
  for (const node of ast.body) {
    if (node.type === 'ExportDefaultDeclaration' && name === 'default') {
      return true;
    }
    if (
      node.type === 'ExportNamedDeclaration' &&
      node.declaration?.type === 'VariableDeclaration'
    ) {
      for (const d of node.declaration.declarations) {
        if (d.id.type === 'Identifier' && d.id.name === name) return true;
      }
    }
    if (
      node.type === 'ExportNamedDeclaration' &&
      node.declaration?.type === 'FunctionDeclaration' &&
      node.declaration.id?.name === name
    ) {
      return true;
    }
    if (
      node.type === 'ExportNamedDeclaration' &&
      node.declaration?.type === 'ClassDeclaration' &&
      node.declaration.id?.name === name
    ) {
      return true;
    }
  }
  return false;
}
