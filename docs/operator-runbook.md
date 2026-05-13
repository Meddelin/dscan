# Operator Runbook — Beaver Adoption Scanner

Audience: Stanislav (initial operator), later on-call engineer responsible for
the weekly/bi-weekly run.

This document assumes M1–M6a + pilot-fixes + the PF2 series (member
expressions in routes, path-const evaluation, shared libraries, barrel
chain resolution, invariant-completeness fixes) have landed. Worker pool
(M6b) and production cron runner (Phase 2) are out of scope.

## Prerequisites

1. **Node 20.10+** on the machine.

2. **SSH access** to self-hosted GitLab (`gitlab.tbank.ru`) with keys loaded
   into the agent. The scanner runs `git clone --depth=1 --single-branch`
   under the hood — any SSH error surfaces verbatim.

   ```bash
   # If you skipped Keychain (macOS) or Credential Manager (Windows),
   # add the key for this shell session:
   ssh-add ~/.ssh/id_ed25519
   ```

3. **Network** to Beaver repo + every consumer repo.

4. **Disk**: ~5–10 GB free for `ds-projects/` on first full scan
   (100 repos shallow-cloned).

## One-time setup

```bash
git clone git@github.com:Meddelin/dscan.git
cd dscan
npm install
npm run typecheck    # sanity check
npm test             # all 108 specs must pass
```

## Configure a run

Create `ds-scanner.config.ts` in the workspace root (the file name `analyze`
defaults to — any name works if you pass `--config <path>` explicitly):

```ts
import { defineConfig } from 'beaver-scan';

export default defineConfig({
  beaverUrl: 'ssh://git@gitlab.tbank.ru:7999/beaver-ui/beaver-ui.git',
  repositoriesFile: './repositories.json',
  output: { dir: './.ds-metrics/report', formats: ['jsonl', 'aggregates', 'html'] },
  thresholds: {
    reusableLocalFiles: 2,
    substantialMarkupElements: 5,
    unresolvedDynamicWarningPct: 0.05,
    shadowFalsePositiveTarget: 0.15,
    codeSnippetMaxLines: 200,
  },
  routeResolution: { enabled: true, router: 'react-router-v6' },
  // Cross-repo libraries — declared once here, applied to every consumer.
  // Use this for the design kits / utility packages many consumers share.
  // source.path is resolved relative to this config file.
  sharedLibraries: [
    {
      libId: 'team-platform',
      matchPattern: '@team/platform',
      source: { type: 'local-path', path: './shared-kits/team-platform' },
      kind: 'partially-beaver-backed',
    },
  ],
});
```

(The package is still named `beaver-scan` — that's the import path. The CLI
binary is registered under both `ds-scanner` and `beaver-scan`.)

And `repositories.json`:

```json
[
  { "name": "consumer-app-1", "gitUrl": "ssh://git@gitlab.tbank.ru:7999/consumer/app-1.git" },
  { "name": "consumer-app-2", "gitUrl": "ssh://git@gitlab.tbank.ru:7999/consumer/app-2.git" }
]
```

Consumer repos **do not need to ship any config** — the scanner applies sane
built-in defaults (`include: src/**/*.{ts,tsx,js,jsx}`, standard excludes,
route resolution on, no localLibraries). When defaults aren't enough,
per-repo settings live in one of two places, in this precedence order:

1. **Consumer's `.beaver-scan.json`** (at repo root) — wins when present.
2. **Inline `config` on the entry in `repositories.json`** — operator-side
   override, no need to coordinate with consumer teams:

   ```json
   [
     {
       "name": "consumer-app-1",
       "gitUrl": "ssh://git@gitlab.tbank.ru:7999/consumer/app-1.git",
       "config": {
         "exclude": ["src/legacy/**"],
         "localLibraries": [
           {
             "libId": "team-ui-kit",
             "matchPattern": "src/shared/ui-kit/**",
             "source": { "type": "local-path", "path": "src/shared/ui-kit" },
             "kind": "partially-beaver-backed"
           }
         ]
       }
     }
   ]
   ```

3. **Built-in defaults** (Zod schema). Missing config is not an error.

A present-but-malformed config (consumer-side `.beaver-scan.json` or inline)
fails fast with exit code 2 — typos shouldn't slip through.

For libraries shared across every consumer (one DS kit, many apps), use the
top-level `sharedLibraries` field in the global config instead — declared
once, no per-repo wiring needed. Per-repo `localLibraries` with the same
`libId` override the shared entry entirely.

## First run — pilot

Run on 5–10 repos first. Expect 1–5 minutes end-to-end on a workstation.

Two equivalent flows:

```bash
# A) Dev mode — no build step. tsx loads .ts configs at runtime.
npm run dev -- run --config ./ds-scanner.config.ts

# B) Built CLI (preferred for repeatable runs / production runner).
#    Compiled bin still accepts .ts configs — tsx is registered on demand.
npm run build
node scripts/clone-repos.mjs                       # clone consumer repos to ./ds-projects/
npx ds-scanner analyze --output .ds-metrics/report
```

`analyze` defaults to `--config ds-scanner.config.ts` and `--output
.ds-metrics/report`. Use `run` instead when you want a config-driven output
directory or different flags.

## Output

Artefacts (in `--output` dir, default `./.ds-metrics/report/`):

- `dataset.jsonl` — instance-level records (one per JSX usage)
- `aggregates.json` — metrics A/B/C/D/E + invariant report
- `report.html` — self-contained viewer (no fetch / no backend; just open it)
- `warnings.json` — non-fatal diagnostics; every entry is annotated with
  `repoId` and (where applicable) `filePath` so navigation is one click

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | Success — all artefacts produced, no invariant violations. |
| 1 | Generic fatal error (network, FS, etc.). stderr has the stack. |
| 2 | Config validation failed (Zod). stderr has the field path. |
| 3 | Domain invariant violation (§10.1). Re-run with `--no-fail-on-invariant` to inspect `aggregates.invariants.violations[]` anyway. |

## Measure false-positive rate (PRD §10.3)

After the pilot scan:

1. Extract 50 random shadow-bucket records:

   ```bash
   grep '"bucket":"shadow"' .ds-metrics/report/dataset.jsonl | shuf -n 50 > fp-review.jsonl
   ```

2. For each record, open the file + line in an IDE and manually judge:
   "is this really a shadow duplicate of Beaver?" Record verdicts in a
   spreadsheet.

3. Compute:

   ```
   FP-rate = count(verdict="not shadow") / 50
   ```

4. **Target: ≤ 15%.** If exceeded, tune via `repositories.json` inline
   `config`:

   - **Primitive-name whitelist** — narrow per-repo via
     `primitiveNamesOverride` if the repo has a domain `Card`/`Button` not
     about UI.
   - **Substantial-markup threshold** — raise from 5 to 7/10 if too many
     small layout wrappers slip through.
   - **Local-library declarations** — list vendored directories as
     `kind: 'partially-beaver-backed'` so Stage 5b prescan opts them out
     of shadow at the source.

## Full 100-repo scan

Once FP-rate is acceptable:

```bash
node scripts/clone-repos.mjs                                     # idempotent — skips existing
npx ds-scanner analyze --config ds-scanner.config.ts --output .ds-metrics/report
```

Expected duration on an average workstation: **10–30 minutes** (SLA target
§8.2, single-process baseline). If wall-clock becomes a blocker, escalate
to M6b worker pool — see [implementation/plan.md](../implementation/plan.md).

## Interpreting the HTML viewer

- **Hero row** — four headline metrics (§7):
  - Global Adoption (A) — `adoption / (adoption + shadow)`
  - Per-repo mean (B) — unweighted average across scanned repos
  - Confirmed shadow groups (C) — distinct `confirmed`-level groups
  - Beaver packages seen (D) — unique leaf packages detected

- **Section B** — per-repo adoption. Use this to prioritise outreach.
- **Section C** — default view: per-component groups (one row per
  `(name, propSig, jsxBucket)` hash). Use this to decide "which component
  to **add to Beaver**". Toggle to per-file for specific migration tickets.
- **Section D** — package coverage. Low `reposUsing` flags under-promoted
  packages.
- **Section E** — per-route adoption. Useful when triaging "/checkout is
  worse than /admin". Denominator is `bucket=adoption|shadow` AND
  `route.kind === 'bound'` only — shared / unmapped usages don't pollute it.
- **Shared components** — files reachable from 2+ pages. Don't anchor a
  single-route metric but matter for adoption strategy.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Exit code 2 | Invalid config (Zod failure) | stderr includes the offending field path. |
| Exit code 3 | Invariant violation | Re-run with `--no-fail-on-invariant` and inspect `aggregates.invariants.violations[]`. |
| `dataset-completeness-shadow` violation (delta > 0) | (Pre-PF2.7 bug) Barrel-aliased profile counter overwrite OR default-import name mismatch OR `export *` not propagated. Fixed in `bd0c517`. | Pull latest. If still nonzero, send the `warnings.json` + violation message — likely a fifth re-export pattern not yet covered. |
| `git clone failed` for a consumer | SSH / network / missing repo | stderr is raw git. No retry — fix the underlying issue and re-run. SSH? `ssh-add ~/.ssh/id_ed25519`. |
| `Invalid per-repo config` | Malformed `.beaver-scan.json` OR inline override | stderr shows Zod-style path to the field. Missing config is fine — defaults apply. |
| `parse-failed` warning storm on `.ts` files | (Pre-pilot bug) Parser was given `jsx: true` for non-JSX `.ts`. Fixed in `0e0a4b3`. | Pull latest; `jsx` is now decided per file extension. |
| `unresolved-dynamic-rate-exceeded` warning | Repo uses `React.createElement` / lookup-by-string patterns | Not fatal — artefacts are still produced. Open `warnings.json` for the specific records. Heavy users may need `unresolvedDynamicWarningPct` raised. |
| `route-resolution-warning` with `page-import-not-in-repo` | Route `element` references a symbol that resolves outside the repo. | Each warning includes the route-config `filePath` + `absPath`. Common fix: ensure the page component is imported as a relative/aliased path, not as a re-export from an external package. |
| `route-resolution-warning` with `dynamic-path-skipped` | Path uses an unsupported form: template literal with substitutions, computed access (`PATHS[k]`), or function call. PF2.4 supports identifier / member-access / cross-file imports. | Convert to a static const lookup (`path: ROUTER_PATHS.foo`) where possible. Template literals with no substitutions also work. |
| `route-resolution-warning` with `jsx-member-unresolved` | `<NS.X/>` where `NS`'s import doesn't resolve in-repo, OR `X` isn't reachable through the resolved file. PF2.6 chains barrels to depth 3 — beyond that we stop. | Check that `NS` is a relative/aliased import (not an external package) and that the source file actually owns `X`. |
| Wrapped route element doesn't bind a page | Element is `<Guard><Page/></Guard>` — pre-`0e0a4b3` builds skipped the inner JSX. | Pull latest; resolver walks the JSX tree (depth 5) and prefers the first in-repo candidate, including member-expression children (PF2.3 + PF2.5). |
| `<Form.Item/>` shows up as `unresolved-dynamic` | (Pre-pilot bug) Member expressions on Beaver imports were rejected. Fixed in `0e0a4b3` + PF2.3. | Pull latest; §5.5 member resolution canonicalises to the base Beaver package. |
| Shared design kit not picked up across repos | Operator didn't declare it. | Add a `sharedLibraries` entry in the global config (PF2.2). `source.path` is relative to where the config file lives. |
| `local-lib-prescan-failed` warning | The `source.path` directory is missing or unreadable. | Check the path in `localLibraries[].source.path` (or `sharedLibraries[].source.path`). Components from that lib fall back to per-repo config `kind`. |
| Many distinct routes via same barrel collapse to `shared` | (Pre-PF2.6 bug) Page resolved at the barrel, not at the leaf file. Fixed in `e730db2`. | Pull latest; barrel chain walks down to defining files (depth 3). |
| Cached clone ahead of remote | Commit timeline drift | `npx ds-scanner update --config ds-scanner.config.ts` does `git pull --ff-only` across the cache. |
| Cache grew too large | Weekly-run default | `npx ds-scanner clean --config ds-scanner.config.ts` nukes `.cache/`. Next run re-clones from scratch. |

## When to bump schemaVersion

PRD §6.4: `dataset.jsonl` records carry `schemaVersion`. Rules:

- **Patch-compatible** additions (new optional fields, new warning codes):
  stay on `1.1`.
- **Breaking** (rename, retyped, removed field): bump to `2.0`. Ping BI
  consumers first.

## Hand-off checklist to on-call

- [ ] SSH keys on runner host; `git describe --tags` works in the Beaver repo.
- [ ] `repositories.json` reviewed with the source-of-truth team.
- [ ] Per-repo overrides in `repositories.json` for repos where defaults
      miss (most won't need any). Consumer teams don't need to add anything
      to their own repos.
- [ ] Cron example for weekly run (not MVP; include when Phase 2 lands).
- [ ] Alert if scan exit code ≠ 0 for two consecutive runs.
