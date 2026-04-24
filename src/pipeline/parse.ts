import { readFile } from 'node:fs/promises';
import { parse, type AST_NODE_TYPES, type TSESTree } from '@typescript-eslint/typescript-estree';
import type { DiscoveredFile } from './discovery.js';
import type { Warning } from '../types/dataset.js';

export interface ParsedFile {
  file: DiscoveredFile;
  source: string;
  ast: TSESTree.Program;
}

export interface ParseResult {
  parsed: ParsedFile[];
  warnings: Warning[];
}

/**
 * Stage 2: Parse (§4.2).
 * Tolerant-mode parse via @typescript-eslint/typescript-estree.
 * Files that fail to parse → warning + skip, scan continues.
 */
export async function parseFiles(files: DiscoveredFile[]): Promise<ParseResult> {
  const parsed: ParsedFile[] = [];
  const warnings: Warning[] = [];

  for (const file of files) {
    let source: string;
    try {
      source = await readFile(file.absPath, 'utf-8');
    } catch (err) {
      warnings.push({
        repoId: file.repoId,
        filePath: file.relPath,
        code: 'file-read-failed',
        message: (err as Error).message,
      });
      continue;
    }

    try {
      const ast = parse(source, {
        loc: true,
        range: true,
        jsx: true,
        errorOnUnknownASTType: false,
        // typescript-estree requires this to be set explicitly per docs
        comment: false,
        tokens: false,
      });
      parsed.push({ file, source, ast });
    } catch (err) {
      warnings.push({
        repoId: file.repoId,
        filePath: file.relPath,
        code: 'parse-failed',
        message: (err as Error).message.slice(0, 200),
      });
    }
  }

  return { parsed, warnings };
}

export type { AST_NODE_TYPES, TSESTree };
