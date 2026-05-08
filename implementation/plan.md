# Beaver Adoption Scanner — Implementation Plan

**Context:** PRD v2 ([../ds-adoption-scanner-prd-v2.md](../ds-adoption-scanner-prd-v2.md)).
**Owner:** Stanislav (solo).
**Horizon:** до первой production-сдачи (все 8 стадий + viewer + dry-run на реальных репо).

## Статус (snapshot)

| Веха | Коммит | Статус |
|------|--------|--------|
| M0 scaffold | `39e54a5` | ✅ |
| M1 resolve + Beaver prescan | `0af91f4` | ✅ |
| M2 Stage 6 Этап B + ShadowComponentRecord | `5db2d0d` | ✅ |
| M3 local-lib prescan + unresolved warnings | `c541a71` | ✅ |
| M4 route resolver (Stage 7) | `e43d6a9` | ✅ |
| M5 metric E + viewer v1 + update/clean | `2993784` | ✅ |
| M6a invariants + git clone + docs | `957b5a0` | ✅ |
| Per-repo config optional | `79a3f7b` | ✅ |
| Pilot fixes (parse / member-expr / wrapper / CLI / clone-repos) | `0e0a4b3` | ✅ |
| M6b worker pool | — | deferred |
| M7 real dry-run + FP SLA | — | blocked on SSH access |

86/86 vitest specs green across 6 test files. Smoke run on 16 fixtures
produces zero invariant violations.

## Pilot-fixes (2026-04-25, commit `0e0a4b3`)

After the first developer-run on real T-Bank repos, five blockers
surfaced. Each is now fixed and regression-tested:

1. **`parse-failed` storm on `.ts` files.** Parser ran with `jsx: true`
   for every file; pure `.ts` sources misread generics like `<T>` as JSX.
   Now `jsx` is enabled only for `.tsx`/`.jsx` extensions across
   `parse.ts`, `prescan/beaver.ts`, `prescan/local-lib.ts`. Fixture
   `fixture-ts-generics/` regresses generic-arrow-cast, generic
   functions, type aliases.

2. **`route-resolution-warning` lacked file path.** `RouteEntry` now
   carries `configFilePath`/`configAbsPath`; `resolveRoutes` emits
   structured `RouteWarning` (`{filePath, routePath, code, message}`);
   `run.ts` populates `Warning.filePath`. Operator can navigate to the
   offending router config file directly.

3. **Member-expression JSX `<Form.Item/>` was always
   `unresolved-dynamic`.** `readJsxTagName` now returns `{full, base}`:
   import lookup goes via base (`Form`), full dotted form
   (`Form.Item`) becomes `componentName`. For local member expressions,
   the pending-profile lookup uses the last segment as `definingSymbol`.
   §5.5 honoured. Fixture `fixture-member-expression/` covers the
   canonical `Form.Item` pattern via a new fake `@beaver-ui/form` leaf.

4. **Route-element wrapper unwrap.** `<AbilityGuard><CreateProject/></AbilityGuard>`
   used to register the route with `pageComponentFile: null` because
   `AbilityGuard` wasn't in-repo. `page-extract.ts` now collects every
   JSX-identifier in the element tree (root, then descendants) and
   `resolvePage` tries them in order, preferring the first in-repo
   match. Fixture `fixture-route-wrapped-element/` binds
   `CreateProject` (inside `AbilityGuard`) to `/projects/new`.

5. **CLI ergonomics for the operator workflow.**
   - Bin gains second name `ds-scanner` alongside `beaver-scan`; both
     point at the same compiled entry, program name follows `argv[1]`.
   - New `analyze` command: alias for `run` with sensible defaults
     (`--config ds-scanner.config.ts`, `--output .ds-metrics/report`).
     Adds `-o, --output <dir>` to `run` for explicit overrides.
   - `tsx` moved from devDependencies to dependencies; loader.ts imports
     `tsx/esm/api` on demand and registers it the first time a `.ts` /
     `.mts` config is requested. Built CLI now reads TS configs without
     the operator preloading anything.
   - `scripts/clone-repos.mjs` — idempotent batch cloner that walks
     `repositories.json`, clones each entry into `./ds-projects/<name>/`,
     surfaces `ssh-add ~/.ssh/id_ed25519` hint on failure. Wired as
     `npm run clone:repos`.

## Deviation from PRD §9.2 — per-repo config is optional

PRD §9.2 required a `.beaver-scan.json` at every consumer repo root
(fail-fast on missing). Pilot-operator feedback: coordinating 100 teams
to add a config file is not feasible for a single-person launch. Status
after commit hereafter:

1. **Consumer's `.beaver-scan.json`** (at repo root) — opt-in. Wins
   when present. Malformed still fails fast.
2. **Inline `config` in operator-side `repositories.json`** — new field
   on each entry; the operator captures per-repo overrides centrally.
3. **Built-in defaults** — every field of `PerRepoConfigSchema` has a
   Zod default; missing config is not an error.

Trade-off: repos with unspecified `localLibraries` classify all local
components as plain `local` (not `local-library`), which can skew the
adoption ratio downward for repos that have a team UI kit the operator
hasn't declared yet. Mitigated by progressively adding overrides to
`repositories.json` during the pilot FP-review pass.

## Принципы

- **Инкрементально по доменной ценности.** Каждая веха закрывает конкретную способность сканера, а не абстрактный «Stage N».
- **Честные заглушки.** Если стадия не готова — она явно помечена в коде и эмитит консервативные значения (например, всё `unsupported` для route), а не молча искажает метрику.
- **Фикстуры как контракт.** PRD §10.2 перечисляет 19 нужных фикстур. Каждая веха добавляет требуемые по списку + покрывает их тестами.
- **Детерминизм — инвариант, не фича.** Любая веха, ломающая байт-идентичность двух запусков, не вливается.
- **Pause-points.** После каждой M-вехи — smoke run на фикстурах + ручное подтверждение, что viewer показывает осмысленные данные. Это обратная связь до того, как вложиться в следующую.

## Текущее состояние (M0)

| Стадия PRD | Статус | Заметка |
|------------|--------|---------|
| 1 Discovery | ✅ full | fdir + picomatch, default excludes |
| 2 Parse | ✅ full | typescript-estree tolerant, warnings on fail |
| 3 Resolve | 🟡 stub | берёт `import source` как есть, нет tsconfig-paths |
| 4 Categorize | ✅ full | html-native / beaver / local-library / local / third-party |
| 5 Prescan-Join | 🔴 stub | `beaverPackages` из конфига, `beaverBackedByLib` из `kind` |
| 6 Classify — Этап A | ✅ full | структурная категория → bucket без перезаписей |
| 6 Classify — Этап B | 🟡 stub | primitive-name-only → shadow/possible |
| 7 Route-Resolve | 🔴 stub | все usages получают `{ kind: 'unsupported' }` |
| 8 Aggregate | 🟡 partial | A/B/C/D + 4 из 9 инвариантов; E пустая |
| HTML Viewer | 🟡 v0 | hero + B/C/D; E как placeholder |
| Dataset records | 🟡 partial | только `UsageRecord`, нет `ShadowComponentRecord` |
| Ops | 🔴 stub | нет git clone, нет worker pool, нет `update`/`clean` |

15/15 vitest specs green, determinism-тест проходит.

---

## M1 — Real resolve + Beaver prescan

**Goal.** Заменить две главные «лжи» MVP: захардкоженный `beaverPackages` и отсутствие TS module resolution. После M1 сканер сам обнаруживает Beaver-пакеты и канонизирует импорты через агрегатор.

**Scope (PRD §4.3 + §4.5 + §3.1 вариант 2).**

1. **Beaver prescan (`src/prescan/beaver.ts`).**
   - Клонирование Beaver: SSH, `--depth=1 --single-branch` в `.cache/beaver-ui/` (§8.1). Новый модуль `src/ops/git.ts` — обёртка над `child_process.spawn('git', ...)`. Fail-fast без retry (§8.3).
   - Version tracking через `git describe --tags --always`; результат идёт в `aggregates.meta.beaverVersion`.
   - Парсинг `packages/*` по наличию `package.json` → `beaverPackages: string[]`.
   - Парсинг `src/index.ts` каждого пакета → экспорты (ImportDeclaration + ExportSpecifier + ExportAllDeclaration).
   - Re-export map через `paths` из `tsconfig.base.json` агрегатора: рекурсивный обход depth=5, cycle detection (§4.5).
2. **TS module resolution (`src/resolve/ts-resolver.ts`).**
   - Обёртка над TypeScript compiler API (`ts.resolveModuleName` + `ts.parseConfigFileTextToJson`) — без `createProgram`, только resolver.
   - Кэш per-repo по `(importerPath, importSource)`.
   - Tsconfig-paths из `perRepo.tsconfig`; fallback на `tsconfig.json`.
3. **Categorize integration.**
   - `src/pipeline/categorize.ts` теперь получает `ImportMap` (результат resolve) и `BeaverRegistry` (prescan output) вместо сырого `import source`.
   - Канонизация: если `import { Button } from '@beaver-ui/components'` и агрегатор re-exports Button из `@beaver-ui/button` — в `UsageRecord` пишется `beaverPackage: '@beaver-ui/button'`, `canonicalizedVia: '@beaver-ui/components'`.
   - Убираем `beaverPackages` из `GlobalConfigSchema` (был MVP-only).
4. **Schema.**
   - `GlobalConfig.beaverUrl` уже есть — используется.
   - Удалить MVP-поле `RepositoryEntry.localPath`? **Нет**, оставить — нужно для CI/тестов без git-доступа.

**Fixtures (добавить).**
- `fixture-aggregator-package/` — один файл импортирует `Button` из `@beaver-ui/components`; prescan находит re-export → канонизация в `@beaver-ui/button`.
- `fixture-tsconfig-paths/` — `@/components/Button` резолвится через `paths: { "@/*": ["./src/*"] }`.
- Fake Beaver-монорепо под `tests/fixtures/beaver-ui/` (минимальный Nx-layout) + `BEAVER_LOCAL_PATH` env для тестов — чтобы обойти git clone в CI.

**Tests.**
- Parsing всех форм экспорта из `src/index.ts` (named, default, namespace, export-all).
- Re-export map depth=5 работает; depth=6 обрывается с warning.
- Cycle detection: package A re-exports B, B re-exports A → prescan не падает.
- `ts-resolver` резолвит `./foo` в абсолютный `src/foo.tsx`.
- Категоризация: импорт через агрегатор даёт `beaverPackage` исходного пакета + `canonicalizedVia`.

**Exit criteria.**
- `beaver-scan run` проходит end-to-end с prescan против fake-Beaver из фикстур.
- Реальный `git clone` не обязателен в тестах (используем local fake через env).
- Все 15 старых тестов + 10+ новых green.
- Aggregates `meta.beaverVersion` — непустая строка (тег или SHA).
- Code-diff: `GlobalConfigSchema.beaverPackages` удалён, примеры и docs обновлены.

**Risks.**
- TS compiler API тяжёлый (~10МБ, ~50мс на repo для init). Измерить; если критично — переход на `enhanced-resolve` (webpack resolver) как fallback.
- `git describe` на репо без тегов → SHA, это ок, но тесты должны покрыть оба случая.

**Effort:** M (2–3 дня).

---

## M2 — Full Stage 6 Этап B + ShadowComponentRecord

**Goal.** Настоящая shadow-детекция вместо primitive-name-only хьюристики. Трёхуровневая классификация (confirmed/likely/possible), полный набор сигналов §5.1. Эмиссия `ShadowComponentRecord` для AI-слоя.

**Scope (PRD §5.1–5.3 + §6.1).**

1. **Component profiling (`src/pipeline/profile.ts`).**
   - После Stage 4 для каждого локального компонента (key = `resolvedPath + exportedSymbol`) собирается агрегированный профиль:
     - все usage'и этого компонента (для `reusable-local`);
     - AST самого компонента (для `substantial-markup`, `usesStyled`, `htmlTags`, `propNames`, `localImports`, `beaverImports`);
     - исходный код (для `codeSnippet`, труnc до `thresholds.codeSnippetMaxLines`).
2. **Shadow signals (`src/classify/signals.ts`).**
   - `wraps-with-customization`: local импортирует Beaver + передаёт `className`/`style` ИЛИ применяет `styled(BeaverX)`/`emotion.styled`.
   - `standalone-styled`: `styled.button` / `@emotion/styled` без Beaver-импорта.
   - `primitive-like-name`: matches whitelist из §5.2.
   - `substantial-markup`: `jsxElementCount >= thresholds.substantialMarkupElements` (default 5).
   - `reusable-local`: `filesUsedIn >= thresholds.reusableLocalFiles` (default 2).
   - `parallel-layer`: лежит в `ui/`, `components/ui/`, `shared/ui/`, `kit/`.
   - `multi-route` — отложено до M4 (требует Stage 7).
3. **Level resolution (§3.5).**
   - `confirmed`: нет Beaver-импортов + primitive-like-name + substantial-markup.
   - `likely`: нет Beaver-импортов + (reusable-local OR multi-route), не confirmed.
   - `possible`: иначе, если хотя бы один сигнал сработал.
4. **Neither heuristics (§5.3).**
   - `*Provider`/`*Context`/`*Gate`, `use*`, `*Query`/`*Mutation`/`*Fetcher`/`*Loader`/`*Data`, `*Layout`/`*Page`/`*Template`/`*Shell`/`*Scaffold`, `*Container`/`*Wrapper` — применяются **до** shadow signals.
5. **Adoption-wrapper rules (§3.6).**
   - Если локальный компонент импортирует Beaver и не передаёт className/style/styled → `adoption` / `beaver-composition` или `adoption` / `wraps-with-customization → shadow` (пуристский подход).
   - Substantial-markup < 5 вокруг Beaver без класса → adoption-wrapper; >= 5 → shadow.
6. **Dataset upgrade.**
   - Эмиссия `ShadowComponentRecord` per shadow-компонент (§6.1, schema 1.1): signature, pathHint, codeSnippet, пустые слоты для AI.
   - `UsageRecord.shadowLevel` теперь реально отражает level, а не всегда `possible`.
7. **Aggregates upgrade.**
   - `ShadowByComponent.groupKey` = hash по `componentName + sorted(propNames) + jsxElementCount_bucket` (§7.3 MVP).
   - `ShadowByComponent.signals` заполнены из профиля.

**Fixtures (добавить).**
- `fixture-wrapper-adoption/` — композиция Beaver без кастомизации → adoption-wrapper.
- `fixture-wrapper-customized/` — `<BeaverButton className="red">` → shadow/possible.
- `fixture-styled-beaver/` — `styled(Button)` → shadow.
- `fixture-shadow-primitive/` — уже есть, апдейтим под confirmed level (добавить substantial markup).
- `fixture-layout-wrapper/` — `<div className="flex">{children}</div>` → adoption-wrapper (markup < 5).

**Tests.**
- Каждый сигнал покрыт ≥ 1 фикстурой (§10.2).
- Level resolution: confirmed требует ВСЕХ трёх условий.
- Neither-эвристика срабатывает **до** shadow (примтит-имя `DataLoader` не triggers shadow).
- `ShadowComponentRecord.codeSnippet` truncated корректно при превышении 200 строк.

**Exit criteria.**
- Метрика C показывает компоненты на трёх уровнях (не только possible).
- Viewer корректно рендерит level badges (уже готово в M0 CSS).
- `signals[]` в `ShadowByFile`/`ShadowByComponent` непустой.
- Инвариант #3 (shadowLevel consistency) проходит.

**Risks.**
- `styled(BeaverX)` паттерн требует отследить identifier chain (BeaverX импортирован как? переименован?). Решается через ImportMap из M1.
- Cross-file aggregation для `reusable-local` требует двухпроходного обхода: сначала все usage'и, потом классификация. Уже заложено — Stage 6 Этап B получает профили.

**Effort:** L (4–5 дней). Самая мозгоёмкая веха.

---

## M3 — Local-lib prescan + dynamic usage

**Goal.** Закрыть Stage 5 до конца (local-lib prescan реальный, не из `kind`) + честный резолв `React.createElement` и branch enumeration.

**Scope.**

1. **Local-lib prescan (`src/prescan/local-lib.ts`, PRD §4.5).**
   - Источник `local-path` only (§9.2). Git/npm — vNext, в конфиге Zod падает для других типов.
   - Парсит AST файлов `source.path` директории.
   - Проверка: хоть один Beaver-импорт внутри компонента → `beaverBackedBy: true`.
   - Барреrel re-exports с cycle detection + depth=5.
   - Output: `Map<libId, { componentName → beaverBacked: boolean }>`.
2. **Categorize uses registry.**
   - Если local-library компонент имеет `beaverBacked=true` → adoption/beaver-backed-wrapper.
   - Если `false` → fully-custom lib, идёт в Этап B классификации (как обычный local).
   - Флаг `kind` в per-repo конфиге становится fallback — actual determination из prescan.
3. **Dynamic usage resolution (§5.4).**
   - Branch enumeration для `const C = cond ? A : B; <C/>` — обе ветки эмитятся с `resolution: 'dynamic-branch'`.
   - Local aliasing `const C = Button; <C/>`.
   - `React.createElement(Button, ...)` → usage `Button`.
   - Unresolved → `UnresolvedRecord` с reason из enum PRD §6.1.
   - Warning при `unresolvedRate > thresholds.unresolvedDynamicWarningPct` (5% default).
4. **Member expressions (§5.5).**
   - `<Subheader.Actions/>`: если `Subheader` из Beaver + prescan нашёл member → канонизация. Иначе → `unresolved-dynamic / member-expression-not-supported`.

**Fixtures.**
- `fixture-local-lib-backed/` — partially-beaver-backed местная либа; prescan находит Beaver-импорт → adoption.
- `fixture-local-lib-custom/` — fully-custom; классификация как local.
- `fixture-dynamic-resolvable/` — branch enumeration, 2 usage'а в датасете.
- `fixture-dynamic-unresolvable/` — `components[variant]` → UnresolvedRecord.

**Tests.**
- Local-lib prescan различает backed vs custom компоненты в одной либе.
- Nested ternary → `unresolved-dynamic / nested-ternary` (НЕ раскрывается).
- `if/else` с return разных компонентов → `unresolved-dynamic / if-else-branch`.
- Warning emitted когда unresolved > threshold.

**Exit criteria.**
- Invariant #5 (dataset completeness) проверяется: сумма usage'ей = sum(instances) в coverage + sum(usageCount) в shadow.
- `warnings.json` имеет стабильный формат.

**Effort:** M (2–3 дня).

---

## M4 — Route resolver (Stage 7)

**Goal.** Имплементация §4.7 полностью. React Router v6, import-graph, attachement `route` к каждому usage.

**Scope.**

1. **Route config discovery (`src/route/discovery.ts`, §4.7.1).**
   - Auto-detect: паттерны `createBrowserRouter` / `createHashRouter` / `createMemoryRouter` / `RouteObject[]` / AST-shape `[{ path, element|lazy|children }]`.
   - Opt-out через `routeResolution.entryPoints` (глобы) в конфиге.
2. **Page component extraction (`src/route/page-extract.ts`, §4.7.2).**
   - Таблица из 8 форм routeentry (см. PRD).
   - Рекурсивный обход `children`, конкатенация path.
   - Variable following для `[...base, ...feature]` depth=10.
   - Conditional `element: flag ? <A/> : <B/>` → branch enumeration.
   - Dynamic path → skip + warning. Dynamic element → route registered, `pageComponent: null`.
3. **Nested `<Routes>` collapse (§4.7.3).**
   - AST-обход lazy-loaded feature-модулей, поиск `<Routes>` + `<Route>` элементов.
   - Все page-компоненты внутри коллапсируются к родительскому роуту (MVP-упрощение).
4. **Import graph (`src/route/import-graph.ts`, §4.7.4).**
   - Per-repo граф `file → files`. Статические импорты + динамические `import()` для lazy.
   - TS path aliases резолвятся через M1 ts-resolver.
   - DAG-свойство через visited set.
   - `reachableSet(pageComponent)` — BFS.
   - Для каждого файла `F`: `reachingRoutes(F) = { r.path | F ∈ reachable(r.pageComponent) }`.
   - Route binding: `∅ → unmapped`; `1 → bound`; `>1 → shared`.
5. **Integration.**
   - `runScan` вызывает Stage 7 перед агрегацией; `UsageRecord.route` заполняется реально (вместо `{ kind: 'unsupported' }`).
   - Unsupported repo (без роутера) → все usage'и получают `{ kind: 'unsupported' }` — явно.
6. **Edge cases (§4.7.5).**
   - Циклические импорты: visited-set защита.
   - Page-компонент не резолвится: route зарегистрирован, не участвует в binding, usage'и → unmapped + warning.

**Fixtures.**
- `fixture-route-data-router/` — `createBrowserRouter` с RouteObject-конфигом.
- `fixture-route-lazy-loading/` — lazy feature, две страницы.
- `fixture-route-nested-routes/` — `<Routes>` внутри фичи, коллапс.
- `fixture-route-shared-component/` — `<Header>` на 2+ роутах → shared.
- `fixture-route-unmapped/` — провайдеры/utils недостижимы.
- `fixture-route-conditional-element/` — branch enumeration на роутах.
- `fixture-route-dynamic-path/` — `getPath(...)` → skip + warning.
- `fixture-route-spread-routes/` — `[...base, ...feature]` variable following.

**Tests.**
- Все 8 фикстур из §10.2 покрыты.
- Invariant #8: метрика E считается только по `route.kind === 'bound'`.
- Cycle detection работает на граф 3+ файлов.

**Exit criteria.**
- Route resolver опционален per-repo (конфигом disable-able).
- Все существующие фикстуры (без route configs) продолжают работать → получают `unsupported` — smoke test проверяет.

**Effort:** L (5–7 дней). Самый большой блок после M2.

---

## M5 — Метрика E + viewer v1 + shared-components

**Goal.** Полная метрика E (per-route adoption), секция sharedComponents, UX-полировка viewer'а.

**Scope.**

1. **Метрика E (`src/pipeline/aggregate.ts`, §7.5).**
   - Для каждой пары `(repoId, routePath)`: `adoption / (adoption + shadow)` только по `route.kind === 'bound'`.
   - `sharedComponentsAdoption`: файлы с `route.kind === 'shared'` + их bucket.
   - `multi-route` сигнал из M2 активируется сейчас (требовал Stage 7) — reclassify shadow components с этим сигналом.
2. **Viewer v1 (`src/viewer/render.ts`).**
   - Секция E: таблица `(repo, route, adoption%, adoption, shadow)`.
   - Под-секция "shared components": топ по количеству роутов.
   - Drill-down по клику на shadow-компонент в C → модалка со списком implementations.
   - Filters: по уровню (confirmed/likely/possible), по репо.
   - Sort-by-column в таблицах (без фреймворков — vanilla JS).
3. **CLI enhancement.**
   - `beaver-scan update` — `git pull` для всех репо в `.cache/repos/` и `.cache/beaver-ui/`.
   - `beaver-scan clean` — удалить `.cache/`.

**Fixtures.**
- Апдейт `fixture-route-shared-component/` под проверку метрики E и sharedComponents.

**Tests.**
- E=NaN когда в роуте нет bound-usage'ей (документируется как 0, не NaN).
- Shared-компонент не попадает в знаменатель E ни одного роута.

**Exit criteria.**
- Viewer показывает все секции PRD §6.3.
- Дефолтный view секции C — per-component, переключатель на per-file работает.

**Effort:** M (2–3 дня).

---

## M6a — Invariants + git clone (shipped)

Closed in commit `957b5a0`. Invariants #1/#2 added (#3-#5, #7 already in
place from M2/M3); `WarningSchema` + `WARNING_CODES` typed in `src/config/
schema.ts`, codes documented in [`docs/warnings.md`](../docs/warnings.md).
Consumer repos clone into `.cache/repos/<repoId>` on first run; barrel
re-exports (`export { X } from './X'`) are aliased at profile build time
so pending usages resolve correctly. `run --no-fail-on-invariant`,
`beaver-scan update`, and `beaver-scan clean` wired in.

## M6b — Worker pool (deferred)

**Goal.** Готовность к регулярному запуску. Worker pool, полный invariants check, стабильные warnings.

**Scope.**

1. **Worker pool (`src/ops/pool.ts`, §8.2).**
   - `child_process.fork()` на `max(1, cpus-1)` воркеров.
   - Воркер получает batch путей, парсит и категоризирует (Stages 2–4), отдаёт records.
   - Master собирает + пост-обработка (Stages 5, 6, 7, 8 остаются single-process).
   - JSONL пишется streaming'ом по мере прихода результатов.
2. **Все 9 инвариантов (§10.1).**
   - Сейчас реализованы: #3, #4, #6, #7.
   - Добавить: #1 (mutual exclusivity), #2 (no orphan classification), #5 (dataset completeness), #8 (per-route denominator), #9 (determinism hash опционально через флаг).
   - Флаг `--no-fail-on-invariant` для отключения exit=3.
3. **Warnings schema.**
   - `warnings.json` типизирован через Zod (пересечение с `WarningSchema`).
   - Коды warning перечислены в документации (отдельный `docs/warnings.md`).
4. **Git ops (`src/ops/git.ts`).**
   - Полная реализация §8.1: SSH клонирование из `repositories.json` в `.cache/repos/<name>/`.
   - `--depth=1 --single-branch`, fail-fast без retry.
   - Cache hit: репо существует → `git pull` опционально (через `update` команду).
5. **Performance baseline.**
   - Бенчмарк на synthetic-репо из 100 файлов × 3 реплики → выдерживает SLA §8.2 (10k файлов за 30мин extrapolate).

**Tests.**
- Worker pool: N воркеров параллельно → dataset ident. однопоточному (детерминизм).
- Git clone: fail на несуществующем URL → exit=3, stderr git как есть.
- Все 9 инвариантов срабатывают на подложенных «плохих» записях.

**Exit criteria.**
- `npm test` проходит full run под 30 секунд на 20 фикстурах.
- `beaver-scan run --config ... --parallel=4` ускоряет scan в ≥2 раза на крупной фикстуре.

**Risks.**
- `child_process.fork()` на Windows: IPC через pipes ок, но полные пути (C:\…) в JSONL должны оставаться POSIX-normalized (уже делаем).
- Serialization overhead: минимизируется передачей только путей, AST строится внутри воркера (§8.2).

**Effort:** M (3–4 дня).

---

## M7 — Real dry-run + false-positive SLA (blocked)

**Goal.** Первый scan против реальных T-Bank репо. Измерение метрики false-positive (§10.3), тюнинг whitelist/thresholds. Продуктовое подтверждение MVP.

**Блокер:** доступ к T-Bank GitLab SSH + Beaver-репо. У Claude-code доступа нет — эту веху исполняет Stanislav на своей машине по [operator-runbook.md](../docs/operator-runbook.md). Этапы и критерии остаются как ниже.

**Scope.**

1. **Dry-run staging.**
   - Подготовить `repositories.json` с 5–10 реальных репо (pilot batch, не все 100).
   - Запуск `beaver-scan run` на pilot-батче.
2. **Manual review.**
   - Выборка 50 случайных shadow-компонентов из датасета.
   - Stanislav + команда проходят чеклистом: «действительно shadow?» / «не shadow».
   - Фиксация FP-rate.
3. **Tuning.**
   - Если FP > 15% (§1.5): тюнинг `primitiveNames` whitelist, `thresholds.substantialMarkupElements`, добавление per-repo exclusions.
   - Документирование «золотых примеров» для будущей регрессии.
4. **Full scan.**
   - Запуск на всех 100 репо.
   - Верификация PRD §1.5 Success Criteria: детерминизм, HTML rendering, full pipeline completes.
5. **Linear / retrospective.**
   - Фиксация open questions §11, которые после реального scan требуют решения (особенно #1 OKR-метрика).

**Deliverables.**
- `docs/pilot-run-results.md` — результаты FP-rate, настроенные thresholds.
- `docs/operator-runbook.md` — как ты (или команда) запускаете cron в будущем.
- Tag `v1.0.0` на ветке после full-scan pass.

**Exit criteria.**
- FP-rate на pilot ≤ 15%.
- Full scan на 100 репо отрабатывает в рамках SLA (§8.2: <30 мин на runner).
- Viewer рендерится с реальными данными, информативен для roadmap-решений.

**Блокеры.**
- Доступ к T-Bank GitLab SSH.
- Доступ к реальному Beaver-репо (SSH URL в конфиге).
- Одна неделя calendar-time на ручной review 50 компонентов.

**Effort:** M (3–5 дней активной работы + ожидание review).

---

## Cross-cutting: что НЕ делаем до v2

Явно вне scope MVP (PRD §12 + §11):

- Props registry через TS compiler API — вынесено в v2.
- Embedding-based shadow similarity для C.1 — вынесено в v2.
- AI mapping `shadow → Beaver-candidate` — отдельная стадия, не часть сканера.
- Next.js App Router / Pages Router — v2.
- Incremental scan — v2.
- GitLab auto-discovery — Phase 2 operational, не MVP.
- Runtime CI integration (PR checks) — Phase 2.
- Multi-DS (кроме Beaver) — out of MVP.
- Runner deployment — MVP остаётся локальным.

Данные сохраняются под будущее: `ShadowComponentRecord.embedding`, `ShadowComponentRecord.codeSnippet`, `beaverCandidateMapping` — слоты в датасете готовы с M2.

---

## Итоговая последовательность

| Веха | Главная способность | Зависит от | Усилие |
|------|---------------------|-----------|--------|
| M0 | Скелет + viewer | — | done |
| M1 | Реальный resolve + Beaver prescan | M0 | M (2–3д) |
| M2 | Полный Stage 6 + ShadowComponentRecord | M1 | L (4–5д) |
| M3 | Local-lib prescan + dynamic usage | M1 (resolve), M2 (profile) | M (2–3д) |
| M4 | Route resolver | M1 (resolve) | L (5–7д) |
| M5 | Метрика E + viewer v1 | M2, M4 | M (2–3д) |
| M6 | Worker pool + ops hardening | M1–M5 | M (3–4д) |
| M7 | Real dry-run + FP SLA | M6 + реальные репо | M (3–5д + calendar) |

**Чистое время работы:** ~22–30 активных дней.
**Calendar до v1.0:** 5–7 недель при 4–5 часах/день (реалистично для solo + AI).

Параллелизация возможна M3 + M4 (делятся общим resolver из M1, но не пересекаются по файлам). M5 зависит от обоих.

---

## Чекпойнты ручной проверки

После каждой M (кроме M6, где ручная проверка — сам бенчмарк):

1. `npm test` green.
2. `beaver-scan run --config ./example/.beaver-scan.config.ts` отрабатывает без ошибок.
3. Открываем `example/results/report.html` в браузере → метрики выглядят осмысленно против известных ответов по фикстурам.
4. Фиксируем в `implementation/milestone-log.md`: что сделано, что задеплоено, что отложено.

Этот тройной чек ловит 90% регрессий до того, как они закопаются в датасет.
