# warnings.json codes

Every entry in `warnings.json` has the shape:

```json
{ "repoId": "...", "filePath": "...", "code": "...", "message": "..." }
```

`repoId` and `filePath` are optional — populated when the warning is scoped
to a file or a repo. `code` is one of the values below.

| Code | Source | Meaning |
|------|--------|---------|
| `file-read-failed` | Stage 2 Parse | Could not read the file off disk — permission, encoding, I/O error. |
| `parse-failed` | Stage 2 Parse | `@typescript-eslint/typescript-estree` rejected the source. File is skipped, scan continues (§4.2 tolerant mode). |
| `local-lib-prescan-failed` | Stage 5b Prescan | A local-library's `source.path` couldn't be scanned (disk missing, mass parse error). Components from that lib fall back to per-repo config `kind` (§4.5). |
| `unresolved-dynamic-rate-exceeded` | Stage 6 Classify | Per-repo share of `UnresolvedRecord` > `thresholds.unresolvedDynamicWarningPct` (§5.4, default 5%). Review: dynamic `React.createElement` / lookups may be skewing metrics. |
| `route-resolution-warning` | Stage 7 Routes | Individual route registered without a page component because the form wasn't supported (`dynamic-path`, `conditional-element`, `hoc-wrapped-element`, `non-function-lazy`, etc. — see §4.7.2). Route still lists but contributes nothing to binding. |
| `repo-clone-failed` | Ops | SSH clone failed for a consumer repo — network, missing repo, auth. Scan fails fast (§8.3). |
| `stage7-disabled` | Ops | Stage 7 was explicitly disabled via config; usages keep `kind: 'unsupported'`. |

## Adding a new warning code

1. Add the string literal to `WARNING_CODES` in `src/config/schema.ts`.
2. Emit it somewhere in `src/pipeline/` with a clear `message`.
3. Document it in this file.
