import { defineConfig } from '../src/index.js';

export default defineConfig({
  beaverUrl: 'ssh://git@gitlab.tbank.ru:7999/beaver-ui/beaver-ui.git',
  repositoriesFile: './repositories.json',
  output: { dir: './results', formats: ['jsonl', 'aggregates', 'html'] },
  thresholds: {
    reusableLocalFiles: 2,
    substantialMarkupElements: 5,
    unresolvedDynamicWarningPct: 0.05,
    shadowFalsePositiveTarget: 0.15,
    codeSnippetMaxLines: 200,
  },
  routeResolution: {
    enabled: true,
    router: 'react-router-v6',
    propagationBoundary: 'repo',
    importGraphDepthLimit: 20,
    collapseNestedRoutes: true,
  },
  // MVP stand-in for Beaver prescan (§4.5). List every package the scanner
  // should treat as Beaver. Aggregator packages (e.g. @beaver-ui/components)
  // are matched as-is — canonicalization lands with real prescan.
  beaverPackages: [
    '@beaver-ui/button',
    '@beaver-ui/side-navigation',
    '@beaver-ui/subheader',
    '@beaver-ui/components',
  ],
});
