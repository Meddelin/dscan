# Operator Runbook — Beaver Adoption Scanner

Audience: Stanislav (initial operator), later on-call engineer responsible for
the weekly/bi-weekly run.

This document assumes M1–M6a have landed. Worker pool (M6b) and real
production runner (Phase 2) are out of scope.

## Prerequisites

1. **Node 20.10+** on the machine.
2. **SSH access** to self-hosted GitLab (`gitlab.tbank.ru`), with keys loaded
   into the local agent. The scanner runs `git clone --depth=1
   --single-branch` under the hood — any SSH error surfaces verbatim.

   ```bash
   # If you skipped Keychain / Credential Manager, load the key into the
   # agent for this shell session:
   ssh-add ~/.ssh/id_ed25519
   ```

3. **Network** to Beaver repo + every consumer repo.
4. **Disk**: ~5–10 GB free for `ds-projects/` on first full scan (100 repos
   shallow-cloned).

## One-time setup

```bash
git clone git@github.com:<your-org>/dscan.git
cd dscan
npm install
npm run typecheck   # sanity check
npm test            # all 78 specs must pass
```

## Configure a run

Create (or edit) `.beaver-scan.config.ts`:

```ts
import { defineConfig } from 'beaver-scan';

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
  routeResolution: { enabled: true, router: 'react-router-v6' },
});
```

And `repositories.json`:

```json
[
  { "name": "consumer-app-1", "gitUrl": "ssh://git@gitlab.tbank.ru:7999/consumer/app-1.git" },
  { "name": "consumer-app-2", "gitUrl": "ssh://git@gitlab.tbank.ru:7999/consumer/app-2.git" }
]
```

Consumer repos **do not need to ship any config** — the scanner applies
sane built-in defaults (`include: src/**/*.{ts,tsx,js,jsx}`, standard
excludes, no localLibraries, route resolution on). When defaults aren't
enough, per-repo settings live in one of two places, with this precedence:

1. **Consumer's `.beaver-scan.json`** (at repo root) — if present, wins.
2. **Inline `config` in `repositories.json`** — operator-side override:

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

3. **Built-in defaults** (Zod schema).

A present-but-malformed `.beaver-scan.json` still fails fast (exit 2) —
typos shouldn't silently fall through.

## First run — pilot

Run on 5–10 repos first. Expect 1–5 minutes end-to-end.

Two equivalent ways to invoke:

```bash
# Dev mode — no build step, .ts config loads via tsx automatically.
npm run dev -- run --config ./ds-scanner.config.ts

# Built CLI (preferred for production runner). The compiled bin still
# accepts .ts configs; tsx is registered on demand.
npm run build
node scripts/clone-repos.mjs                 # clone consumer repos to ./ds-projects/
npx ds-scanner analyze --output .ds-metrics/report
```

`analyze` defaults to `--config ds-scanner.config.ts` and `--output
.ds-metrics/report`. Use `run` instead when you want the config-driven
output directory or different flags.

Output:
- `./results/dataset.jsonl` — instance-level records (one per JSX usage)
- `./results/aggregates.json` — metrics A/B/C/D/E + invariant report
- `./results/report.html` — self-contained viewer (open in any browser)
- `./results/warnings.json` — parse/prescan/route warnings

On successful completion the process exits 0. Exit 3 signals an invariant
violation (§10.1) — re-run with `--no-fail-on-invariant` to get the artefacts
anyway and inspect `aggregates.invariants.violations[]`.

## Measure false-positive rate (PRD §10.3)

After the pilot scan:

1. Extract 50 random shadow-bucket records:
   ```bash
   grep '"bucket":"shadow"' results/dataset.jsonl | shuf -n 50 > fp-review.jsonl
   ```

2. For each record, open the file + line in an IDE and manually judge: "is
   this really a shadow duplicate of Beaver?" Record verdicts in a
   spreadsheet.

3. Compute:
   ```
   FP-rate = count(verdict="not shadow") / 50
   ```

4. **Target: ≤ 15%.** If exceeded, tune:
   - **Primitive-name whitelist** — narrow it per-repo via
     `primitiveNamesOverride` in `.beaver-scan.json` if a repo has domain
     `Card`/`Button` semantics unrelated to UI.
   - **Substantial-markup threshold** — raise from 5 to 7/10 if too many
     small layout wrappers slip through.
   - **Local-library declarations** — list vendored directories as
     `kind: 'partially-beaver-backed'` so prescan opts them out of shadow.

## Full 100-repo scan

Once FP-rate is acceptable:

```bash
node scripts/clone-repos.mjs                                # idempotent — skips existing
npx ds-scanner analyze --config ds-scanner.config.ts --output .ds-metrics/report
```

Expected duration on an average workstation: **10–30 minutes** (SLA target
§8.2, pre-worker-pool baseline). If this is a blocker, escalate to M6b
(`child_process.fork()` workers — see implementation/plan.md).

## Interpreting the HTML viewer

- **Hero row** — four headline metrics (§7):
  - Global Adoption (A) — `adoption / (adoption + shadow)`
  - Per-repo mean (B) — unweighted average of B across scanned repos
  - Confirmed shadow groups (C) — distinct shadow-component groups at
    `confirmed` level
  - Beaver packages seen (D) — unique leaf packages detected

- **Section B** — per-repo adoption. Use this to prioritise outreach.
- **Section C** — default view: per-component groups (one row per
  `(name, propSig, jsxBucket)` hash). Use this to decide "which component
  to **add to Beaver**". Toggle to per-file for specific migration tickets.
- **Section D** — package coverage. Low `reposUsing` flags under-promoted
  packages.
- **Section E** — per-route adoption. Useful when triaging "/checkout is
  worse than /admin".

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Exit code 2 | Invalid config (Zod failure) | Error message points at the offending field path. |
| Exit code 3 | Invariant violation | Re-run with `--no-fail-on-invariant` and inspect `aggregates.invariants.violations[]` in the JSON output. |
| "git clone failed" for a consumer | SSH / network / missing repo | stderr is raw git. No retry — fix network and re-run. |
| Invalid per-repo config | Malformed `.beaver-scan.json` OR inline override | stderr shows Zod-style path to the offending field. Missing config is fine — defaults apply. |
| `unresolved-dynamic-rate-exceeded` warning | Repo uses `React.createElement` or lookup-by-string patterns | Not fatal — scan artefacts are still produced. Review `warnings.json` for specifics. Heavy-use repos may need `unresolvedDynamicWarningPct` raised or a custom plugin (out of MVP). |
| Cached clone ahead of remote | Commit timeline drift | `beaver-scan update --config ...` does `git pull --ff-only` across the cache. |
| Cache grew too large | Weekly-run default | `beaver-scan clean --config ...` nukes `.cache/`. Next run re-clones from scratch. |

## When to bump schemaVersion

PRD §6.4: `dataset.jsonl` records carry `schemaVersion`. Rules:
- **Patch-compatible** additions (new optional fields, new warning codes):
  stay on `1.1`.
- **Breaking** (rename, retyped, removed field): bump to `2.0`. Ping BI
  consumers first.

## Hand-off checklist to on-call

- [ ] SSH keys on runner host; `git describe --tags` works in the Beaver repo.
- [ ] `repositories.json` reviewed with source-of-truth team.
- [ ] Per-repo overrides added to `repositories.json` for repos where
      defaults miss (most won't need any). Consumer teams don't need to
      add anything to their own repos.
- [ ] Cron example for weekly run (not MVP; include when Phase 2 lands).
- [ ] Alert if scan exit code ≠ 0 for more than one consecutive run.
