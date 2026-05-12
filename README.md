# Beaver Adoption Scanner (DSCAN)

CLI-тулза для измерения adoption design system Beaver по T-Bank консьюмер-репо.

Спека: [ds-adoption-scanner-prd-v2.md](./ds-adoption-scanner-prd-v2.md). Подробный план/история — [implementation/plan.md](./implementation/plan.md). Гайд оператора — [docs/operator-runbook.md](./docs/operator-runbook.md).

## Статус

**MVP: M1–M6a + pilot-fixes.** Полный pipeline + Stage 7 route resolver + invariants + 5 багфиксов из первого реального прогона.

| Stage | Статус |
|-------|--------|
| 1. Discovery | ✅ (mocks/fixtures excluded by default) |
| 2. Parse | ✅ (`jsx` по расширению — `.ts` не ломаются на generics) |
| 3. Resolve | ✅ (TS compiler API, tsconfig paths) |
| 4. Categorize | ✅ |
| 5a. Beaver prescan | ✅ (git clone + re-export map depth=5) |
| 5b. Local-lib prescan | ✅ |
| 6. Classify Этап A | ✅ |
| 6. Classify Этап B | ✅ (6 сигналов + 3 уровня + adoption-wrapper rules) |
| 6.5. Member expressions `<NS.Comp/>` | ✅ |
| 7. Route-Resolve | ✅ (React Router v6 data-router + wrapper-unwrap) |
| 8. Aggregate | метрики A/B/C/D/E + 7 из 9 инвариантов |
| HTML Viewer | hero + B/C/D/E + shared components |

86/86 vitest specs · 16 фикстур · 0 warnings/invariant violations на smoke-прогоне.

## Установка

```bash
git clone git@github.com:Meddelin/dscan.git
cd dscan
npm install
npm run typecheck    # sanity check
npm test             # 86 specs
```

## Локальный прогон на встроенных фикстурах

`BEAVER_LOCAL_PATH` обходит git clone Beaver-репо и подсовывает фейковую структуру из `tests/fixtures/beaver-ui/`:

```bash
BEAVER_LOCAL_PATH=./tests/fixtures/beaver-ui \
  npm run dev -- run --config ./example/.beaver-scan.config.ts
```

Артефакты — в `./example/results/`:
- `dataset.jsonl` — instance-level записи (одна = одно JSX-использование)
- `aggregates.json` — derived-метрики A/B/C/D/E + invariants
- `report.html` — self-contained viewer (открыть в любом браузере, без бэкенда)
- `warnings.json` — диагностика (parse/prescan/route)

`npm run dev` запускает CLI через `tsx` — `.ts`-конфиги грузятся «на лету», сборка не нужна.

## Реальный прогон на T-Bank репо

```bash
# 1. SSH-ключ должен быть в агенте — иначе клонирование упадёт.
ssh-add ~/.ssh/id_ed25519

# 2. Клонировать все репо из repositories.json в ./ds-projects/<name>/
node scripts/clone-repos.mjs                     # idempotent — пропускает уже склонированное

# 3. Сборка + analyze
npm run build
npx ds-scanner analyze --output .ds-metrics/report
```

`analyze` — operator-friendly алиас `run` с дефолтами `--config ds-scanner.config.ts` и `--output .ds-metrics/report`.

Скомпилированный CLI **сам читает `.ts`-конфиги** — `tsx/esm/api` регистрируется по запросу при первом `.ts`-файле. Преподготавливать ничего не нужно.

## CLI

Бинарник доступен под двумя именами: `ds-scanner` и `beaver-scan`. Один и тот же исполняемый файл; имя в выводе зависит от того, как его вызвали.

```bash
# Сканирование
ds-scanner analyze [--config <path>] [--output <dir>]      # operator-friendly defaults
ds-scanner run --config <path> [--output <dir>] [--no-fail-on-invariant]

# Постобработка
ds-scanner aggregate --dataset <path> --out <dir>          # пересчёт из существующего dataset.jsonl
ds-scanner viewer --aggregates <path> --out <path>         # HTML из существующих агрегатов

# Кэш
ds-scanner update --config <path>                          # git pull всех кэшированных репо
ds-scanner clean --config <path>                           # удалить .cache/
```

Exit-коды: `0` — норм; `2` — невалидный конфиг (Zod); `3` — нарушены инварианты (§10.1) — отключается флагом `--no-fail-on-invariant`; `1` — прочая фатальная ошибка.

## Per-repo config

Консьюмер-репо **не обязаны** добавлять `.beaver-scan.json` — работают built-in defaults (PRD §9.2 разворот, [implementation/plan.md](./implementation/plan.md#deviation-from-prd-92)).

Приоритет:

1. **`.beaver-scan.json` у консьюмера** (если положили сами) — побеждает.
2. **Inline-поле `config`** на записи репо в `repositories.json` (оператор):
   ```json
   {
     "name": "consumer-app-1",
     "gitUrl": "ssh://git@gitlab.tbank.ru:7999/consumer/app-1.git",
     "config": {
       "exclude": ["src/legacy/**"],
       "localLibraries": [
         { "libId": "team-kit", "matchPattern": "src/shared/ui-kit/**",
           "source": { "type": "local-path", "path": "src/shared/ui-kit" },
           "kind": "partially-beaver-backed" }
       ]
     }
   }
   ```
3. **Built-in defaults** (Zod-схема — `include: src/**/*.{ts,tsx,js,jsx}`, дефолтные excludes, route resolution on, пустой `localLibraries`).

Малформенный конфиг (битый JSON / Zod failure) по-прежнему падает fail-fast (exit 2). Просто отсутствующий — это норма.

## Ожидаемая структура каталога оператора

```
<workspace>/
├── ds-scanner.config.ts         # global config (или .beaver-scan.config.ts)
├── repositories.json            # список консьюмер-репо (+ inline overrides)
├── ds-projects/                 # ← сюда clone-repos.mjs кладёт клоны
│   ├── consumer-app-1/
│   └── ...
├── .cache/                      # Beaver clone + auto-cache
│   └── beaver-ui/
└── .ds-metrics/report/          # ← analyze --output
    ├── dataset.jsonl
    ├── aggregates.json
    ├── report.html
    └── warnings.json
```

## Архитектура

- `src/config/` — Zod-схемы для global + per-repo конфигов; loader с tsx-on-demand
- `src/ops/` — git wrapper (`clone --depth=1 --single-branch`, fail-fast)
- `src/prescan/` — Stage 5a (Beaver) + 5b (local-lib)
- `src/resolve/` — TS module resolver (Node10 mode по дефолту, tsconfig paths)
- `src/pipeline/` — стадии 1–8: discovery, parse, collect (Pass A), profile, classify-pass (Pass B), aggregate, run-orchestrator
- `src/classify/` — Stage 6 Этап B: signals, levels, neither-heuristics, classify-b orchestrator
- `src/route/` — Stage 7: discovery, page-extract (с wrapper unwrap), import-graph, resolve
- `src/types/` — типы датасета (schemaVersion 1.1)
- `src/writer/` — JSONL streaming writer + sortRecords для детерминизма
- `src/viewer/` — self-contained HTML-рендерер
- `scripts/clone-repos.mjs` — batch clone helper по `repositories.json`
- `tests/fixtures/` — 16 синтетических репо, покрывающих PRD §10.2

## Документация

- [docs/operator-runbook.md](./docs/operator-runbook.md) — полный гайд оператора (prerequisites, FP-review, troubleshooting)
- [docs/warnings.md](./docs/warnings.md) — каталог warning-кодов и их источников
- [implementation/plan.md](./implementation/plan.md) — план M0→M7, deviations, current state
