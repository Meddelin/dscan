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
| `route-resolution-warning` | Stage 7 Routes | A route entry could not be fully bound to a page component. `filePath` / `absPath` point at the route-config file; the message is prefixed with a sub-code in brackets. **JSX-side codes:** `page-not-imported:Foo`, `page-import-not-in-repo:Foo from ./bar`, `jsx-member-base-not-imported:Pages (in tag <Pages.Foo/>)`, `jsx-member-unresolved:Pages.Foo (base Pages from ./pages)`, `page-unresolved:conditional-element`, `page-unresolved:hoc-wrapped-element`, `no-jsx-candidate-resolved`. **Path-side codes (PF2.4):** `dynamic-path-skipped` (generic), `dynamic-path-template-literal` (\`${BASE}/x\`), `dynamic-path-binding-not-found:Foo`, `dynamic-path-import-not-in-repo:Foo from ./bar`, `dynamic-path-export-not-found:Foo in <file>`, `dynamic-path-non-static-member` (computed property `PATHS[k]`), `dynamic-path-cycle`, `dynamic-path-depth-exceeded` (chain > 5 hops), `dynamic-path-non-object-segment:<type>`, `dynamic-path-missing-property:foo`, `dynamic-path-source-unparseable:<file>`, `dynamic-path-unsupported:<NodeType>`. The route still registers if the path resolves but the element fails (or vice versa); it just doesn't anchor any import-graph binding. Wrapper-around-page (`<Guard><Page/></Guard>`) and member-expression element (`<Pages.Foo/>`, `<NS.Sub.X/>`) are unwrapped automatically — JSX tree depth capped at 5 — only emits the warning when *no* candidate in the tree resolves in-repo. |
| `repo-clone-failed` | Ops | SSH clone failed for a consumer repo — network, missing repo, auth. Scan fails fast (§8.3). |
| `stage7-disabled` | Ops | Stage 7 was explicitly disabled via config; usages keep `kind: 'unsupported'`. |

## Adding a new warning code

1. Add the string literal to `WARNING_CODES` in `src/config/schema.ts`.
2. Emit it somewhere in `src/pipeline/` with a clear `message`.
3. Document it in this file.
