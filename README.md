# Beaver Adoption Scanner (DSCAN)

CLI-тулза для измерения adoption design system Beaver по T-Bank консьюмер-репо.

Спека: [ds-adoption-scanner-prd-v2.md](./ds-adoption-scanner-prd-v2.md).

## Статус

**MVP, M1 landed.** Beaver prescan + real TS module resolution работают. См. [implementation/plan.md](./implementation/plan.md).

| Stage | Статус |
|-------|--------|
| 1. Discovery | ✅ |
| 2. Parse | ✅ |
| 3. Resolve | ✅ (TS compiler API, tsconfig paths) |
| 4. Categorize | ✅ |
| 5a. Beaver prescan | ✅ (git clone + re-export map depth=5) |
| 5b. Local-lib prescan | ⏳ M3 |
| 6. Classify Этап A | ✅ |
| 6. Classify Этап B | заглушка (primitive-name → shadow/possible), M2 |
| 7. Route-Resolve | заглушка (все usage → `unsupported`), M4 |
| 8. Aggregate | метрики A/B/C/D + 4 из 9 инвариантов |
| HTML Viewer | hero + B/C/D |

## Быстрый старт

```bash
npm install
npm run typecheck
npm test

# Прогон на fixture-репо. BEAVER_LOCAL_PATH обходит git clone для локальных прогонов.
BEAVER_LOCAL_PATH=./tests/fixtures/beaver-ui \
  npm run dev -- run --config ./example/.beaver-scan.config.ts
```

Артефакты пишутся в `./results/`:
- `dataset.jsonl` — instance-level записи
- `aggregates.json` — derived-агрегаты
- `report.html` — self-contained viewer

## CLI

```bash
beaver-scan run --config <path>            # полный pipeline
beaver-scan aggregate --dataset <path>     # пересчёт агрегатов
beaver-scan viewer --aggregates <path>     # HTML из агрегатов
```

## Архитектура

- `src/config/` — Zod-схемы для global + per-repo конфигов
- `src/pipeline/` — стадии 1–8
- `src/types/` — типы датасета (schemaVersion 1.1)
- `src/writer/` — JSONL streaming writer
- `src/viewer/` — self-contained HTML-рендерер
- `tests/fixtures/` — синтетические репо для тестов
