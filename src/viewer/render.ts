import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Aggregates } from '../types/dataset.js';

/**
 * Render self-contained HTML (§6.3).
 * One file, inline CSS/JS, aggregates data injected as a JS object — no fetch.
 *
 * Designed to stay readable when scaled to real-world repos (10k+ shadow
 * components, 100s of routes, 10k+ warnings):
 *   - per-table pagination (default 50 rows/page, configurable up to All)
 *   - per-table free-text filter (debounced, всем строковым колонкам)
 *   - click-to-sort columns (asc → desc → none cycle)
 *   - long path cells truncated with full path on hover
 *   - warnings section collapsed by default when > 20 entries
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
<body>
<main id="app">
  <header class="page-header">
    <div class="brand">
      <span class="brand-mark">BEAVER</span>
      <span class="brand-sub">Adoption Scanner</span>
    </div>
    <div class="meta" id="meta"></div>
  </header>

  <section class="hero">
    <div class="hero-card" data-metric="A">
      <div class="hero-label">A — Общий adoption</div>
      <div class="hero-value" id="metric-a">—</div>
      <div class="hero-hint">adoption / (adoption + shadow)</div>
    </div>
    <div class="hero-card" data-metric="B">
      <div class="hero-label">B — Среднее по репо</div>
      <div class="hero-value" id="metric-b">—</div>
      <div class="hero-hint">невзвешенное по сканированным репо</div>
    </div>
    <div class="hero-card" data-metric="C">
      <div class="hero-label">C — Confirmed shadow</div>
      <div class="hero-value" id="metric-c">—</div>
      <div class="hero-hint">различных групп shadow-компонентов</div>
    </div>
    <div class="hero-card" data-metric="D">
      <div class="hero-label">D — Beaver-пакетов</div>
      <div class="hero-value" id="metric-d">—</div>
      <div class="hero-hint">уникальных пакетов в импортах</div>
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
      <h2>C — Карта shadow-компонентов</h2>
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
    <h2>Shared-компоненты</h2>
    <p class="muted">
      Файлы, достижимые от двух и более page-компонентов. Эти usage'и не идут
      в знаменатель метрики E (§7.5), но важны для adoption-стратегии:
      переписать один хедер дешевле, чем 30 страниц.
    </p>
    <div class="table-host" data-table="shared"></div>
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
.page-header { display: flex; justify-content: space-between; align-items: flex-end;
  padding-bottom: 24px; border-bottom: 1px solid var(--panel-border); margin-bottom: 32px;
  flex-wrap: wrap; gap: 16px;
}
.brand-mark { font-family: var(--mono); font-size: 22px; font-weight: 700;
  letter-spacing: 0.1em; color: var(--accent); display: block; }
.brand-sub { font-size: 12px; color: var(--fg-dim); letter-spacing: 0.1em;
  text-transform: uppercase; }
.meta { font-family: var(--mono); font-size: 12px; color: var(--fg-dim);
  text-align: right; line-height: 1.7; }
.meta strong { color: var(--fg); font-weight: 600; }
.hero { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 32px; }
@media (max-width: 800px) { .hero { grid-template-columns: repeat(2, 1fr); } }
.hero-card { background: var(--panel); border: 1px solid var(--panel-border);
  border-radius: 8px; padding: 20px; position: relative; overflow: hidden; }
.hero-card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 3px;
  background: var(--accent); opacity: 0.6; }
.hero-label { font-size: 12px; color: var(--fg-dim); text-transform: uppercase;
  letter-spacing: 0.08em; }
.hero-value { font-family: var(--mono); font-size: 32px; font-weight: 600;
  margin: 8px 0 4px; color: var(--fg); }
.hero-hint { font-size: 11px; color: var(--fg-dim); font-family: var(--mono); }
.panel { background: var(--panel); border: 1px solid var(--panel-border);
  border-radius: 8px; padding: 20px 24px; margin-bottom: 24px; }
.panel-head { display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 16px; flex-wrap: wrap; gap: 12px; }
.panel-head h2 { margin: 0; }
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

.hidden { display: none !important; }
.muted { color: var(--fg-dim); font-size: 13px; margin: 0 0 12px; }
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

// --- DataTable: reusable controller for filter/sort/pagination ---
function createTable(host, opts) {
  // opts: { rows, columns, pageSize?, emptyText?, defaultSort? }
  // columns: [{ key, label, render?, sortable?, getSortValue?, num?, ellipsize? }]
  var state = {
    rows: opts.rows || [],
    columns: opts.columns,
    pageSize: opts.pageSize || 50,
    page: 0,
    filter: '',
    sortKey: opts.defaultSort ? opts.defaultSort.key : null,
    sortDir: opts.defaultSort ? opts.defaultSort.dir : 1, // 1 asc, -1 desc, 0 none
    emptyText: opts.emptyText || 'Данных нет.'
  };

  function getCellString(row, col) {
    var rendered = col.render ? col.render(row) : row[col.key];
    if (rendered === null || rendered === undefined) return '';
    // For filter — strip tags. Cheap & cheerful: render() may return HTML.
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
      return typeof v === 'number' ? v : String(v ?? '').toLowerCase();
    };
    var dir = state.sortDir;
    return rows.slice().sort(function (a, b) {
      var av = getter(a), bv = getter(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
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
            var plain = String(raw ?? '').replace(/<[^>]+>/g, '');
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
    host.querySelectorAll('th.sortable').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.dataset.col;
        if (state.sortKey === key) {
          // cycle: asc → desc → none
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

// --- Section renderers ---

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
}

function renderPerRepo() {
  createTable(document.querySelector('[data-table="per-repo"]'), {
    rows: DATA.metrics.perRepoAdoption,
    defaultSort: { key: 'value', dir: -1 },
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
      { key: 'totalUsages', label: 'Всего usage\\'ей', num: true,
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
      { key: 'usageCount', label: 'Usage\\'ей', num: true,
        getSortValue: function (f) { return f.usageCount; } }
    ]
  });
}

function renderCoverage() {
  createTable(document.querySelector('[data-table="coverage"]'), {
    rows: DATA.metrics.beaverCoverage,
    defaultSort: { key: 'instances', dir: -1 },
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
    ? inv.checked + ' usage\\'ей проверено · все инварианты выполняются'
    : inv.failed + ' нарушений среди ' + inv.checked + ' usage\\'ей';
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

renderMeta();
renderHero();
renderPerRoute();
renderPerRepo();
renderShadowComponent();
renderShadowFile();
renderCoverage();
renderSharedComponents();
renderInvariantsAndWarnings();
bindShadowTabs();
`;
