# Beaver Adoption Scanner (DSCAN)

CLI-тулза для измерения adoption design system Beaver по T-Bank консьюмер-репо.

Спека: [ds-adoption-scanner-prd-v2.md](./ds-adoption-scanner-prd-v2.md).

## Статус

**MVP, vertical slice.** End-to-end pipeline через упрощённую классификацию + HTML-viewer.
Stages реализованы частично:

| Stage | Статус |
|-------|--------|
| 1. Discovery | ✅ |
| 2. Parse | ✅ |
| 3. Resolve | заглушка (использует import source как есть) |
| 4. Categorize | ✅ (упрощённо, `beaverPackages` из конфига вместо prescan) |
| 5. Prescan-Join | ⏳ |
| 6. Classify | заглушка (структурная категория → bucket) |
| 7. Route-Resolve | заглушка (все usage → `unsupported`) |
| 8. Aggregate | ✅ (метрики A, D, meta) |
| HTML Viewer | ✅ (hero + per-repo + Beaver coverage) |

## Быстрый старт

```bash
npm install
npm run build
npm test

# Прогон на fixture-репо:
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
