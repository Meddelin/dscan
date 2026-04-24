import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DatasetRecord, UnresolvedRecord, UsageRecord } from '../types/dataset.js';

/**
 * Stable sort key per §8.4: (repoId, filePath, line, column) for usages;
 * unresolved records sort after usages with same (repoId, filePath) by line.
 */
export function sortRecords(records: DatasetRecord[]): DatasetRecord[] {
  return [...records].sort((a, b) => {
    const cmpRepo = cmp(recordRepo(a), recordRepo(b));
    if (cmpRepo !== 0) return cmpRepo;
    const cmpFile = cmp(recordFile(a), recordFile(b));
    if (cmpFile !== 0) return cmpFile;
    const kindOrder = kindRank(a) - kindRank(b);
    if (kindOrder !== 0) return kindOrder;
    const cmpLine = recordLine(a) - recordLine(b);
    if (cmpLine !== 0) return cmpLine;
    return recordColumn(a) - recordColumn(b);
  });
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function recordRepo(r: DatasetRecord): string {
  return r.repoId;
}

function recordFile(r: DatasetRecord): string {
  return r.filePath;
}

function recordLine(r: DatasetRecord): number {
  if (r.kind === 'shadow-component') return 0;
  return (r as UsageRecord | UnresolvedRecord).line;
}

function recordColumn(r: DatasetRecord): number {
  if (r.kind === 'usage') return r.column;
  return 0;
}

function kindRank(r: DatasetRecord): number {
  switch (r.kind) {
    case 'usage':
      return 0;
    case 'shadow-component':
      return 1;
    case 'unresolved-dynamic':
      return 2;
  }
}

export async function writeJsonl(path: string, records: DatasetRecord[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createWriteStream(path, { encoding: 'utf-8' });
    stream.on('error', rejectPromise);
    stream.on('finish', resolvePromise);
    for (const record of records) {
      stream.write(JSON.stringify(record) + '\n');
    }
    stream.end();
  });
}

export async function readJsonl(path: string): Promise<DatasetRecord[]> {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(path, 'utf-8');
  const out: DatasetRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    out.push(JSON.parse(trimmed) as DatasetRecord);
  }
  return out;
}
