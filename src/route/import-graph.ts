import type { TSESTree } from '@typescript-eslint/typescript-estree';
import type { ParsedFile } from '../pipeline/parse.js';
import type { TsResolver } from '../resolve/ts-resolver.js';

/**
 * Stage 7.4 (§4.7.4) — per-repo import graph.
 * Edge = static ImportDeclaration OR dynamic ImportExpression where the
 * resolved target falls inside the repo.
 *
 * Keys are normalised absolute paths (forward-slash, lower-case) so lookups
 * are case-insensitive on Windows without needing a separate canonical form.
 */
export class ImportGraph {
  private readonly edges = new Map<string, Set<string>>();

  constructor(
    files: ParsedFile[],
    resolver: TsResolver,
    private readonly depthLimit: number,
  ) {
    for (const file of files) {
      const key = normalize(file.file.absPath);
      const out = new Set<string>();
      for (const imp of collectImports(file.ast)) {
        const resolved = resolver.resolve(imp, file.file.absPath);
        if (resolved.kind === 'in-repo') {
          out.add(normalize(resolved.absPath));
        }
      }
      this.edges.set(key, out);
    }
  }

  reachable(from: string): Set<string> {
    const start = normalize(from);
    const seen = new Set<string>([start]);
    const queue: Array<{ node: string; depth: number }> = [{ node: start, depth: 0 }];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.depth >= this.depthLimit) continue;
      const next = this.edges.get(cur.node);
      if (!next) continue;
      for (const n of next) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push({ node: n, depth: cur.depth + 1 });
        }
      }
    }
    return seen;
  }

  hasNode(absPath: string): boolean {
    return this.edges.has(normalize(absPath));
  }
}

function collectImports(ast: TSESTree.Program): string[] {
  const out: string[] = [];
  const stack: TSESTree.Node[] = [ast];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'ImportDeclaration') {
      out.push(node.source.value);
    } else if (node.type === 'ImportExpression') {
      if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
        out.push(node.source.value);
      }
    } else if (
      // `export { X } from './foo'` and `export * from './foo'` both create
      // module-graph edges identical to `import { X } from './foo'`. Without
      // these, a barrel file like pages/index.ts has zero outbound edges
      // and the reachable set from a router pageComponentFile=index.ts
      // wouldn't include the actual page files — every route binding from
      // `<Pages.X/>` would collapse to `unmapped`.
      (node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') &&
      node.source &&
      typeof node.source.value === 'string'
    ) {
      out.push(node.source.value);
    }
    pushChildren(node, stack);
  }
  return out;
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

export function normalize(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}
