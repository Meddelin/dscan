# DSCAN — Beaver Adoption Scanner

CLI-тулза для T-Bank: сканирует ~100 React-репо и считает adoption design system'ы **Beaver** против локальных shadow-компонентов. Выдаёт детерминированный JSONL-датасет, derived-метрики A/B/C/D/E и self-contained HTML-отчёт.

## Документация

| Документ | Для кого | О чём |
|----------|----------|-------|
| [docs/руководство.md](./docs/руководство.md) | **Оператор** | Установка, запуск, конфиги, формулы метрик, чтение отчёта, troubleshooting |
| [docs/архитектура.md](./docs/архитектура.md) | Разработчик сканера | Pipeline, классификация, маршруты, расширения |
| [docs/предупреждения.md](./docs/предупреждения.md) | Оператор + BI | Каталог warning-кодов и инвариантов |
| [CLAUDE.md](./CLAUDE.md) | Агенты (Claude Code) | Конвенции репозитория |
| [implementation/plan.md](./implementation/plan.md) | История | M0 → PF2.7, deviations, статус вех |
| [ds-adoption-scanner-prd-v2.md](./ds-adoption-scanner-prd-v2.md) | Архивист | Каноничная PRD (~70KB) |

## Статус

**MVP: M0 → M6a + pilot-fixes + PF2 + PF3.** Полный pipeline + Stage 7 route resolver + invariants + два раунда багфиксов с боевых прогонов + локализация на русский + scalable HTML viewer.

108/108 vitest specs · 22 consumer-фикстуры + два helper'а (beaver-ui, shared-kits) · smoke-run: 21 repos / 64 files / 129 usages / 0 warnings / 0 invariant violations.

| Стадия | Статус |
|--------|--------|
| 1. Discovery | ✅ (mocks/fixtures excluded by default) |
| 2. Parse | ✅ (`jsx` по расширению — `.ts` не ломаются на generics) |
| 3. Resolve | ✅ (TS compiler API, tsconfig paths) |
| 4. Categorize | ✅ |
| 5a. Beaver prescan | ✅ (git clone + re-export map depth=5) |
| 5b. Local-lib prescan | ✅ (per-repo + global `sharedLibraries`) |
| 6. Classify Этап A | ✅ |
| 6. Classify Этап B | ✅ (6 сигналов + 3 уровня + adoption-wrapper rules) |
| 6.5. Member expressions `<NS.Comp/>` | ✅ |
| 7. Route-Resolve | ✅ (React Router v6 + wrapper-unwrap depth=5 + path-const eval + barrel chain depth=3) |
| 8. Aggregate | A/B/C/D/E + 7 из 9 инвариантов |
| HTML Viewer | hero → **E (по маршрутам)** → B → C → D + pagination + filter + sort |

## Быстрый старт

```bash
git clone git@github.com:Meddelin/dscan.git
cd dscan
npm install
npm run typecheck    # должен пройти без ошибок
npm test             # 108 specs
```

### Локальный прогон на встроенных фикстурах

`BEAVER_LOCAL_PATH` обходит git clone Beaver-репо и подсовывает фейк из `tests/fixtures/beaver-ui/`:

```bash
BEAVER_LOCAL_PATH=./tests/fixtures/beaver-ui \
  npm run dev -- run --config ./example/.beaver-scan.config.ts
```

Артефакты — в `./example/results/`. Открой `report.html` в браузере.

### Реальный прогон на T-Bank репо

```bash
# 1. SSH-ключ должен быть в агенте — иначе клон упадёт fail-fast.
ssh-add ~/.ssh/id_ed25519

# 2. Клонировать все репо из repositories.json в ./ds-projects/<name>/
node scripts/clone-repos.mjs       # идемпотентно: пропускает уже склонированное

# 3. Сборка + сканирование
npm run build
npx ds-scanner analyze --output .ds-metrics/report
```

`analyze` — operator-friendly alias `run` с дефолтами `--config ds-scanner.config.ts` и `--output .ds-metrics/report`.

Скомпилированный CLI **сам читает `.ts`-конфиги** — `tsx/esm/api` регистрируется по запросу при первом `.ts`-файле. Преподготавливать ничего не нужно.

**Полная инструкция:** [docs/руководство.md](./docs/руководство.md).

## CLI

Бинарь под двумя именами: `ds-scanner` и `beaver-scan` (один и тот же исполняемый файл).

```bash
# Сканирование
ds-scanner analyze [--config <path>] [--output <dir>]      # operator-friendly defaults
ds-scanner run --config <path> [--output <dir>] [--no-fail-on-invariant]

# Постобработка
ds-scanner aggregate --dataset <path> --out <dir>          # пересчёт из dataset.jsonl
ds-scanner viewer --aggregates <path> --out <path>         # HTML из существующих агрегатов

# Кэш
ds-scanner update --config <path>                          # git pull всех кэшированных репо
ds-scanner clean --config <path>                           # удалить .cache/
```

Exit-коды: `0` — норм; `2` — невалидный конфиг; `3` — нарушены инварианты (отключается `--no-fail-on-invariant`); `1` — прочая фатальная ошибка.

## Артефакты

После `analyze --output <dir>`:

```
<dir>/
├── dataset.jsonl       # instance-level: одна строка = одно JSX usage
├── aggregates.json     # derived-метрики A/B/C/D/E + инварианты + копия warnings
├── report.html         # self-contained HTML (один файл, без backend'а)
└── warnings.json       # диагностики per-warning
```

## Конфигурация — короткая версия

Полная — в [docs/руководство.md§5](./docs/руководство.md#5-конфигурация).

```ts
// ds-scanner.config.ts
import { defineConfig } from 'beaver-scan';

export default defineConfig({
  beaverUrl: 'ssh://git@gitlab.tbank.ru:7999/beaver-ui/beaver-ui.git',
  repositoriesFile: './repositories.json',
  output: { dir: './.ds-metrics/report', formats: ['jsonl', 'aggregates', 'html'] },

  // Cross-repo design kits — объяви один раз, работает для всех консьюмеров.
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

```json
// repositories.json
[
  { "name": "consumer-app-1", "gitUrl": "ssh://git@gitlab.tbank.ru:7999/consumer/app-1.git" },
  { "name": "consumer-app-2", "gitUrl": "ssh://git@gitlab.tbank.ru:7999/consumer/app-2.git" }
]
```

Консьюмер-репо **не обязаны** добавлять `.beaver-scan.json` — работают built-in defaults (PRD §9.2 разворот). Если нужны overrides:

1. **`.beaver-scan.json`** в корне консьюмер-репо (opt-in).
2. Или **inline `config`** на записи репо в `repositories.json` (operator-side).
3. **Built-in defaults**.

## Структура каталога оператора

```
<workspace>/
├── ds-scanner.config.ts
├── repositories.json
├── ds-projects/                # ← clone-repos.mjs кладёт клоны
├── .cache/                     # auto-cache (Beaver clone, etc.)
└── .ds-metrics/report/         # ← analyze --output
    ├── dataset.jsonl
    ├── aggregates.json
    ├── report.html
    └── warnings.json
```

## Архитектура (короткая версия)

Полная — в [docs/архитектура.md](./docs/архитектура.md).

- `src/config/` — Zod-схемы для global + per-repo конфигов; tsx-on-demand loader
- `src/ops/` — git wrapper (`clone --depth=1 --single-branch`, fail-fast)
- `src/prescan/` — Stage 5a (Beaver) + 5b (local-lib)
- `src/resolve/` — TS module resolver (Node10 mode, tsconfig paths)
- `src/pipeline/` — stages 1–8: discovery, parse, collect (Pass-A), profile, classify-pass (Pass-B), aggregate, run-orchestrator
- `src/classify/` — Stage 6 Этап B: signals, levels, neither-heuristics
- `src/route/` — Stage 7: discovery, page-extract, constant-eval, member-chaser, import-graph
- `src/types/` — типы датасета (schemaVersion 1.1)
- `src/writer/` — JSONL streaming writer + stable sort (детерминизм)
- `src/viewer/` — self-contained HTML с pagination/filter/sort
- `scripts/clone-repos.mjs` — batch clone helper по `repositories.json`
- `tests/fixtures/` — 22 consumer-фикстуры + helper'ы

## Где это работает

Стадии PRD §4 + локальные расширения (PF2 series):

```
[1] Discovery    → [2] Parse      → [3] Resolve   → [4] Categorize
                                                          ↓
[5a] Beaver prescan                                       ↓
[5b] Local-lib prescan  ─────────────────────────────────→[6] Classify
                                                          ↓
[7] Route-Resolve (опционально)                           ↓
                                                          ↓
[8] Aggregate → JSONL + HTML + JSON
```

## Лицензия

Internal T-Bank tool. Закрытый репозиторий.
