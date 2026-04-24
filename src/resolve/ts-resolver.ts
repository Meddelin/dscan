import { readFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath, isAbsolute } from 'node:path';
import ts from 'typescript';

/**
 * Thin wrapper around `ts.resolveModuleName` (§4.3).
 *
 * We don't build a full `ts.Program` — PRD §4.3 only needs module resolution,
 * and `createProgram` would re-parse every file. The resolver gives us three
 * things we actually use:
 *   1. Whether an import resolves inside the repo (→ absolute file path) or to
 *      an external package (node_modules / bare specifier we don't own).
 *   2. Honoring `tsconfig.json` paths aliases.
 *   3. Honoring `baseUrl`, `moduleResolution`, and other TS nuances for free.
 */
export type ResolveResult =
  | { kind: 'in-repo'; absPath: string }
  | { kind: 'external'; packageName: string }
  | { kind: 'unresolved' };

export interface TsResolver {
  readonly repoRoot: string;
  resolve(source: string, importerFile: string): ResolveResult;
}

export async function createTsResolver(
  repoRoot: string,
  tsconfigRel: string,
): Promise<TsResolver> {
  const absRoot = resolvePath(repoRoot);
  const tsconfigPath = isAbsolute(tsconfigRel)
    ? tsconfigRel
    : resolvePath(absRoot, tsconfigRel);

  const options = await loadCompilerOptions(tsconfigPath, absRoot);
  const host = ts.createCompilerHost(options, /*setParentNodes*/ false);
  const cache: Map<string, ResolveResult> = new Map();

  const resolve = (source: string, importerFile: string): ResolveResult => {
    const key = `${importerFile}::${source}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const result = resolveOne(source, importerFile, options, host, absRoot);
    cache.set(key, result);
    return result;
  };

  return { repoRoot: absRoot, resolve };
}

function resolveOne(
  source: string,
  importerFile: string,
  options: ts.CompilerOptions,
  host: ts.CompilerHost,
  repoRoot: string,
): ResolveResult {
  const { resolvedModule } = ts.resolveModuleName(
    source,
    importerFile,
    options,
    host,
  );

  if (!resolvedModule) {
    // Unresolved → could still be a bare import we know about by name
    // (e.g. Beaver packages live outside the repo). Fall back to name-based
    // classification.
    if (isBareSpecifier(source)) {
      return { kind: 'external', packageName: extractPackageName(source) };
    }
    return { kind: 'unresolved' };
  }

  const abs = resolvedModule.resolvedFileName;
  const absNormalized = resolvePath(abs);

  if (isInsideRoot(absNormalized, repoRoot)) {
    return { kind: 'in-repo', absPath: absNormalized };
  }
  // Anything TS resolved outside the repo root is effectively external.
  // Use the original import source to derive package name (more reliable
  // than walking up node_modules/).
  if (isBareSpecifier(source)) {
    return { kind: 'external', packageName: extractPackageName(source) };
  }
  return { kind: 'external', packageName: source };
}

async function loadCompilerOptions(
  tsconfigPath: string,
  repoRoot: string,
): Promise<ts.CompilerOptions> {
  let raw: string;
  try {
    raw = await readFile(tsconfigPath, 'utf-8');
  } catch {
    // No tsconfig found — resolver still works with sane defaults, we just
    // lose path aliases. This is fine for JS-only repos or tests.
    return defaultOptions(repoRoot);
  }
  const parsed = ts.parseConfigFileTextToJson(tsconfigPath, raw);
  if (parsed.error || !parsed.config) {
    // Malformed tsconfig — fail silent to defaults; categorize layer will
    // emit a warning elsewhere if the repo's own TS stops resolving.
    return defaultOptions(repoRoot);
  }
  const converted = ts.convertCompilerOptionsFromJson(
    (parsed.config as { compilerOptions?: unknown }).compilerOptions ?? {},
    dirname(tsconfigPath),
  );
  const options: ts.CompilerOptions = {
    ...defaultOptions(repoRoot),
    ...converted.options,
  };
  // ts needs the config directory to resolve `baseUrl` + `paths` correctly.
  if (options.baseUrl === undefined) {
    options.baseUrl = dirname(tsconfigPath);
  }
  return options;
}

function defaultOptions(repoRoot: string): ts.CompilerOptions {
  return {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.Preserve,
    allowJs: true,
    esModuleInterop: true,
    baseUrl: repoRoot,
  };
}

function isBareSpecifier(source: string): boolean {
  return (
    !source.startsWith('./') &&
    !source.startsWith('../') &&
    !source.startsWith('/') &&
    !isAbsolute(source)
  );
}

/**
 * For `@scope/pkg/sub/path` → `@scope/pkg`.
 * For `pkg/sub/path`        → `pkg`.
 */
export function extractPackageName(source: string): string {
  if (source.startsWith('@')) {
    const firstSlash = source.indexOf('/');
    if (firstSlash === -1) return source;
    const secondSlash = source.indexOf('/', firstSlash + 1);
    if (secondSlash === -1) return source;
    return source.slice(0, secondSlash);
  }
  const slash = source.indexOf('/');
  return slash === -1 ? source : source.slice(0, slash);
}

function isInsideRoot(abs: string, root: string): boolean {
  const normalizedAbs = abs.replace(/\\/g, '/').toLowerCase();
  const normalizedRoot = root.replace(/\\/g, '/').toLowerCase();
  const withSep = normalizedRoot.endsWith('/')
    ? normalizedRoot
    : normalizedRoot + '/';
  return normalizedAbs.startsWith(withSep);
}
