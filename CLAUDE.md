# DSCAN — инструкции для Claude Code

Этот файл — контракт для агентов (включая будущие сессии Claude Code), работающих с этим репозиторием. Каноничный план — [implementation/plan.md](implementation/plan.md), PRD — [ds-adoption-scanner-prd-v2.md](ds-adoption-scanner-prd-v2.md), руководство для оператора — [docs/руководство.md](docs/руководство.md).

## Контекст проекта

**DSCAN** (он же Beaver Adoption Scanner, исторический бинарь `beaver-scan`) — CLI-тулза для T-Bank, которая ходит по ~100 React-репо и считает adoption их собственной design system'ы (Beaver) против локальных shadow-компонентов. Выдаёт детерминированный JSONL-датасет, agregat'ы по 5 метрикам (A/B/C/D/E) и self-contained HTML-отчёт.

Solo-проект Stanislav'а. Pilot-фаза — запуски раз в 1–2 недели локально.

## Hard constraints (не обсуждается)

- **Node 20.10+, TypeScript-only.** Никакого Python, никакого Go.
- **`@typescript-eslint/typescript-estree`** для парсинга. `jsx: true` **только** для `.tsx`/`.jsx` — пур-`.ts` файлы парсятся без JSX (см. `src/pipeline/parse.ts`).
- **Zod** для всех валидаций конфига. Малформенный конфиг = exit 2, fail-fast.
- **Детерминизм — инвариант.** Два запуска на одном и том же SHA Beaver-репо + одном и том же SHA консьюмер-репо дают **байт-идентичный** `dataset.jsonl`. Любая фича, которая ломает это, не вливается. Тест в `tests/pipeline.test.ts` (`describe 'determinism (§8.4)'`).
- **Schema 1.1.** Все записи в `dataset.jsonl` несут `schemaVersion: '1.1'`. Минорные добавления (новые optional поля, новые warning-коды) — без bump. Breaking changes (rename, retype, удаление) — bump до 2.0 + согласование с BI.
- **Один файл = один HTML.** `report.html` self-contained: inline CSS + JS, данные через `const DATA = ...` (без fetch, без backend, без CDN).
- **Pipeline-стадии** соответствуют PRD §4 (Discovery → Parse → Resolve → Categorize → Prescan-Join → Classify → Route-Resolve → Aggregate). Не объединять, не переставлять. Имена модулей в `src/pipeline/` соответствуют стадиям.
- **TS-конфиги** грузятся через `tsx/esm/api` register on-demand — в собранном CLI тоже. Никаких сборок конфига отдельно от пользовательского кода.

## Что я НЕ делаю без явного разрешения

- Меняю PRD-решения (D1+ список зафиксирован в [implementation/plan.md](implementation/plan.md)). Если кажется, что спека неправа — флагаю в комментарии PR, не правлю код.
- Добавляю dependencies в `package.json` без обоснования, почему существующих не хватает.
- Удаляю существующие фикстуры (`tests/fixtures/*`). Editing — OK, delete — confirm first.
- Переписываю warning-коды (`WARNING_CODES` в `src/config/schema.ts`). Добавление — OK, переименование — breaking change для warnings.json consumers.
- Делаю `git commit` без явного запроса (см. рабочий процесс ниже).
- Пушу в `main` без `git push origin main` явно.

## Структура

```
DSCAN/
├── src/
│   ├── cli.ts                # bin entry (commander)
│   ├── index.ts              # library exports (defineConfig)
│   ├── config/
│   │   ├── schema.ts         # Zod: GlobalConfig, PerRepoConfig, RepositoryEntry, LocalLibrary
│   │   └── loader.ts         # tsx-on-demand register для .ts конфигов
│   ├── ops/
│   │   └── git.ts            # spawn-обёртка, fail-fast, --depth=1 --single-branch
│   ├── prescan/
│   │   ├── beaver.ts         # Stage 5a: clone + packages/* + re-export map depth=5
│   │   └── local-lib.ts      # Stage 5b: AST-скан local-path директорий
│   ├── resolve/
│   │   └── ts-resolver.ts    # ts.resolveModuleName, Node10 mode, tsconfig paths
│   ├── pipeline/
│   │   ├── discovery.ts      # Stage 1: fdir + picomatch
│   │   ├── parse.ts          # Stage 2: typescript-estree tolerant
│   │   ├── collect.ts        # Pass-A: structural categorize → finalized/pending
│   │   ├── profile.ts        # Component profile extraction (для Pass-B)
│   │   ├── classify-pass.ts  # Pass-B: shadow signals → bucket+level
│   │   ├── aggregate.ts      # Stage 8: A/B/C/D/E + 7 инвариантов
│   │   └── run.ts            # orchestrator
│   ├── classify/
│   │   ├── signals.ts        # 6 shadow signals (PF2 series)
│   │   ├── levels.ts         # confirmed/likely/possible resolution
│   │   ├── neither.ts        # §5.3 эвристики, применяются ПЕРЕД signals
│   │   └── classify-b.ts     # Stage 6 Этап B orchestrator
│   ├── route/
│   │   ├── discovery.ts      # detect createBrowserRouter / RouteObject[]
│   │   ├── page-extract.ts   # routes + JSX BFS depth=5 + member expressions
│   │   ├── constant-eval.ts  # path-const evaluation (PF2.4)
│   │   ├── member-chaser.ts  # barrel chain depth=3 (PF2.6)
│   │   ├── import-graph.ts   # static + dynamic imports + export-from edges
│   │   └── resolve.ts        # orchestrator
│   ├── types/
│   │   ├── dataset.ts        # UsageRecord, ShadowComponentRecord, Aggregates
│   │   └── prescan.ts        # BeaverRegistry, LocalLibRegistry
│   ├── writer/
│   │   └── jsonl.ts          # streaming + stable sort (детерминизм)
│   └── viewer/
│       └── render.ts         # self-contained HTML
├── scripts/
│   └── clone-repos.mjs       # batch clone по repositories.json
├── tests/
│   ├── fixtures/             # 22 consumer fixtures + beaver-ui + shared-kits
│   ├── pipeline.test.ts      # e2e специфы
│   ├── classify.test.ts      # unit: сигналы, уровни, neither
│   ├── route.test.ts         # unit: route resolver
│   ├── resolver.test.ts      # unit: ts-resolver
│   ├── prescan.test.ts       # unit: Beaver prescan
│   └── local-lib.test.ts     # unit: local-lib prescan
├── example/                  # smoke-run конфиг + repositories.json
├── docs/
│   ├── руководство.md        # практика: установка → запуск → метрики
│   ├── архитектура.md        # теория: pipeline, классификация
│   ├── предупреждения.md     # каталог warning-кодов
│   └── operator-runbook.md   # legacy English version (deprecated)
└── implementation/plan.md    # история вех + deviations
```

## Workflow

### Перед началом фичи

1. Прочти соответствующий milestone-блок в [implementation/plan.md](implementation/plan.md).
2. Если фича блокируется PRD-решением — флаг founder'у, не самовольничай.

### Запуск тестов

```bash
npm test              # 108 specs, ~2s
npm run typecheck     # tsc --noEmit, ~5s
```

Перед коммитом — оба должны быть green.

### Smoke-run на фикстурах

```bash
BEAVER_LOCAL_PATH=./tests/fixtures/beaver-ui \
  npm run dev -- run --config ./example/.beaver-scan.config.ts
```

Артефакты — в `example/results/`. Открыть `report.html` в браузере для визуальной проверки.

### Коммиты

- **Semantic prefix** + milestone slug: `feat(PF2.7-invariants): …`, `fix(M3-prescan): …`, `docs: …`, `test: …`.
- **Только когда явно попросили.** Не коммитить самовольно — в т.ч. при «всё, готово».
- **Co-author футер** — в каждом коммите добавлять:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- HEREDOC для multi-line сообщений — git CLI плохо переваривает многострочные `-m`.
- **NEVER** `--no-verify`, **NEVER** `--amend` существующий коммит. Если pre-commit hook упал — исправь и сделай новый коммит.

### Push

- Только `git push origin main` (или явная ветка).
- **NEVER** `--force` на main без явной просьбы.

## Тестовые конвенции

### Когда добавлять фикстуру

Любая новая стадия пайплайна / новый signal / новый warning-код = новая фикстура в `tests/fixtures/`. Имя — `fixture-<что-проверяем>/`.

### Что должно быть в фикстуре

- `.beaver-scan.json` с `include` (минимум) — иначе сканер скажет «defaults».
- `src/**/*.{ts,tsx}` файлы, имитирующие реальный паттерн.
- Если фикстура зависит от Beaver-пакета, который ещё не объявлен в `tests/fixtures/beaver-ui/packages/` — добавь сначала там.

### Когда добавлять spec

- Unit-тест в соответствующий `tests/<модуль>.test.ts` (resolver, classify, route, prescan, local-lib).
- E2E pipeline-тест в `tests/pipeline.test.ts` — обязательно. Проверяй конкретные usage records / aggregates fields.

### Что НЕ делать

- Не использовать live network. `BEAVER_LOCAL_PATH` обходит git clone Beaver-репо.
- Не оставлять `console.log` в коде. В крайних случаях — `if (process.env.DSCAN_DEBUG) { ... }`.
- Не делать flaky-тесты, зависящие от wall-clock или iteration order.

## Локальные пути и Windows

- Все пути в датасете нормализуются `.replace(/\\/g, '/')` для cross-platform консистентности. Не ломай это.
- `path.resolve` возвращает с `\` на Windows — нормализуй в forward-slash при сохранении в JSON.
- Lowercased keys в `profileKey` — это сознательно: Windows file system case-insensitive, ts-resolver может вернуть путь с другим casing.

## Pitfalls

### Парсер JSX

`@typescript-eslint/typescript-estree` с `jsx: true` на `.ts` файле ломается на generics типа `<T>(x: T) => x`. Решение: `jsx: extname === '.tsx' || '.jsx'` (см. `src/pipeline/parse.ts`). Если добавляешь новое место парсинга — НЕ забудь применить тот же check.

### Detection шадоу

Pass-B (`classify-pass.ts`) **дедуплицирует** ShadowComponentRecord по `(profile.absPath, profile.componentName)`, **не** по pending key. Это фиксит double-counting при barrel-aliased профилях. Если меняешь логику — гоняй регресс `fixture-invariant-completeness`.

### Default exports

`buildPending` в `collect.ts` ставит `definingSymbol = 'default'` для default-импорта, **не** local name. Профили в `profile.ts` для default-export тоже хранятся под именем `'default'`. Если меняешь имя default-профиля — сломаешь lookup.

### `export *`

`aliasBarrelProfiles` в `run.ts` использует **fixpoint loop** (depth=5) чтобы chained barrels (barrel1 → barrel2 → source) сошлись. Каждая итерация перестраивает `profilesByFile` из живого Map'а — не из `profile.absPath`. Это намеренно: добавленные на предыдущей итерации aliases должны участвовать в следующей.

### Route extractor — async chain

`extractRoutes` / `resolveRoutes` async из-за PF2.4 (file I/O для constant-eval). Если добавляешь новый caller — `await`. `run.ts` уже корректно `await resolveRoutes(...)`.

## Когда звать founder'а

- Любой блокер на SSH-доступе к T-Bank GitLab — он не у меня.
- Любое изменение PRD-решения (D1+).
- Производственный deploy / cron-настройка — Phase 2, не наш скоуп.
- Конфликт между PRD §1 и реальностью на pilot'е (например, FP-rate > 15% после двух итераций тюнинга).

## Текущая версия

- `package.json` version: `0.1.0` (M0 baseline)
- `schemaVersion` в датасете: `1.1`
- Beaver-target (для prescan): любой тег, выставлен оператором через `beaverUrl` в global config

Если делаешь breaking change в schema → bump до `2.0` И отдельный коммит `feat!: bump schemaVersion` И запись в `docs/предупреждения.md` («When to bump schemaVersion»).
