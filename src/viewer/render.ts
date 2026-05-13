import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Aggregates } from '../types/dataset.js';

/**
 * Self-contained interactive HTML report (PF4).
 *
 * One file, inline CSS/JS, aggregates injected as a JS object — no fetch.
 *
 * On top of the existing per-table filter/sort/pagination system this adds:
 *   - persona toggle (Команда / Exec / Дизайнер / Разработчик) → CSS classes
 *     hide / dim sections appropriate to each audience. Default = «Команда».
 *   - auto-narrative summary derived from aggregates (one headline + bullets).
 *   - auto-recommendations card driven by `aggregates.recommendations`
 *     (generated upstream in `src/pipeline/recommendations.ts`).
 *   - inline SVG visualisations: bucket distribution donut + top-shadow Pareto.
 *   - methodology + FAQ + glossary popovers so a fresh viewer can answer
 *     «что значит adoption?», «почему этот компонент classified shadow?»,
 *     «какие пороги use'ются?» without leaving the file.
 *   - permalink: persona + active table filters round-trip through URL hash.
 *
 * Engineering-side considerations:
 *   - JSON injection escapes `<`, `>`, `&`, U+2028, U+2029 (XSS / JS-parse
 *     safety inside <script>).
 *   - No external network — everything inlined. Report stays portable.
 *   - Existing table controller (filter/sort/pagination) reused unchanged.
 */
export function renderReport(aggregates: Aggregates): string {
  const json = JSON.stringify(aggregates);
  const escaped = json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<title>Beaver Adoption — отчёт</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${CSS}</style>
</head>
<body data-persona="team">
<main id="app">
  <header class="page-header">
    <div class="brand">
      <span class="brand-mark">BEAVER</span>
      <span class="brand-sub">Adoption Scanner</span>
    </div>
    <div class="header-controls">
      <div class="persona-toggle" role="tablist" aria-label="Аудитория">
        <button class="persona-btn active" data-persona="team" role="tab" title="Дефолт: всё показано, эмфаза на действия">Команда</button>
        <button class="persona-btn" data-persona="exec" role="tab" title="Только метрики и рекомендации">Exec</button>
        <button class="persona-btn" data-persona="designer" role="tab" title="Shadow по компонентам, без файлового шума">Дизайнер</button>
        <button class="persona-btn" data-persona="developer" role="tab" title="Все таблицы, файлы, инварианты">Разработчик</button>
      </div>
      <button class="permalink-btn" id="permalink-btn" title="Скопировать ссылку на текущий вид">🔗 Ссылка</button>
    </div>
    <div class="meta" id="meta"></div>
  </header>

  <section class="onboarding" id="onboarding">
    <div class="onboarding-head">
      <h3>Как читать этот отчёт</h3>
      <button class="toggle" id="onboarding-close" aria-label="Скрыть">×</button>
    </div>
    <ol class="onboarding-steps">
      <li><strong>Сверху — четыре метрики A/B/C/D.</strong> A = насколько в коде используется Beaver, C = сколько компонентов «переизобретено». Клик по карточке откроет формулу.</li>
      <li><strong>Сразу под ними — что делать.</strong> Карточка «Что советует сканер» = операторские рекомендации с приоритетами.</li>
      <li><strong>Дальше — таблицы.</strong> Adoption по маршрутам (E), по репо (B), карта shadow (C), покрытие пакетов (D), shared-компоненты.</li>
      <li><strong>В каждой таблице есть фильтр, сортировка и пагинация.</strong> Клик по столбцу — сортировка. Поле «Фильтр…» — поиск по всем колонкам.</li>
      <li><strong>Снизу — методология и FAQ.</strong> Что такое «shadow», как считается adoption, почему этот компонент попал в categories.</li>
    </ol>
  </section>

  <section class="narrative" id="narrative">
    <h3 id="narrative-headline">—</h3>
    <ul id="narrative-bullets"></ul>
  </section>

  <section class="panel recommendations" id="panel-recs">
    <div class="panel-head">
      <h2>Что советует сканер</h2>
      <span class="muted" id="recs-count"></span>
    </div>
    <p class="muted">
      Рекомендации генерируются автоматически по агрегатам (см. <code>recommendations</code>
      в конфиге). Это не план миграции — это подсказка, куда смотреть первым.
    </p>
    <div id="recs-list"></div>
  </section>

  <section class="hero">
    <div class="hero-card" data-metric="A" tabindex="0" role="button">
      <div class="hero-label">A — Общий adoption <span class="info-pill" data-glossary="adoption">?</span></div>
      <div class="hero-value" id="metric-a">—</div>
      <div class="hero-hint">adoption / (adoption + shadow)</div>
    </div>
    <div class="hero-card" data-metric="B" tabindex="0" role="button">
      <div class="hero-label">B — Среднее по репо</div>
      <div class="hero-value" id="metric-b">—</div>
      <div class="hero-hint">невзвешенное по сканированным репо</div>
    </div>
    <div class="hero-card" data-metric="C" tabindex="0" role="button">
      <div class="hero-label">C — Confirmed shadow <span class="info-pill" data-glossary="shadow">?</span></div>
      <div class="hero-value" id="metric-c">—</div>
      <div class="hero-hint">различных групп shadow-компонентов</div>
    </div>
    <div class="hero-card" data-metric="D" tabindex="0" role="button">
      <div class="hero-label">D — Beaver-пакетов</div>
      <div class="hero-value" id="metric-d">—</div>
      <div class="hero-hint">уникальных пакетов в импортах</div>
    </div>
  </section>

  <section class="panel viz-panel" id="panel-viz">
    <div class="panel-head">
      <h2>Распределение usage'ей <span class="info-pill" data-glossary="bucket">?</span></h2>
    </div>
    <div class="viz-grid">
      <div class="viz-cell">
        <h4>Bucket-распределение</h4>
        <div id="donut-host"></div>
      </div>
      <div class="viz-cell">
        <h4>Топ-10 shadow по числу usage'ей</h4>
        <div id="pareto-host"></div>
      </div>
    </div>
  </section>

  <section class="panel" id="panel-per-route">
    <div class="panel-head">
      <h2>E — Adoption по маршрутам</h2>
    </div>
    <p class="muted">
      Adoption по парам (репо, маршрут). В знаменатель идут только usage'и из файлов,
      привязанных ровно к одному маршруту (PRD §7.5). Эту секцию показываем первой —
      продуктовые команды думают о adoption через маршруты:
      «/checkout хуже, чем /admin» проще понять, чем «adoption 67%».
    </p>
    <div class="table-host" data-table="per-route"></div>
  </section>

  <section class="panel" id="panel-per-repo">
    <h2>B — Adoption по репо</h2>
    <div class="table-host" data-table="per-repo"></div>
  </section>

  <section class="panel" id="panel-shadow">
    <div class="panel-head">
      <h2>C — Карта shadow-компонентов <span class="info-pill" data-glossary="shadow-level">?</span></h2>
      <div class="tabs" role="tablist">
        <button class="tab active" data-view="byComponent" role="tab">По компонентам</button>
        <button class="tab" data-view="byFile" role="tab">По файлам</button>
      </div>
    </div>
    <p class="muted">
      По компонентам — дефолтный вид. Одна строка = одна группа
      (имя + сигнатура пропсов + диапазон markup-размера). Используй для решения
      «какой компонент добавить в Beaver». Переключи на «По файлам» когда уже
      решил мигрировать и нужны конкретные файлы.
    </p>
    <div class="table-host" data-table="shadow-component"></div>
    <div class="table-host hidden" data-table="shadow-file"></div>
  </section>

  <section class="panel" id="panel-coverage">
    <h2>D — Покрытие Beaver-пакетов</h2>
    <div class="table-host" data-table="coverage"></div>
  </section>

  <section class="panel" id="panel-shared">
    <h2>Shared-компоненты <span class="info-pill" data-glossary="shared">?</span></h2>
    <p class="muted">
      Файлы, достижимые от двух и более page-компонентов. Эти usage'и не идут
      в знаменатель метрики E (§7.5), но важны для adoption-стратегии:
      переписать один хедер дешевле, чем 30 страниц.
    </p>
    <div class="table-host" data-table="shared"></div>
  </section>

  <section class="panel methodology" id="panel-methodology">
    <h2>Методология</h2>
    <p class="muted">
      Восемь стадий конвейера — от дискавери файлов до агрегации. Каждый usage
      проходит классификацию: <code>adoption</code> (импорт из Beaver и без кастомизации),
      <code>shadow</code> (локальный реимпорт с признаками примитива), <code>neither</code>
      (ни то, ни другое — например, чужая либа).
    </p>
    <div class="pipeline">
      <div class="stage"><strong>1. Discovery</strong><span>Найти .tsx/.jsx/.ts/.js, исключить mocks/tests/storybook</span></div>
      <div class="stage"><strong>2. Parse</strong><span>AST → JSX usage + imports (typescript-estree)</span></div>
      <div class="stage"><strong>3. Resolve</strong><span>Импорт → канонический путь через tsconfig paths</span></div>
      <div class="stage"><strong>4. Categorize</strong><span>Beaver / local-lib / external / dynamic</span></div>
      <div class="stage"><strong>5. Prescan-Join</strong><span>Соединить с реестром Beaver-пакетов</span></div>
      <div class="stage"><strong>6. Classify</strong><span>Pass-A (профили) → Pass-B (signals) → bucket + level</span></div>
      <div class="stage"><strong>7. Route-Resolve</strong><span>File → reachableSet(page) → bound/shared/unmapped</span></div>
      <div class="stage"><strong>8. Aggregate</strong><span>Метрики A–E, инварианты, рекомендации</span></div>
    </div>
    <p class="muted small">
      Подробное описание формул и порогов — в <code>docs/руководство.md</code> и PRD §3–§7.
    </p>
  </section>

  <section class="panel faq" id="panel-faq">
    <h2>Частые вопросы</h2>
    <div id="faq-list"></div>
  </section>

  <section class="panel footnote" id="panel-warnings">
    <div class="panel-head">
      <h2>Предупреждения и инварианты</h2>
      <button class="toggle" id="warnings-toggle" aria-expanded="false">Развернуть</button>
    </div>
    <p><strong>Инварианты:</strong> <span id="invariants-summary">—</span></p>
    <div id="warnings-body" class="hidden">
      <div id="violations-block"></div>
      <div id="warnings-list-host"></div>
    </div>
  </section>
</main>

<div class="modal hidden" id="metric-modal" role="dialog" aria-modal="true">
  <div class="modal-bg" data-close></div>
  <div class="modal-card">
    <button class="modal-close" data-close aria-label="Закрыть">×</button>
    <h3 id="metric-modal-title">—</h3>
    <pre id="metric-modal-formula" class="formula"></pre>
    <div id="metric-modal-body"></div>
  </div>
</div>

<div class="glossary-pop hidden" id="glossary-pop">
  <h4 id="glossary-title"></h4>
  <div id="glossary-body"></div>
</div>

<div class="toast hidden" id="toast"></div>

<script>
const DATA = ${escaped};
${CLIENT_JS}
</script>
</body>
</html>`;
}

export async function writeReport(path: string, html: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, html, 'utf-8');
}

const CSS = `
:root {
  --bg: #0f1115;
  --panel: #161a21;
  --panel-border: #232935;
  --fg: #e6e8ee;
  --fg-dim: #9aa3b2;
  --accent: #f4a94a;
  --accent-soft: rgba(244, 169, 74, 0.15);
  --good: #5bbf7e;
  --warn: #e8c46a;
  --bad: #e67566;
  --info: #6aa6e8;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 14px; line-height: 1.5;
}
main { max-width: 1280px; margin: 0 auto; padding: 32px 24px 80px; }
h2 { font-size: 14px; font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--fg-dim); margin: 0 0 16px; }
h3 { font-size: 18px; font-weight: 600; margin: 0 0 12px; color: var(--fg); }
h4 { font-size: 12px; font-weight: 600; color: var(--fg-dim);
  text-transform: uppercase; letter-spacing: 0.06em; margin: 0 0 12px; }
code { font-family: var(--mono); font-size: 12px; background: var(--bg);
  padding: 1px 5px; border-radius: 3px; border: 1px solid var(--panel-border); }
.page-header { display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto;
  row-gap: 12px; column-gap: 24px; align-items: center;
  padding-bottom: 24px; border-bottom: 1px solid var(--panel-border); margin-bottom: 24px;
}
.brand { grid-column: 1; grid-row: 1 / span 2; }
.brand-mark { font-family: var(--mono); font-size: 22px; font-weight: 700;
  letter-spacing: 0.1em; color: var(--accent); display: block; }
.brand-sub { font-size: 12px; color: var(--fg-dim); letter-spacing: 0.1em;
  text-transform: uppercase; }
.header-controls { grid-column: 2; grid-row: 1; display: flex; gap: 12px;
  justify-content: flex-end; align-items: center; flex-wrap: wrap; }
.persona-toggle { display: flex; gap: 2px; background: var(--bg); padding: 3px;
  border-radius: 6px; border: 1px solid var(--panel-border); }
.persona-btn { background: transparent; color: var(--fg-dim); border: 0; cursor: pointer;
  padding: 6px 12px; font-size: 12px; border-radius: 4px; font-family: inherit;
  letter-spacing: 0.02em; }
.persona-btn:hover { color: var(--fg); }
.persona-btn.active { background: var(--accent-soft); color: var(--accent); }
.permalink-btn { background: var(--bg); color: var(--fg-dim); border: 1px solid var(--panel-border);
  cursor: pointer; padding: 6px 10px; font-size: 12px; border-radius: 4px;
  font-family: inherit; }
.permalink-btn:hover { color: var(--fg); border-color: var(--accent); }
.meta { grid-column: 2; grid-row: 2; font-family: var(--mono); font-size: 12px;
  color: var(--fg-dim); text-align: right; line-height: 1.7; }
.meta strong { color: var(--fg); font-weight: 600; }

@media (max-width: 720px) {
  .page-header { grid-template-columns: 1fr; }
  .brand, .header-controls, .meta { grid-column: 1; grid-row: auto; text-align: left;
    justify-content: flex-start; }
}

.onboarding { background: linear-gradient(135deg, rgba(244, 169, 74, 0.08), rgba(106, 166, 232, 0.05));
  border: 1px solid var(--panel-border); border-radius: 8px;
  padding: 20px 24px; margin-bottom: 24px; }
.onboarding-head { display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 12px; }
.onboarding-head h3 { margin: 0; }
.onboarding-steps { margin: 0; padding-left: 20px; color: var(--fg); font-size: 13px;
  line-height: 1.8; }
.onboarding-steps li { margin-bottom: 4px; }
.onboarding.dismissed { display: none; }

.narrative { background: var(--panel); border: 1px solid var(--panel-border);
  border-left: 3px solid var(--accent); border-radius: 8px;
  padding: 20px 24px; margin-bottom: 24px; }
.narrative h3 { font-size: 16px; margin-bottom: 12px; line-height: 1.4; }
.narrative ul { margin: 0; padding-left: 20px; color: var(--fg-dim); font-size: 13px;
  line-height: 1.8; }
.narrative ul li strong { color: var(--fg); }

.hero { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
@media (max-width: 800px) { .hero { grid-template-columns: repeat(2, 1fr); } }
.hero-card { background: var(--panel); border: 1px solid var(--panel-border);
  border-radius: 8px; padding: 20px; position: relative; overflow: hidden;
  cursor: pointer; transition: transform 0.15s ease, border-color 0.15s ease; }
.hero-card:hover, .hero-card:focus { border-color: var(--accent); transform: translateY(-1px);
  outline: none; }
.hero-card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 3px;
  background: var(--accent); opacity: 0.6; }
.hero-label { font-size: 12px; color: var(--fg-dim); text-transform: uppercase;
  letter-spacing: 0.08em; display: flex; align-items: center; gap: 8px; }
.hero-value { font-family: var(--mono); font-size: 32px; font-weight: 600;
  margin: 8px 0 4px; color: var(--fg); }
.hero-hint { font-size: 11px; color: var(--fg-dim); font-family: var(--mono); }

.panel { background: var(--panel); border: 1px solid var(--panel-border);
  border-radius: 8px; padding: 20px 24px; margin-bottom: 24px; }
.panel-head { display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 16px; flex-wrap: wrap; gap: 12px; }
.panel-head h2 { margin: 0; display: flex; align-items: center; gap: 8px; }

.recommendations .rec-card { display: flex; gap: 12px; padding: 12px 0;
  border-bottom: 1px solid var(--panel-border); }
.recommendations .rec-card:last-child { border-bottom: 0; }
.rec-priority { width: 8px; height: 8px; border-radius: 50%; margin-top: 8px;
  flex-shrink: 0; }
.rec-priority.high { background: var(--bad); box-shadow: 0 0 8px var(--bad); }
.rec-priority.medium { background: var(--warn); box-shadow: 0 0 6px var(--warn); }
.rec-priority.low { background: var(--info); }
.rec-body { flex: 1; }
.rec-title { font-weight: 600; color: var(--fg); margin-bottom: 4px; font-size: 14px; }
.rec-rationale { color: var(--fg-dim); font-size: 13px; line-height: 1.5; }
.rec-empty { color: var(--fg-dim); font-size: 13px; padding: 8px 0; }

.viz-grid { display: grid; grid-template-columns: 280px 1fr; gap: 24px; align-items: start; }
@media (max-width: 720px) { .viz-grid { grid-template-columns: 1fr; } }
.viz-cell { background: var(--bg); border-radius: 6px; padding: 16px;
  border: 1px solid var(--panel-border); }
.donut { display: block; margin: 0 auto; }
.donut-legend { font-size: 12px; color: var(--fg-dim); margin-top: 12px;
  display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px; }
.donut-legend .swatch { display: inline-block; width: 10px; height: 10px;
  border-radius: 2px; vertical-align: middle; margin-right: 6px; }
.donut-empty { text-align: center; color: var(--fg-dim); padding: 60px 0; font-size: 13px; }

.pareto-bar { display: grid; grid-template-columns: 220px 1fr 60px;
  gap: 12px; align-items: center; padding: 4px 0; font-size: 12px;
  font-family: var(--mono); }
.pareto-bar .label { color: var(--fg-dim); white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.pareto-bar .bar { background: var(--panel); border-radius: 3px; height: 16px;
  position: relative; overflow: hidden; }
.pareto-bar .bar > span { display: block; height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--bad)); }
.pareto-bar .count { color: var(--fg); text-align: right; }
.pareto-empty { text-align: center; color: var(--fg-dim); padding: 40px 0; font-size: 13px; }

.tabs { display: flex; gap: 4px; background: var(--bg); padding: 3px; border-radius: 6px;
  border: 1px solid var(--panel-border); }
.tab { background: transparent; color: var(--fg-dim); border: 0; cursor: pointer;
  padding: 6px 12px; font-size: 12px; border-radius: 4px; font-family: inherit;
  letter-spacing: 0.02em; }
.tab.active { background: var(--accent-soft); color: var(--accent); }
.toggle { background: var(--bg); color: var(--fg-dim); border: 1px solid var(--panel-border);
  cursor: pointer; padding: 4px 10px; font-size: 12px; border-radius: 4px;
  font-family: inherit; }
.toggle:hover { color: var(--fg); }

.info-pill { display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border-radius: 50%; font-size: 10px; font-weight: 700;
  background: var(--bg); color: var(--fg-dim); border: 1px solid var(--panel-border);
  cursor: help; user-select: none; }
.info-pill:hover { color: var(--accent); border-color: var(--accent); }

.tbl-controls { display: flex; gap: 12px; align-items: center; margin-bottom: 12px;
  flex-wrap: wrap; font-size: 12px; color: var(--fg-dim); }
.tbl-filter { flex: 1 1 240px; min-width: 200px; background: var(--bg);
  border: 1px solid var(--panel-border); color: var(--fg); padding: 6px 10px;
  border-radius: 4px; font-family: inherit; font-size: 13px; }
.tbl-filter:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
.tbl-pagesize { background: var(--bg); border: 1px solid var(--panel-border);
  color: var(--fg); padding: 5px 8px; border-radius: 4px; font-family: inherit; font-size: 12px; }
.tbl-count { font-family: var(--mono); }
.tbl-empty { padding: 24px 12px; text-align: center; color: var(--fg-dim); font-size: 13px; }
.csv-export { background: var(--bg); color: var(--fg-dim);
  border: 1px solid var(--panel-border); cursor: pointer; padding: 5px 10px;
  border-radius: 4px; font-family: inherit; font-size: 12px; }
.csv-export:hover { color: var(--accent); border-color: var(--accent); }

.data-table { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: auto; }
.data-table th, .data-table td { text-align: left; padding: 8px 12px;
  border-bottom: 1px solid var(--panel-border); vertical-align: top; }
.data-table th { font-weight: 600; color: var(--fg-dim); font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.06em; user-select: none; }
.data-table th.sortable { cursor: pointer; }
.data-table th.sortable:hover { color: var(--fg); }
.data-table th .sort-indicator { display: inline-block; width: 10px; opacity: 0.6;
  margin-left: 4px; }
.data-table td { font-family: var(--mono); }
.data-table td.num, .data-table th.num { text-align: right; font-variant-numeric: tabular-nums;
  white-space: nowrap; }
.data-table tbody tr:hover { background: rgba(244, 169, 74, 0.04); }
.data-table tbody tr:last-child td { border-bottom: 0; }
.data-table td.ellipsize { max-width: 360px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.data-table td.ellipsize:hover { white-space: normal; word-break: break-all; }

.tbl-pager { display: flex; gap: 8px; align-items: center; padding-top: 12px;
  font-size: 12px; color: var(--fg-dim); border-top: 1px solid var(--panel-border);
  margin-top: 4px; flex-wrap: wrap; }
.tbl-pager button { background: var(--bg); color: var(--fg); border: 1px solid var(--panel-border);
  cursor: pointer; padding: 4px 10px; border-radius: 4px; font-family: inherit; font-size: 12px; }
.tbl-pager button:disabled { opacity: 0.3; cursor: not-allowed; }
.tbl-pager .pager-page { font-family: var(--mono); }

.pipeline { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 16px 0; }
@media (max-width: 800px) { .pipeline { grid-template-columns: repeat(2, 1fr); } }
.pipeline .stage { background: var(--bg); border: 1px solid var(--panel-border);
  border-radius: 6px; padding: 12px; font-size: 12px; }
.pipeline .stage strong { display: block; color: var(--accent); margin-bottom: 4px;
  font-family: var(--mono); }
.pipeline .stage span { color: var(--fg-dim); line-height: 1.5; }

.faq-item { border-bottom: 1px solid var(--panel-border); padding: 12px 0; }
.faq-item:last-child { border-bottom: 0; }
.faq-q { cursor: pointer; font-weight: 600; color: var(--fg); padding: 4px 0;
  display: flex; justify-content: space-between; align-items: center;
  user-select: none; }
.faq-q:hover { color: var(--accent); }
.faq-q::after { content: "+"; color: var(--fg-dim); font-family: var(--mono);
  font-size: 16px; }
.faq-item.open .faq-q::after { content: "−"; }
.faq-a { color: var(--fg-dim); padding: 8px 0 4px; font-size: 13px;
  line-height: 1.6; display: none; }
.faq-item.open .faq-a { display: block; }
.faq-a code, .faq-a pre { background: var(--bg); }
.faq-a pre { padding: 12px; border-radius: 4px; overflow-x: auto;
  border: 1px solid var(--panel-border); font-size: 12px; }

.modal { position: fixed; inset: 0; z-index: 100; display: flex;
  align-items: center; justify-content: center; padding: 20px; }
.modal.hidden { display: none; }
.modal-bg { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(2px); }
.modal-card { position: relative; background: var(--panel); border: 1px solid var(--panel-border);
  border-radius: 8px; padding: 24px; max-width: 560px; width: 100%;
  max-height: 90vh; overflow-y: auto; }
.modal-close { position: absolute; top: 12px; right: 12px; background: transparent;
  color: var(--fg-dim); border: 0; font-size: 24px; cursor: pointer; line-height: 1; }
.modal-close:hover { color: var(--fg); }
.formula { background: var(--bg); border: 1px solid var(--panel-border);
  padding: 12px; border-radius: 4px; font-family: var(--mono); font-size: 13px;
  color: var(--accent); margin: 12px 0; white-space: pre-wrap; }

.glossary-pop { position: absolute; z-index: 90; background: var(--panel);
  border: 1px solid var(--accent); border-radius: 6px; padding: 12px 16px;
  max-width: 320px; font-size: 12px; line-height: 1.5; color: var(--fg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); }
.glossary-pop.hidden { display: none; }
.glossary-pop h4 { color: var(--accent); margin: 0 0 8px; font-size: 11px; }

.toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  background: var(--panel); border: 1px solid var(--accent); border-radius: 6px;
  padding: 10px 16px; font-size: 13px; color: var(--fg); z-index: 110;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4); transition: opacity 0.3s; }
.toast.hidden { display: none; }
.toast.fading { opacity: 0; }

.hidden { display: none !important; }
.muted { color: var(--fg-dim); font-size: 13px; margin: 0 0 12px; }
.muted.small { font-size: 11px; }
.footnote { font-size: 12px; }
.level-badge { display: inline-block; padding: 1px 8px; border-radius: 999px;
  font-size: 11px; font-family: var(--mono); letter-spacing: 0.02em; }
.level-confirmed { background: rgba(230, 117, 102, 0.15); color: var(--bad); }
.level-likely { background: rgba(232, 196, 106, 0.15); color: var(--warn); }
.level-possible { background: rgba(154, 163, 178, 0.12); color: var(--fg-dim); }
.bucket-badge { display: inline-block; padding: 1px 8px; border-radius: 999px;
  font-size: 11px; font-family: var(--mono); }
.bucket-adoption { background: rgba(91, 191, 126, 0.15); color: var(--good); }
.bucket-shadow { background: rgba(230, 117, 102, 0.15); color: var(--bad); }
.bucket-neither { background: rgba(154, 163, 178, 0.12); color: var(--fg-dim); }
.violation-row { font-family: var(--mono); font-size: 12px; color: var(--warn);
  padding: 4px 0; }
.adoption-bar { display: inline-block; width: 80px; height: 6px; background: var(--bg);
  border-radius: 999px; overflow: hidden; margin-right: 8px; vertical-align: middle; }
.adoption-bar > span { display: block; height: 100%; background: var(--good); }

/* Persona modes — hide non-relevant sections per audience. */
body[data-persona="exec"] #panel-shadow,
body[data-persona="exec"] #panel-coverage,
body[data-persona="exec"] #panel-shared,
body[data-persona="exec"] #panel-warnings,
body[data-persona="exec"] #panel-methodology { display: none; }
body[data-persona="designer"] #panel-warnings,
body[data-persona="designer"] #panel-coverage { display: none; }
body[data-persona="designer"] #panel-shadow .tab[data-view="byFile"] { display: none; }
body[data-persona="developer"] #onboarding { display: none; }
`;

const CLIENT_JS = `
function pct(v) { return (v * 100).toFixed(1) + '%'; }
function levelBadge(level) {
  return '<span class="level-badge level-' + level + '">' + level + '</span>';
}
function bucketBadge(bucket) {
  return '<span class="bucket-badge bucket-' + bucket + '">' + bucket + '</span>';
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function adoptionBar(value) {
  return '<span class="adoption-bar"><span style="width:' +
    (value * 100).toFixed(1) + '%"></span></span>';
}
function ruRepoPlural(n) {
  return n + ' ' + (n === 1 ? 'репо' : (n >= 2 && n <= 4 ? 'репо' : 'репо'));
}
function ruUsagePlural(n) {
  var m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return n + " usage";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return n + " usage'я";
  return n + " usage'ей";
}
function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden', 'fading');
  setTimeout(function () { t.classList.add('fading'); }, 1800);
  setTimeout(function () { t.classList.add('hidden'); }, 2200);
}

// --- DataTable: reusable controller for filter/sort/pagination + CSV export ---
function createTable(host, opts) {
  // opts: { rows, columns, pageSize?, emptyText?, defaultSort?, csvName? }
  var state = {
    rows: opts.rows || [],
    columns: opts.columns,
    pageSize: opts.pageSize || 50,
    page: 0,
    filter: '',
    sortKey: opts.defaultSort ? opts.defaultSort.key : null,
    sortDir: opts.defaultSort ? opts.defaultSort.dir : 1,
    emptyText: opts.emptyText || 'Данных нет.',
    csvName: opts.csvName || 'table'
  };

  function getCellString(row, col) {
    var rendered = col.render ? col.render(row) : row[col.key];
    if (rendered === null || rendered === undefined) return '';
    return String(rendered).replace(/<[^>]+>/g, '').toLowerCase();
  }

  function filtered() {
    if (!state.filter) return state.rows;
    var q = state.filter.toLowerCase();
    return state.rows.filter(function (row) {
      for (var i = 0; i < state.columns.length; i++) {
        if (getCellString(row, state.columns[i]).indexOf(q) !== -1) return true;
      }
      return false;
    });
  }

  function sorted(rows) {
    if (!state.sortKey || state.sortDir === 0) return rows;
    var col = state.columns.filter(function (c) { return c.key === state.sortKey; })[0];
    if (!col) return rows;
    var getter = col.getSortValue || function (row) {
      var v = row[col.key];
      return typeof v === 'number' ? v : String(v == null ? '' : v).toLowerCase();
    };
    var dir = state.sortDir;
    return rows.slice().sort(function (a, b) {
      var av = getter(a), bv = getter(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  function csvCell(s) {
    s = String(s == null ? '' : s).replace(/<[^>]+>/g, '');
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\\n') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }
  function exportCsv() {
    var rows = sorted(filtered());
    var lines = [state.columns.map(function (c) { return csvCell(c.label); }).join(',')];
    for (var i = 0; i < rows.length; i++) {
      var line = [];
      for (var c = 0; c < state.columns.length; c++) {
        var col = state.columns[c];
        var raw = col.render ? col.render(rows[i]) : rows[i][col.key];
        line.push(csvCell(raw));
      }
      lines.push(line.join(','));
    }
    var blob = new Blob([lines.join('\\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = state.csvName + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function render() {
    var rows = sorted(filtered());
    var total = rows.length;
    var totalAll = state.rows.length;
    var pageSize = state.pageSize === 0 ? total : state.pageSize;
    var pages = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
    if (state.page >= pages) state.page = pages - 1;
    if (state.page < 0) state.page = 0;
    var start = pageSize > 0 ? state.page * pageSize : 0;
    var end = pageSize > 0 ? Math.min(start + pageSize, total) : total;
    var visible = rows.slice(start, end);

    var html = '';
    html += '<div class="tbl-controls">';
    html += '<input class="tbl-filter" type="search" placeholder="Фильтр…" value="' +
      escapeHtml(state.filter) + '" />';
    html += '<span class="tbl-count">';
    if (state.filter) {
      html += escapeHtml(String(total)) + ' из ' + escapeHtml(String(totalAll));
    } else {
      html += escapeHtml(String(total)) + ' ' +
        (total === 1 ? 'запись' : (total >= 2 && total <= 4 ? 'записи' : 'записей'));
    }
    html += '</span>';
    html += '<label>Строк на странице: ';
    html += '<select class="tbl-pagesize">';
    var sizes = [50, 100, 250, 500, 0];
    for (var i = 0; i < sizes.length; i++) {
      var sz = sizes[i];
      var sel = sz === state.pageSize ? ' selected' : '';
      var lbl = sz === 0 ? 'все' : String(sz);
      html += '<option value="' + sz + '"' + sel + '>' + lbl + '</option>';
    }
    html += '</select></label>';
    html += '<button class="csv-export" title="Скачать CSV">⬇ CSV</button>';
    html += '</div>';

    if (total === 0) {
      html += '<div class="tbl-empty">' + escapeHtml(state.emptyText) + '</div>';
    } else {
      html += '<table class="data-table"><thead><tr>';
      for (var c = 0; c < state.columns.length; c++) {
        var col = state.columns[c];
        var thCls = (col.num ? 'num ' : '') + (col.sortable !== false ? 'sortable' : '');
        html += '<th class="' + thCls.trim() + '" data-col="' + escapeHtml(col.key) + '">';
        html += escapeHtml(col.label);
        if (col.sortable !== false) {
          var ind = '';
          if (state.sortKey === col.key) {
            ind = state.sortDir === 1 ? '▲' : state.sortDir === -1 ? '▼' : '';
          }
          html += '<span class="sort-indicator">' + ind + '</span>';
        }
        html += '</th>';
      }
      html += '</tr></thead><tbody>';
      for (var r = 0; r < visible.length; r++) {
        html += '<tr>';
        for (var c2 = 0; c2 < state.columns.length; c2++) {
          var col2 = state.columns[c2];
          var raw = col2.render ? col2.render(visible[r]) : visible[r][col2.key];
          var tdCls = (col2.num ? 'num' : '') + (col2.ellipsize ? ' ellipsize' : '');
          var tdAttr = '';
          if (col2.ellipsize) {
            var plain = String(raw == null ? '' : raw).replace(/<[^>]+>/g, '');
            tdAttr = ' title="' + escapeHtml(plain) + '"';
          }
          html += '<td' + (tdCls ? ' class="' + tdCls.trim() + '"' : '') + tdAttr + '>';
          html += (raw === null || raw === undefined) ? '' : raw;
          html += '</td>';
        }
        html += '</tr>';
      }
      html += '</tbody></table>';

      if (pages > 1) {
        html += '<div class="tbl-pager">';
        html += '<button data-action="first"' + (state.page === 0 ? ' disabled' : '') + '>«</button>';
        html += '<button data-action="prev"' + (state.page === 0 ? ' disabled' : '') + '>←</button>';
        html += '<span class="pager-page">' + (state.page + 1) + ' / ' + pages + '</span>';
        html += '<button data-action="next"' + (state.page >= pages - 1 ? ' disabled' : '') + '>→</button>';
        html += '<button data-action="last"' + (state.page >= pages - 1 ? ' disabled' : '') + '>»</button>';
        html += '<span style="margin-left:auto">' + (start + 1) + '–' + end + ' из ' + total + '</span>';
        html += '</div>';
      }
    }

    host.innerHTML = html;
    bindControls();
  }

  function bindControls() {
    var filterInput = host.querySelector('.tbl-filter');
    if (filterInput) {
      var debounceTimer = null;
      filterInput.addEventListener('input', function (e) {
        clearTimeout(debounceTimer);
        var val = e.target.value;
        debounceTimer = setTimeout(function () {
          state.filter = val;
          state.page = 0;
          render();
        }, 150);
      });
    }
    var pageSizeSelect = host.querySelector('.tbl-pagesize');
    if (pageSizeSelect) {
      pageSizeSelect.addEventListener('change', function (e) {
        state.pageSize = parseInt(e.target.value, 10);
        state.page = 0;
        render();
      });
    }
    var csvBtn = host.querySelector('.csv-export');
    if (csvBtn) csvBtn.addEventListener('click', exportCsv);
    host.querySelectorAll('th.sortable').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.dataset.col;
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === 1 ? -1 : state.sortDir === -1 ? 0 : 1;
          if (state.sortDir === 0) state.sortKey = null;
        } else {
          state.sortKey = key;
          state.sortDir = 1;
        }
        render();
      });
    });
    host.querySelectorAll('.tbl-pager button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var pages = Math.max(1, Math.ceil(filtered().length / (state.pageSize || 1)));
        switch (btn.dataset.action) {
          case 'first': state.page = 0; break;
          case 'prev': state.page = Math.max(0, state.page - 1); break;
          case 'next': state.page = Math.min(pages - 1, state.page + 1); break;
          case 'last': state.page = pages - 1; break;
        }
        render();
      });
    });
  }

  render();
  return { rerender: render };
}

// --- Persona controller ---
function initPersona() {
  var saved = null;
  try { saved = localStorage.getItem('dscan-persona'); } catch (e) {}
  var hash = parseHash();
  var initial = hash.persona || saved || 'team';
  applyPersona(initial);
  document.querySelectorAll('.persona-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      applyPersona(btn.dataset.persona);
    });
  });
}
function applyPersona(p) {
  document.body.setAttribute('data-persona', p);
  document.querySelectorAll('.persona-btn').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.persona === p);
  });
  try { localStorage.setItem('dscan-persona', p); } catch (e) {}
  updateHash({ persona: p === 'team' ? null : p });
}

// --- URL hash state ---
function parseHash() {
  var h = window.location.hash.replace(/^#/, '');
  if (!h) return {};
  var out = {};
  h.split('&').forEach(function (kv) {
    var idx = kv.indexOf('=');
    if (idx === -1) return;
    out[decodeURIComponent(kv.slice(0, idx))] = decodeURIComponent(kv.slice(idx + 1));
  });
  return out;
}
function updateHash(patch) {
  var cur = parseHash();
  Object.keys(patch).forEach(function (k) {
    if (patch[k] === null || patch[k] === undefined) delete cur[k];
    else cur[k] = patch[k];
  });
  var keys = Object.keys(cur);
  if (keys.length === 0) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  } else {
    var s = keys.map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(cur[k]);
    }).join('&');
    history.replaceState(null, '', '#' + s);
  }
}
function initPermalink() {
  var btn = document.getElementById('permalink-btn');
  btn.addEventListener('click', function () {
    var url = window.location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () {
        showToast('Ссылка скопирована');
      }, function () { showToast('Не удалось скопировать: ' + url); });
    } else {
      showToast('Ссылка: ' + url);
    }
  });
}

// --- Onboarding card ---
function initOnboarding() {
  var card = document.getElementById('onboarding');
  var closeBtn = document.getElementById('onboarding-close');
  var dismissed = false;
  try { dismissed = localStorage.getItem('dscan-onboarding-dismissed') === '1'; } catch (e) {}
  if (dismissed) card.classList.add('dismissed');
  closeBtn.addEventListener('click', function () {
    card.classList.add('dismissed');
    try { localStorage.setItem('dscan-onboarding-dismissed', '1'); } catch (e) {}
  });
}

// --- Header meta line ---
function renderMeta() {
  var m = DATA.meta;
  var date = new Date(m.scannedAt);
  var humanDate = isNaN(date.getTime()) ? m.scannedAt : date.toLocaleString('ru-RU');
  document.getElementById('meta').innerHTML =
    '<div>Сканирование: <strong>' + escapeHtml(humanDate) + '</strong></div>' +
    '<div>Beaver: <strong>' + escapeHtml(m.beaverVersion) + '</strong></div>' +
    '<div><strong>' + m.reposScanned + '</strong> репо · <strong>' + m.filesScanned + '</strong> файлов · ' +
    (m.scanDurationMs / 1000).toFixed(2) + 'с</div>';
}

// --- Narrative auto-summary ---
function renderNarrative() {
  var a = DATA.metrics.globalAdoption.value;
  var perRepo = DATA.metrics.perRepoAdoption;
  var meanB = perRepo.length > 0
    ? perRepo.reduce(function (s, r) { return s + r.value; }, 0) / perRepo.length
    : 0;
  var topShadow = (DATA.metrics.shadowLandscape.byComponent || [])
    .slice()
    .sort(function (a, b) { return b.totalUsages - a.totalUsages; })[0];
  var confirmedCount = DATA.metrics.shadowLandscape.byComponent
    .filter(function (c) { return c.level === 'confirmed'; }).length;
  var firstRec = (DATA.recommendations || [])[0];

  var headline;
  if (a >= 0.7) {
    headline = 'Beaver доминирует — adoption ' + pct(a) + '. Фокус: дотюнить отстающие маршруты.';
  } else if (a >= 0.4) {
    headline = 'Adoption в середине (' + pct(a) + '). Главный рычаг — закрыть топ shadow-компонентов.';
  } else if (a > 0) {
    headline = 'Adoption низкий (' + pct(a) + '). Перед миграцией стоит понять, что переизобретено и почему.';
  } else {
    headline = 'Adoption нулевой — Beaver в коде не используется.';
  }
  document.getElementById('narrative-headline').textContent = headline;

  var bullets = [];
  bullets.push('<li><strong>Adoption A:</strong> ' + pct(a) +
    ' · <strong>Среднее по репо B:</strong> ' + pct(meanB) +
    ' (' + ruRepoPlural(perRepo.length) + ').</li>');
  if (topShadow) {
    bullets.push('<li><strong>Самый частый shadow:</strong> <code>' +
      escapeHtml(topShadow.componentName) + '</code> — ' +
      ruUsagePlural(topShadow.totalUsages) + ' в ' + ruRepoPlural(topShadow.reposCount) +
      ', уровень ' + levelBadge(topShadow.level) + '.</li>');
  }
  bullets.push('<li><strong>Confirmed shadow-групп:</strong> ' + confirmedCount + ' (из ' +
    DATA.metrics.shadowLandscape.byComponent.length + ' всего).</li>');
  if (firstRec) {
    bullets.push('<li><strong>Первый шаг:</strong> ' + escapeHtml(firstRec.title) + '.</li>');
  }
  document.getElementById('narrative-bullets').innerHTML = bullets.join('');
}

// --- Recommendations ---
function renderRecommendations() {
  var recs = DATA.recommendations || [];
  var host = document.getElementById('recs-list');
  var countEl = document.getElementById('recs-count');
  countEl.textContent = recs.length === 0 ? 'нет рекомендаций' :
    recs.length === 1 ? '1 рекомендация' :
    (recs.length >= 2 && recs.length <= 4 ? recs.length + ' рекомендации' : recs.length + ' рекомендаций');
  if (recs.length === 0) {
    host.innerHTML = '<div class="rec-empty">Метрики выглядят нейтрально — сканер ничего конкретного не советует.</div>';
    return;
  }
  host.innerHTML = recs.map(function (r) {
    return '<div class="rec-card">' +
      '<div class="rec-priority ' + escapeHtml(r.priority) + '"></div>' +
      '<div class="rec-body">' +
      '<div class="rec-title">' + escapeHtml(r.title) + '</div>' +
      '<div class="rec-rationale">' + escapeHtml(r.rationale) + '</div>' +
      '</div></div>';
  }).join('');
}

// --- Hero metrics ---
function renderHero() {
  var a = DATA.metrics.globalAdoption.value;
  var perRepo = DATA.metrics.perRepoAdoption;
  var meanB = perRepo.length > 0
    ? perRepo.reduce(function (s, r) { return s + r.value; }, 0) / perRepo.length
    : 0;
  var confirmedGroups = DATA.metrics.shadowLandscape.byComponent
    .filter(function (c) { return c.level === 'confirmed'; }).length;
  var packages = DATA.metrics.beaverCoverage.length;

  document.getElementById('metric-a').textContent = pct(a);
  document.getElementById('metric-b').textContent = pct(meanB);
  document.getElementById('metric-c').textContent = String(confirmedGroups);
  document.getElementById('metric-d').textContent = String(packages);

  document.querySelectorAll('.hero-card').forEach(function (card) {
    card.addEventListener('click', function () { openMetricModal(card.dataset.metric); });
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMetricModal(card.dataset.metric); }
    });
  });
}

// --- Metric detail modal ---
var METRIC_DEFS = {
  A: {
    title: 'Метрика A — Общий adoption',
    formula: 'A = adoptionInstances / (adoptionInstances + shadowInstances)',
    body: function () {
      var f = DATA.metrics.globalAdoption.formula || '';
      return '<p>Глобальный показатель: какая доля «решённых» usage\\'ей идёт из Beaver, а не из shadow-компонентов. <code>neither</code>-usage\\'и в знаменатель НЕ идут (PRD §7.1).</p>' +
        '<p>Текущая формула на этих данных:</p><code>' + escapeHtml(f) + '</code>' +
        '<p>Значение: <strong>' + pct(DATA.metrics.globalAdoption.value) + '</strong>.</p>';
    }
  },
  B: {
    title: 'Метрика B — Среднее по репо',
    formula: 'B = mean(A_repo) — невзвешенное среднее',
    body: function () {
      var perRepo = DATA.metrics.perRepoAdoption;
      var mean = perRepo.length ? perRepo.reduce(function (s, r) { return s + r.value; }, 0) / perRepo.length : 0;
      return '<p>Невзвешенное среднее adoption по сканированным репо. Маленькие репо весят столько же, сколько большие — это специально, иначе монорепо доминировало бы (PRD §7.2).</p>' +
        '<p>Сейчас: <strong>' + pct(mean) + '</strong> по ' + ruRepoPlural(perRepo.length) + '.</p>';
    }
  },
  C: {
    title: 'Метрика C — Confirmed shadow-группы',
    formula: 'C = count(distinct shadowGroup where level === "confirmed")',
    body: function () {
      var confirmed = DATA.metrics.shadowLandscape.byComponent.filter(function (c) { return c.level === 'confirmed'; }).length;
      var total = DATA.metrics.shadowLandscape.byComponent.length;
      return '<p>Каждая group — уникальная комбинация (имя + сигнатура пропсов + bucket markup-размера). Уровень <strong>confirmed</strong> означает: минимум один confirmed-сигнал из §5.1 + проверка против чистого primitive-name (PRD §3.5).</p>' +
        '<p>Сейчас: <strong>' + confirmed + '</strong> confirmed из ' + total + ' всех групп.</p>' +
        '<p>Низкий уровень = детекция шумит. Если confirmed &lt; 20% от total — стоит тюнить пороги (см. рекомендации).</p>';
    }
  },
  D: {
    title: 'Метрика D — Уникальных Beaver-пакетов',
    formula: 'D = count(distinct package in beaverCoverage)',
    body: function () {
      var cov = DATA.metrics.beaverCoverage;
      var top = cov.slice().sort(function (a, b) { return b.instances - a.instances; }).slice(0, 3);
      return '<p>Сколько разных Beaver-пакетов (или их обёрток через агрегаторы) фактически импортируется хоть где-то. Косвенно показывает «ширину» использования Beaver.</p>' +
        '<p>Сейчас: <strong>' + cov.length + '</strong>. Топ-3: ' +
        top.map(function (p) { return '<code>' + escapeHtml(p.package) + '</code> (' + p.instances + ')'; }).join(', ') +
        '.</p>';
    }
  }
};
function openMetricModal(key) {
  var def = METRIC_DEFS[key];
  if (!def) return;
  document.getElementById('metric-modal-title').textContent = def.title;
  document.getElementById('metric-modal-formula').textContent = def.formula;
  document.getElementById('metric-modal-body').innerHTML = def.body();
  document.getElementById('metric-modal').classList.remove('hidden');
}
function initModal() {
  var modal = document.getElementById('metric-modal');
  modal.querySelectorAll('[data-close]').forEach(function (el) {
    el.addEventListener('click', function () { modal.classList.add('hidden'); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') modal.classList.add('hidden');
  });
}

// --- Bucket donut ---
function renderDonut() {
  var host = document.getElementById('donut-host');
  var dist = DATA.metrics.bucketDistribution || { adoption: 0, shadow: 0, neither: 0 };
  var total = dist.adoption + dist.shadow + dist.neither;
  if (total === 0) {
    host.innerHTML = '<div class="donut-empty">Нет usage\\'ей для визуализации.</div>';
    return;
  }
  var R = 70, r = 48, cx = 90, cy = 90;
  var slices = [
    { key: 'adoption', value: dist.adoption, color: '#5bbf7e' },
    { key: 'shadow', value: dist.shadow, color: '#e67566' },
    { key: 'neither', value: dist.neither, color: '#9aa3b2' }
  ];
  var startAngle = -Math.PI / 2;
  var paths = '';
  for (var i = 0; i < slices.length; i++) {
    var sl = slices[i];
    if (sl.value === 0) continue;
    var frac = sl.value / total;
    var endAngle = startAngle + frac * 2 * Math.PI;
    var large = frac > 0.5 ? 1 : 0;
    var x1 = cx + R * Math.cos(startAngle), y1 = cy + R * Math.sin(startAngle);
    var x2 = cx + R * Math.cos(endAngle), y2 = cy + R * Math.sin(endAngle);
    var x3 = cx + r * Math.cos(endAngle), y3 = cy + r * Math.sin(endAngle);
    var x4 = cx + r * Math.cos(startAngle), y4 = cy + r * Math.sin(startAngle);
    var d = 'M' + x1 + ',' + y1 +
      ' A' + R + ',' + R + ' 0 ' + large + ',1 ' + x2 + ',' + y2 +
      ' L' + x3 + ',' + y3 +
      ' A' + r + ',' + r + ' 0 ' + large + ',0 ' + x4 + ',' + y4 +
      ' Z';
    var title = sl.key + ': ' + sl.value + ' (' + (frac * 100).toFixed(1) + '%)';
    paths += '<path d="' + d + '" fill="' + sl.color + '"><title>' + title + '</title></path>';
    startAngle = endAngle;
  }
  var center = '<text x="' + cx + '" y="' + (cy - 4) + '" text-anchor="middle" fill="#e6e8ee" font-size="22" font-family="ui-monospace, monospace" font-weight="600">' +
    pct(dist.adoption / total) + '</text>' +
    '<text x="' + cx + '" y="' + (cy + 14) + '" text-anchor="middle" fill="#9aa3b2" font-size="10" font-family="ui-monospace, monospace">adoption</text>';
  host.innerHTML = '<svg class="donut" width="180" height="180" viewBox="0 0 180 180">' +
    paths + center + '</svg>' +
    '<div class="donut-legend">' +
    '<div><span class="swatch" style="background:#5bbf7e"></span>adoption ' + dist.adoption + '</div>' +
    '<div><span class="swatch" style="background:#e67566"></span>shadow ' + dist.shadow + '</div>' +
    '<div><span class="swatch" style="background:#9aa3b2"></span>neither ' + dist.neither + '</div>' +
    '</div>';
}

// --- Top-shadow Pareto ---
function renderPareto() {
  var host = document.getElementById('pareto-host');
  var top = (DATA.metrics.shadowLandscape.byComponent || [])
    .slice()
    .sort(function (a, b) { return b.totalUsages - a.totalUsages; })
    .slice(0, 10);
  if (top.length === 0) {
    host.innerHTML = '<div class="pareto-empty">Shadow-компонентов нет.</div>';
    return;
  }
  var max = top[0].totalUsages || 1;
  host.innerHTML = top.map(function (g) {
    var w = (g.totalUsages / max * 100).toFixed(1);
    return '<div class="pareto-bar">' +
      '<span class="label" title="' + escapeHtml(g.componentName) + '">' +
        escapeHtml(g.componentName) + ' ' + levelBadge(g.level) + '</span>' +
      '<span class="bar"><span style="width:' + w + '%"></span></span>' +
      '<span class="count">' + g.totalUsages + '</span>' +
      '</div>';
  }).join('');
}

// --- Section tables ---
function renderPerRepo() {
  createTable(document.querySelector('[data-table="per-repo"]'), {
    rows: DATA.metrics.perRepoAdoption,
    defaultSort: { key: 'value', dir: -1 },
    csvName: 'per-repo-adoption',
    emptyText: 'Репо не сканировались.',
    columns: [
      { key: 'repoId', label: 'Репо', ellipsize: true },
      {
        key: 'value', label: 'Adoption', num: true,
        getSortValue: function (r) { return r.value; },
        render: function (r) { return adoptionBar(r.value) + pct(r.value); }
      }
    ]
  });
}
function renderPerRoute() {
  createTable(document.querySelector('[data-table="per-route"]'), {
    rows: DATA.metrics.perRouteAdoption,
    defaultSort: { key: 'value', dir: 1 },
    csvName: 'per-route-adoption',
    emptyText: 'Нет привязанных маршрутов — в сканированных репо не нашлось React Router v6 конфигов, либо все usage\\'и в shared/unmapped файлах.',
    columns: [
      { key: 'repoId', label: 'Репо', ellipsize: true },
      { key: 'routePath', label: 'Маршрут', ellipsize: true },
      {
        key: 'value', label: 'Adoption', num: true,
        getSortValue: function (r) { return r.value; },
        render: function (r) { return adoptionBar(r.value) + pct(r.value); }
      },
      {
        key: 'ratio', label: 'adoption / shadow', num: true,
        getSortValue: function (r) { return r.adoptionInstances + r.shadowInstances; },
        render: function (r) {
          return escapeHtml(r.adoptionInstances + ' / ' + r.shadowInstances);
        }
      }
    ]
  });
}
function renderShadowComponent() {
  createTable(document.querySelector('[data-table="shadow-component"]'), {
    rows: DATA.metrics.shadowLandscape.byComponent,
    defaultSort: { key: 'totalUsages', dir: -1 },
    csvName: 'shadow-by-component',
    emptyText: 'Shadow-компоненты не найдены.',
    columns: [
      { key: 'componentName', label: 'Компонент' },
      {
        key: 'level', label: 'Уровень',
        render: function (c) { return levelBadge(c.level); },
        getSortValue: function (c) {
          return { confirmed: 3, likely: 2, possible: 1 }[c.level] || 0;
        }
      },
      { key: 'reposCount', label: 'Репо', num: true,
        getSortValue: function (c) { return c.reposCount; } },
      { key: 'totalUsages', label: "Всего usage'ей", num: true,
        getSortValue: function (c) { return c.totalUsages; } },
      {
        key: 'candidateBeaverPackage', label: 'Кандидат в Beaver',
        render: function (c) {
          return c.candidateBeaverPackage
            ? escapeHtml(c.candidateBeaverPackage)
            : '<span class="muted">—</span>';
        }
      }
    ]
  });
}
function renderShadowFile() {
  createTable(document.querySelector('[data-table="shadow-file"]'), {
    rows: DATA.metrics.shadowLandscape.byFile,
    defaultSort: { key: 'usageCount', dir: -1 },
    csvName: 'shadow-by-file',
    emptyText: 'Shadow-файлов не найдено.',
    columns: [
      { key: 'repoId', label: 'Репо', ellipsize: true },
      { key: 'filePath', label: 'Файл', ellipsize: true },
      { key: 'componentName', label: 'Компонент' },
      {
        key: 'level', label: 'Уровень',
        render: function (f) { return levelBadge(f.level); },
        getSortValue: function (f) {
          return { confirmed: 3, likely: 2, possible: 1 }[f.level] || 0;
        }
      },
      { key: 'usageCount', label: "Usage'ей", num: true,
        getSortValue: function (f) { return f.usageCount; } }
    ]
  });
}
function renderCoverage() {
  createTable(document.querySelector('[data-table="coverage"]'), {
    rows: DATA.metrics.beaverCoverage,
    defaultSort: { key: 'instances', dir: -1 },
    csvName: 'beaver-coverage',
    emptyText: 'В коде не найдено импортов Beaver-пакетов.',
    columns: [
      { key: 'package', label: 'Пакет', ellipsize: true },
      { key: 'reposUsing', label: 'Репо использует', num: true,
        getSortValue: function (c) { return c.reposUsing; } },
      { key: 'instances', label: 'Использований', num: true,
        getSortValue: function (c) { return c.instances; } }
    ]
  });
}
function renderSharedComponents() {
  createTable(document.querySelector('[data-table="shared"]'), {
    rows: DATA.metrics.sharedComponentsAdoption,
    defaultSort: { key: 'routesCount', dir: -1 },
    csvName: 'shared-components',
    emptyText: 'Shared-компонентов нет.',
    columns: [
      { key: 'repoId', label: 'Репо', ellipsize: true },
      { key: 'filePath', label: 'Файл', ellipsize: true },
      { key: 'componentName', label: 'Компонент' },
      {
        key: 'bucket', label: 'Bucket',
        render: function (s) { return bucketBadge(s.bucket); }
      },
      {
        key: 'routesCount', label: 'Маршрутов', num: true,
        getSortValue: function (s) { return s.sharedAcrossRoutes.length; },
        render: function (s) { return String(s.sharedAcrossRoutes.length); }
      }
    ]
  });
}

function renderInvariantsAndWarnings() {
  var inv = DATA.invariants;
  var label = inv.failed === 0
    ? inv.checked + " usage'ей проверено · все инварианты выполняются"
    : inv.failed + ' нарушений среди ' + inv.checked + " usage'ей";
  document.getElementById('invariants-summary').textContent = label;
  var warnings = DATA.warnings || [];
  var violationsBlock = document.getElementById('violations-block');
  var hasWarnings = warnings.length > 0 || inv.violations.length > 0;
  var toggle = document.getElementById('warnings-toggle');
  var body = document.getElementById('warnings-body');

  if (!hasWarnings) {
    violationsBlock.innerHTML = '';
    toggle.textContent = 'Чисто';
    toggle.disabled = true;
    return;
  }

  toggle.textContent = 'Показать (' + (warnings.length + inv.violations.length) + ')';
  toggle.addEventListener('click', function () {
    body.classList.toggle('hidden');
    var expanded = !body.classList.contains('hidden');
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.textContent = expanded
      ? 'Скрыть'
      : 'Показать (' + (warnings.length + inv.violations.length) + ')';
  });

  var html = '';
  if (inv.violations.length > 0) {
    html += '<p><strong>Нарушения инвариантов:</strong></p>';
    html += inv.violations.map(function (v) {
      return '<div class="violation-row">' +
        escapeHtml(v.code) + ' × ' + v.count + ' — ' + escapeHtml(v.message) + '</div>';
    }).join('');
  }
  violationsBlock.innerHTML = html;

  if (warnings.length > 0) {
    createTable(document.getElementById('warnings-list-host'), {
      rows: warnings,
      pageSize: 100,
      defaultSort: { key: 'code', dir: 1 },
      csvName: 'warnings',
      emptyText: 'Предупреждений нет.',
      columns: [
        { key: 'code', label: 'Код' },
        { key: 'repoId', label: 'Репо', ellipsize: true,
          render: function (w) { return w.repoId ? escapeHtml(w.repoId) : '<span class="muted">—</span>'; } },
        { key: 'filePath', label: 'Файл', ellipsize: true,
          render: function (w) { return w.filePath ? escapeHtml(w.filePath) : '<span class="muted">—</span>'; } },
        { key: 'message', label: 'Сообщение', ellipsize: true,
          render: function (w) { return escapeHtml(w.message); } }
      ]
    });
  }
}

function bindShadowTabs() {
  var tabs = document.querySelectorAll('#panel-shadow .tab');
  var hostByComp = document.querySelector('[data-table="shadow-component"]');
  var hostByFile = document.querySelector('[data-table="shadow-file"]');
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      if (tab.dataset.view === 'byFile') {
        hostByComp.classList.add('hidden');
        hostByFile.classList.remove('hidden');
      } else {
        hostByFile.classList.add('hidden');
        hostByComp.classList.remove('hidden');
      }
    });
  });
}

// --- Glossary popover ---
var GLOSSARY = {
  adoption: {
    title: 'Adoption',
    body: 'Доля «решённых» usage\\'ей, идущих из Beaver, vs локальных shadow-компонентов. Формула: <code>adoption / (adoption + shadow)</code>. Usage\\'и из чужих либ (<code>neither</code>) не считаются.'
  },
  shadow: {
    title: 'Shadow-компонент',
    body: 'Локальный компонент, который дублирует функционал Beaver-примитива. Определяется набором сигналов (§5.1): primitive-like-name, substantial-markup, wraps-with-customization и т.д. Бывает трёх уровней: confirmed / likely / possible.'
  },
  bucket: {
    title: 'Bucket',
    body: 'Категория usage\\'а после классификации: <code>adoption</code> (из Beaver, не кастомизированный), <code>shadow</code> (локальная альтернатива), <code>neither</code> (чужая либа). Каждый usage попадает в ровно одну bucket (инвариант §10.1 #1).'
  },
  'shadow-level': {
    title: 'Уровни shadow',
    body: '<strong>Confirmed</strong> — есть как минимум один сильный сигнал (§5.1.A). <strong>Likely</strong> — несколько слабых сигналов. <strong>Possible</strong> — только эвристика по имени или одиночный слабый сигнал. Тюнинг порогов см. в <code>thresholds.*</code> конфига.'
  },
  shared: {
    title: 'Shared-компонент',
    body: 'Файл, который достижим из import-графа двух+ page-компонентов. По PRD §7.5 такие usage\\'и НЕ идут в знаменатель метрики E, но трекаются отдельно — переписать один общий хедер дешевле, чем 30 страничных копий.'
  }
};
function initGlossary() {
  var pop = document.getElementById('glossary-pop');
  document.querySelectorAll('.info-pill').forEach(function (pill) {
    pill.addEventListener('click', function (e) {
      e.stopPropagation();
      var key = pill.dataset.glossary;
      var entry = GLOSSARY[key];
      if (!entry) return;
      document.getElementById('glossary-title').textContent = entry.title;
      document.getElementById('glossary-body').innerHTML = entry.body;
      var rect = pill.getBoundingClientRect();
      pop.style.top = (window.scrollY + rect.bottom + 6) + 'px';
      var left = window.scrollX + rect.left;
      var maxLeft = window.scrollX + window.innerWidth - 340;
      pop.style.left = Math.min(left, maxLeft) + 'px';
      pop.classList.remove('hidden');
    });
  });
  document.addEventListener('click', function () { pop.classList.add('hidden'); });
  pop.addEventListener('click', function (e) { e.stopPropagation(); });
}

// --- FAQ ---
var FAQ = [
  {
    q: 'Чем «adoption» отличается от «shadow»?',
    a: 'Adoption — usage импортирует Beaver-компонент и НЕ кастомизирует его (нет <code>className</code>, <code>style</code>, runtime-обёртки). Shadow — локальный компонент с признаками того, что он переизобретает примитив (имя «Button/Card/Input», substantial markup, wraps Beaver с кастомизацией). Один usage не может быть в обеих категориях — это инвариант §10.1 #1.'
  },
  {
    q: 'Почему мой <code>&lt;Button className="..." /&gt;</code> попал в shadow?',
    a: 'По PRD §3.6 любая кастомизация Beaver-импорта (className, style, sx) переводит usage в shadow — даже если сам импорт из Beaver. Это пуристский подход: если ты докрасил кнопку через className, ты создал локальную «не совсем-Beaver»-версию.'
  },
  {
    q: 'Какие уровни shadow и что они значат?',
    a: '<strong>confirmed</strong> = сильный сигнал (substantial markup + primitive-name, или wraps-with-customization). <strong>likely</strong> = два-три слабых сигнала. <strong>possible</strong> = только эвристика по имени. Для рекомендаций по миграции смотри сначала confirmed.'
  },
  {
    q: 'Почему таблица «по маршрутам» пустая?',
    a: 'Скорее всего в сканированных репо: (a) нет React Router v6 конфига, (b) есть Routes, но все usage-файлы достижимы из 2+ страниц (shared), (c) роуты заданы способом, не покрытым в M4 (Next.js App Router пока не поддерживается). Смотри warnings — там будет код <code>route-resolver-*</code>.'
  },
  {
    q: 'Adoption у меня 20%. Что делать первым?',
    a: 'Открой карточку «Что советует сканер» (наверху). Топ-рекомендация обычно — конкретный shadow-компонент, повторяющийся в N репо. Добавить его в Beaver = убить N миграций одним PR. Дальше смотри топ Pareto chart shadow-компонентов.'
  },
  {
    q: 'Как сканер определил, что мой <code>@my-lib/button</code> — это «обёртка над Beaver»?',
    a: 'Этап Prescan (Stage 5): сканер AST-парсит файлы локальной либы, видит её re-export из <code>@beaver-ui/core</code> и канонизирует через агрегатор. Подробности — в <code>docs/руководство.md</code> §«Канонизация импортов».'
  },
  {
    q: 'Что такое sharedLibraries и почему они не идут в метрику E?',
    a: 'Если компонент используется на 2+ маршрутах, его usage\\'и формально нельзя «приписать» одному маршруту. PRD §7.5 решает это так: shared не считаются в знаменатель E, но трекаются в отдельной секции «Shared-компоненты». В стратегии миграции shared = «дорогая» цель: одна правка влияет на много маршрутов.'
  },
  {
    q: 'Как формируются рекомендации?',
    a: 'Алгоритм в <code>src/pipeline/recommendations.ts</code>. Четыре правила: (1) shadow-группа в ≥ N репо → add-to-beaver, (2) репо с adoption &lt; X% → outreach, (3) Beaver-пакет в &lt; Y% репо → promote, (4) possible &gt;&gt; confirmed → tune-thresholds. Пороги в конфиге, секция <code>recommendations</code>.'
  },
  {
    q: 'Разные запуски на одних данных дают разный отчёт — это баг?',
    a: 'Да. Детерминизм — инвариант (§8.4). Повторный запуск на тех же commit\\'ах фикстур должен дать байт-идентичный <code>dataset.jsonl</code>. Если diff не пустой — заводи issue. Тест на это: <code>describe(\\'determinism\\')</code> в <code>tests/pipeline.test.ts</code>.'
  },
  {
    q: 'У меня 50k+ shadow usage\\'ей — отчёт лагает.',
    a: 'Открой Developer Tools → Network → проверь размер HTML. Если &gt; 50 МБ — конфиг <code>thresholds.maxShadowRows</code> можно понизить, либо запустить с <code>--no-html</code> и работать с JSONL через jq/duckdb. Таблицы пагинируются, но JS-парсинг 100k+ объектов всё равно долгий.'
  },
  {
    q: 'JSX элемент вида <code>&lt;namespace.Component /&gt;</code> — он покрыт?',
    a: 'Да, member-expression resolver (M2.4) умеет резолвить <code>UI.Button</code>, <code>icons.X</code>. Через несколько уровней обёрток (depth ≤ 5) и алиасов тоже. Если не покрыт — отдельный warning <code>jsx-member-unresolved</code>.'
  },
  {
    q: 'FP-rate какой?',
    a: 'Целевой ≤ 15% (PRD §1.5). Считается на 50-компонентной ручной выборке после M7. До M7 — сканер ещё в режиме «строгий, может перестраховаться».'
  },
  {
    q: 'Как выгрузить данные таблицы наружу?',
    a: 'Кнопка «⬇ CSV» в каждой таблице. Экспортирует ТЕКУЩИЙ вид — с фильтром, сортировкой, но БЕЗ пагинации (все отфильтрованные строки). Полные данные — в <code>aggregates.json</code> рядом с отчётом.'
  }
];
function renderFaq() {
  var host = document.getElementById('faq-list');
  host.innerHTML = FAQ.map(function (item, i) {
    return '<div class="faq-item" data-i="' + i + '">' +
      '<div class="faq-q">' + item.q + '</div>' +
      '<div class="faq-a">' + item.a + '</div>' +
      '</div>';
  }).join('');
  host.querySelectorAll('.faq-q').forEach(function (q) {
    q.addEventListener('click', function () {
      q.parentElement.classList.toggle('open');
    });
  });
}

// --- Boot ---
initPersona();
initPermalink();
initOnboarding();
renderMeta();
renderNarrative();
renderRecommendations();
renderHero();
renderDonut();
renderPareto();
renderPerRoute();
renderPerRepo();
renderShadowComponent();
renderShadowFile();
renderCoverage();
renderSharedComponents();
renderInvariantsAndWarnings();
renderFaq();
bindShadowTabs();
initModal();
initGlossary();
`;
