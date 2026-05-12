import type { ParsedFile } from '../pipeline/parse.js';
import type { TsResolver } from '../resolve/ts-resolver.js';
import { discoverRouteConfigs, type DiscoveredConfigSite } from './discovery.js';
import { extractRoutes } from './page-extract.js';
import { ImportGraph, normalize } from './import-graph.js';
import type { FileRouteBinding, RouteResolution, RouteWarning } from './types.js';

export interface ResolveRoutesInput {
  parsed: ParsedFile[];
  resolver: TsResolver;
  depthLimit: number;
}

/**
 * Stage 7 orchestrator (§4.7).
 *
 * Returns a map of file → route binding PLUS the raw entries (for diagnostics).
 * Unsupported repos — no discovered route config — are the caller's
 * responsibility to tag as `{ kind: 'unsupported' }` at the record level;
 * here we simply return an empty byFile and empty entries.
 */
export function resolveRoutes(input: ResolveRoutesInput): RouteResolution {
  const sites = discoverRouteConfigs(input.parsed);
  if (sites.length === 0) {
    return { byFile: new Map(), entries: [], warnings: [] };
  }

  const entries = extractRoutes(sites, input.resolver);
  const warnings: RouteWarning[] = [];
  for (const e of entries) {
    for (const w of e.warnings) {
      const colonIdx = w.indexOf(':');
      const code = colonIdx === -1 ? w : w.slice(0, colonIdx);
      warnings.push({
        filePath: e.configFilePath,
        absPath: e.configAbsPath,
        routePath: e.path,
        code,
        message: w,
      });
    }
  }

  const graph = new ImportGraph(input.parsed, input.resolver, input.depthLimit);

  // For each entry with a resolvable page, compute the reachable set.
  const perRouteReachable = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (!entry.pageComponentFile) continue;
    const reachable = graph.reachable(entry.pageComponentFile);
    perRouteReachable.set(entry.path, reachable);
  }

  // §4.7.5 edge case: JSX usages declared inside a route-config file itself
  // (e.g. `<DefaultFallback/>` used directly in the routes array) should be
  // bound to every route the config declares. Add each config-site file to
  // the reachable set of every route that site defines.
  addConfigSitesToReachable(sites, entries, perRouteReachable);

  // For each file, collect the set of routes that reach it.
  const reachingRoutes = new Map<string, Set<string>>();
  for (const [path, reachable] of perRouteReachable) {
    for (const file of reachable) {
      const cur = reachingRoutes.get(file) ?? new Set<string>();
      cur.add(path);
      reachingRoutes.set(file, cur);
    }
  }

  // Every file in the parse set gets an explicit binding (no implicit
  // unmapped — makes downstream iteration simpler).
  const byFile = new Map<string, FileRouteBinding>();
  for (const parsedFile of input.parsed) {
    const key = normalize(parsedFile.file.absPath);
    const routes = reachingRoutes.get(key);
    if (!routes || routes.size === 0) {
      byFile.set(key, { kind: 'unmapped' });
    } else if (routes.size === 1) {
      const [path] = routes;
      byFile.set(key, { kind: 'bound', path: path as string });
    } else {
      byFile.set(key, {
        kind: 'shared',
        paths: [...routes].sort(),
      });
    }
  }

  return { byFile, entries, warnings };
}

function addConfigSitesToReachable(
  sites: DiscoveredConfigSite[],
  entries: RouteResolution['entries'],
  perRouteReachable: Map<string, Set<string>>,
): void {
  const sitesByFile = new Map<string, Set<string>>(); // configFile → entry paths
  const pathToConfigFile = new Map<string, string>();

  for (const site of sites) {
    const key = normalize(site.file.file.absPath);
    sitesByFile.set(key, new Set());
    for (const element of site.routesArray.elements) {
      if (!element) continue;
      // Walk all entries whose origin is this site is not trivial without
      // threading origin through extractRoutes. As a pragmatic MVP, bind the
      // config file to EVERY discovered entry path — a config file that owns
      // all routes in the repo is the overwhelming common case.
    }
    for (const entry of entries) {
      sitesByFile.get(key)!.add(entry.path);
      pathToConfigFile.set(entry.path, key);
    }
  }

  for (const [configFile, routePaths] of sitesByFile) {
    for (const path of routePaths) {
      const existing = perRouteReachable.get(path) ?? new Set<string>();
      existing.add(configFile);
      perRouteReachable.set(path, existing);
    }
  }
}
