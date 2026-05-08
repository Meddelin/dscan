# Beaver Adoption Scanner (DSCAN)

CLI-тулза для измерения adoption design system Beaver по T-Bank консьюмер-репо.

Спека: [ds-adoption-scanner-prd-v2.md](./ds-adoption-scanner-prd-v2.md).

## Статус

**MVP, M1–M6a landed.** Полный pipeline + Stage 7 route resolver + invariants.
См. [implementation/plan.md](./implementation/plan.md).

| Stage | Статус |
|-------|--------|
| 1. Discovery | ✅ |
| 2. Parse | ✅ |
| 3. Resolve | ✅ (TS compiler API, tsconfig paths) |
| 4. Categorize | ✅ |
| 5a. Beaver prescan | ✅ (git clone + re-export map depth=5) |
| 5b. Local-lib prescan | ✅ |
| 6. Classify Этап A | ✅ |
| 6. Classify Этап B | ✅ (6 сигналов + 3 уровня + adoption-wrapper rules) |
| 7. Route-Resolve | ✅ (React Router v6 data-router) |
| 8. Aggregate | метрики A/B/C/D/E + 7 из 9 инвариантов |
| HTML Viewer | hero + B/C/D/E + shared components |

## Быстрый старт

```bash
npm install
npm run typecheck
npm test
```

### Локальный прогон на фикстурах (без T-Bank доступа)

```bash
BEAVER_LOCAL_PATH=./tests/fixtures/beaver-ui \
  npm run dev -- run --config ./example/.beaver-scan.config.ts
```

`npm run dev` запускает CLI через `tsx`, который умеет грузить `.ts`-конфиги «на лету».

### Реальный прогон на T-Bank репо

```bash
# 1. SSH-ключ должен быть в агенте — иначе клонирование упадёт.
ssh-add ~/.ssh/id_ed25519

# 2. Клонировать все репо из repositories.json в ./ds-projects/
node scripts/clone-repos.mjs

# 3. Собрать и запустить
npm run build
npx ds-scanner analyze --output .ds-metrics/report
# или:  npx ds-scanner analyze --config ds-scanner.config.ts --output .ds-metrics/report
```

После сборки скомпилированный CLI всё ещё умеет читать `.ts`-конфиги — он
сам подгрузит `tsx/esm/api` register по необходимости. То есть собранный
бинарник работает с тем же `ds-scanner.config.ts`, что и dev-режим.

Артефакты пишутся в `./results/`:
- `dataset.jsonl` — instance-level записи
- `aggregates.json` — derived-агрегаты
- `report.html` — self-contained viewer

## CLI

Бинарник доступен под двумя именами: `ds-scanner` и `beaver-scan` — это один и тот же исполняемый файл.

```bash
ds-scanner analyze --output <dir>           # operator-friendly: scan + write to <dir>
ds-scanner analyze --config <path> --output <dir>
ds-scanner run --config <path>              # явный run
ds-scanner run --config <path> --no-fail-on-invariant
ds-scanner aggregate --dataset <path> --out <dir>
ds-scanner viewer --aggregates <path> --out <path>
ds-scanner update --config <path>           # git pull всех кэшированных репо
ds-scanner clean --config <path>            # удалить .cache/
```

`analyze` — алиас `run` с дефолтами `--config ds-scanner.config.ts` и `--output .ds-metrics/report`. Удобен для оператора.

## Per-repo config

Консьюмер-репо **не обязаны** добавлять `.beaver-scan.json` — работают built-in defaults. Переопределения кладутся либо в `.beaver-scan.json` на стороне консьюмера (если они сами хотят), либо inline в `repositories.json` на стороне оператора. См. [operator-runbook.md](./docs/operator-runbook.md).

## Архитектура

- `src/config/` — Zod-схемы для global + per-repo конфигов
- `src/pipeline/` — стадии 1–8
- `src/types/` — типы датасета (schemaVersion 1.1)
- `src/writer/` — JSONL streaming writer
- `src/viewer/` — self-contained HTML-рендерер
- `tests/fixtures/` — синтетические репо для тестов
