# warnings.json codes

Every entry in `warnings.json` has the shape:

```json
{ "repoId": "...", "filePath": "...", "absPath": "...", "code": "...", "message": "..." }
```

- `repoId` — filled for every per-repo warning.
- `filePath` — repo-relative, forward-slashed. Stable across machines;
  preferred field for BI / cross-host pipelines.
- `absPath` — absolute path on the operator's filesystem (same file as
  `filePath`). Use it for one-click navigation from terminal / IDE.
  Ignore in BI pipelines.

Both are present when the warning is anchored to a specific file —
including `route-resolution-warning`, where they point at the route-config
file (`router.tsx` / `routes.ts`), not at the offending page-component.

| Code | Source | Meaning |
|------|--------|---------|
| `file-read-failed` | Stage 2 Parse | Could not read the file off disk — permission, encoding, I/O error. |
| `parse-failed` | Stage 2 Parse | `@typescript-eslint/typescript-estree` rejected the source. File is skipped, scan continues (§4.2 tolerant mode). The parser receives `jsx: true` only for `.tsx`/`.jsx` extensions — pure `.ts` files parse without JSX so generics like `<T>` aren't misread. |
| `local-lib-prescan-failed` | Stage 5b Prescan | A local-library's `source.path` couldn't be scanned (disk missing, mass parse error). Components from that lib fall back to per-repo config `kind` (§4.5). |
| `unresolved-dynamic-rate-exceeded` | Stage 6 Classify | Per-repo share of `UnresolvedRecord` > `thresholds.unresolvedDynamicWarningPct` (§5.4, default 5%). Review: dynamic `React.createElement` / lookups may be skewing metrics. |
| `route-resolution-warning` | Stage 7 Routes | A route entry could not be fully bound to a page component. `filePath` points at the route-config file; the message is prefixed with a sub-code in brackets — e.g. `[page-not-imported:CreateProject]`, `[page-import-not-in-repo:Foo from @ext/...]`, `[dynamic-path-skipped]`, `[page-unresolved:conditional-element]`, `[page-unresolved:hoc-wrapped-element]`, `[no-jsx-candidate-resolved]`. The route still registers; it just doesn't anchor any import-graph binding. Wrapper-around-page (`<Guard><Page/></Guard>`) is unwrapped automatically — only emits the warning when *no* descendant in the JSX tree resolves in-repo. |
| `repo-clone-failed` | Ops | SSH clone failed for a consumer repo — network, missing repo, auth. Scan fails fast (§8.3). |
| `stage7-disabled` | Ops | Stage 7 was explicitly disabled via config; usages keep `kind: 'unsupported'`. |

## Adding a new warning code

1. Add the string literal to `WARNING_CODES` in `src/config/schema.ts`.
2. Emit it somewhere in `src/pipeline/` with a clear `message`.
3. Document it in this file.
