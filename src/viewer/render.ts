import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Aggregates } from '../types/dataset.js';

/**
 * Render self-contained HTML (§6.3).
 * One file, inline CSS/JS, aggregates data injected as a JS object — no fetch.
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
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Beaver Adoption Report</title>
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
      <div class="hero-label">Global Adoption</div>
      <div class="hero-value" id="metric-a">—</div>
      <div class="hero-hint">adoption / (adoption + shadow)</div>
    </div>
    <div class="hero-card" data-metric="B">
      <div class="hero-label">Per-repo mean</div>
      <div class="hero-value" id="metric-b">—</div>
      <div class="hero-hint">average across repos</div>
    </div>
    <div class="hero-card" data-metric="C">
      <div class="hero-label">Confirmed shadow</div>
      <div class="hero-value" id="metric-c">—</div>
      <div class="hero-hint">distinct shadow groups</div>
    </div>
    <div class="hero-card" data-metric="D">
      <div class="hero-label">Beaver packages seen</div>
      <div class="hero-value" id="metric-d">—</div>
      <div class="hero-hint">unique packages imported</div>
    </div>
  </section>

  <section class="panel">
    <h2>E — Per-route adoption</h2>
    <p class="muted">Adoption per (repo, route) — counts only usages whose file is bound to exactly one route (§7.5). Surfaced first because routes are how product teams reason about adoption: "/checkout looks worse than /admin".</p>
    <table class="data-table" id="per-route-table">
      <thead>
        <tr>
          <th>Repo</th>
          <th>Route</th>
          <th class="num">Adoption</th>
          <th class="num">adoption / shadow</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </section>

  <section class="panel">
    <h2>B — Per-repo adoption</h2>
    <table class="data-table" id="per-repo-table">
      <thead><tr><th>Repo</th><th class="num">Adoption</th></tr></thead>
      <tbody></tbody>
    </table>
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>C — Shadow landscape</h2>
      <div class="tabs" role="tablist">
        <button class="tab active" data-view="byComponent" role="tab">Per-component</button>
        <button class="tab" data-view="byFile" role="tab">Per-file</button>
      </div>
    </div>
    <table class="data-table" id="shadow-component-table">
      <thead>
        <tr>
          <th>Component</th>
          <th>Level</th>
          <th class="num">Repos</th>
          <th class="num">Total usages</th>
          <th>Candidate Beaver package</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
    <table class="data-table hidden" id="shadow-file-table">
      <thead>
        <tr>
          <th>Repo</th>
          <th>File</th>
          <th>Component</th>
          <th>Level</th>
          <th class="num">Usages</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </section>

  <section class="panel">
    <h2>D — Beaver package coverage</h2>
    <table class="data-table" id="coverage-table">
      <thead>
        <tr>
          <th>Package</th>
          <th class="num">Repos using</th>
          <th class="num">Instances</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </section>

  <section class="panel">
    <h2>Shared components</h2>
    <p class="muted">Files reachable from 2+ page components — these usages don't count toward any single-route metric E (§7.5) but are important for adoption strategy.</p>
    <table class="data-table" id="shared-components-table">
      <thead>
        <tr>
          <th>Repo</th>
          <th>File</th>
          <th>Component</th>
          <th>Bucket</th>
          <th class="num">Routes</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </section>

  <section class="panel footnote">
    <h2>Warnings &amp; invariants</h2>
    <p><strong>Invariants:</strong> <span id="invariants-summary">—</span></p>
    <div id="warnings-block"></div>
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
main { max-width: 1200px; margin: 0 auto; padding: 32px 24px 80px; }
h2 { font-size: 14px; font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--fg-dim); margin: 0 0 16px; }
.page-header { display: flex; justify-content: space-between; align-items: flex-end;
  padding-bottom: 24px; border-bottom: 1px solid var(--panel-border); margin-bottom: 32px;
}
.brand-mark { font-family: var(--mono); font-size: 22px; font-weight: 700;
  letter-spacing: 0.1em; color: var(--accent); display: block; }
.brand-sub { font-size: 12px; color: var(--fg-dim); letter-spacing: 0.1em;
  text-transform: uppercase; }
.meta { font-family: var(--mono); font-size: 12px; color: var(--fg-dim);
  text-align: right; line-height: 1.7; }
.meta strong { color: var(--fg); font-weight: 600; }
.hero { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 32px; }
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
  margin-bottom: 16px; }
.panel-head h2 { margin: 0; }
.tabs { display: flex; gap: 4px; background: var(--bg); padding: 3px; border-radius: 6px;
  border: 1px solid var(--panel-border); }
.tab { background: transparent; color: var(--fg-dim); border: 0; cursor: pointer;
  padding: 6px 12px; font-size: 12px; border-radius: 4px; font-family: inherit;
  letter-spacing: 0.02em; }
.tab.active { background: var(--accent-soft); color: var(--accent); }
.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.data-table th, .data-table td { text-align: left; padding: 8px 12px;
  border-bottom: 1px solid var(--panel-border); }
.data-table th { font-weight: 600; color: var(--fg-dim); font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.06em; }
.data-table td { font-family: var(--mono); }
.data-table td.num, .data-table th.num { text-align: right; font-variant-numeric: tabular-nums; }
.data-table tbody tr:hover { background: rgba(244, 169, 74, 0.04); }
.data-table tbody tr:last-child td { border-bottom: 0; }
.hidden { display: none !important; }
.muted { color: var(--fg-dim); font-size: 13px; margin: 0; }
.footnote { font-size: 12px; }
.level-badge { display: inline-block; padding: 1px 8px; border-radius: 999px;
  font-size: 11px; font-family: var(--mono); letter-spacing: 0.02em; }
.level-confirmed { background: rgba(230, 117, 102, 0.15); color: var(--bad); }
.level-likely { background: rgba(232, 196, 106, 0.15); color: var(--warn); }
.level-possible { background: rgba(154, 163, 178, 0.12); color: var(--fg-dim); }
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
function td(value, cls) {
  return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + value + '</td>';
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderMeta() {
  var m = DATA.meta;
  document.getElementById('meta').innerHTML =
    '<div>Scanned <strong>' + escapeHtml(m.scannedAt) + '</strong></div>' +
    '<div>Beaver <strong>' + escapeHtml(m.beaverVersion) + '</strong></div>' +
    '<div><strong>' + m.reposScanned + '</strong> repos · <strong>' + m.filesScanned + '</strong> files · ' +
    (m.scanDurationMs / 1000).toFixed(2) + 's</div>';
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
  var tbody = document.querySelector('#per-repo-table tbody');
  tbody.innerHTML = DATA.metrics.perRepoAdoption.map(function (r) {
    var bar = '<span class="adoption-bar"><span style="width:' + (r.value * 100).toFixed(1) + '%"></span></span>';
    return '<tr>' + td(escapeHtml(r.repoId)) + td(bar + pct(r.value), 'num') + '</tr>';
  }).join('') || '<tr><td colspan="2" class="muted">No repos scanned.</td></tr>';
}

function renderShadowComponent() {
  var tbody = document.querySelector('#shadow-component-table tbody');
  var rows = DATA.metrics.shadowLandscape.byComponent;
  tbody.innerHTML = rows.map(function (c) {
    return '<tr>' +
      td(escapeHtml(c.componentName)) +
      td(levelBadge(c.level)) +
      td(String(c.reposCount), 'num') +
      td(String(c.totalUsages), 'num') +
      td(c.candidateBeaverPackage ? escapeHtml(c.candidateBeaverPackage) : '<span class="muted">—</span>') +
      '</tr>';
  }).join('') || '<tr><td colspan="5" class="muted">No shadow components detected.</td></tr>';
}

function renderShadowFile() {
  var tbody = document.querySelector('#shadow-file-table tbody');
  var rows = DATA.metrics.shadowLandscape.byFile;
  tbody.innerHTML = rows.map(function (f) {
    return '<tr>' +
      td(escapeHtml(f.repoId)) +
      td(escapeHtml(f.filePath)) +
      td(escapeHtml(f.componentName)) +
      td(levelBadge(f.level)) +
      td(String(f.usageCount), 'num') +
      '</tr>';
  }).join('') || '<tr><td colspan="5" class="muted">No shadow files detected.</td></tr>';
}

function renderCoverage() {
  var tbody = document.querySelector('#coverage-table tbody');
  tbody.innerHTML = DATA.metrics.beaverCoverage.map(function (c) {
    return '<tr>' +
      td(escapeHtml(c.package)) +
      td(String(c.reposUsing), 'num') +
      td(String(c.instances), 'num') +
      '</tr>';
  }).join('') || '<tr><td colspan="3" class="muted">No Beaver packages detected in scanned code.</td></tr>';
}

function renderPerRoute() {
  var tbody = document.querySelector('#per-route-table tbody');
  var rows = DATA.metrics.perRouteAdoption;
  tbody.innerHTML = rows.map(function (r) {
    var bar = '<span class="adoption-bar"><span style="width:' + (r.value * 100).toFixed(1) + '%"></span></span>';
    var ratio = r.adoptionInstances + ' / ' + r.shadowInstances;
    return '<tr>' +
      td(escapeHtml(r.repoId)) +
      td(escapeHtml(r.routePath)) +
      td(bar + pct(r.value), 'num') +
      td(ratio, 'num') +
      '</tr>';
  }).join('') || '<tr><td colspan="4" class="muted">No bound routes yet — no repos with router configs scanned.</td></tr>';
}

function renderSharedComponents() {
  var tbody = document.querySelector('#shared-components-table tbody');
  var rows = DATA.metrics.sharedComponentsAdoption;
  tbody.innerHTML = rows.map(function (s) {
    return '<tr>' +
      td(escapeHtml(s.repoId)) +
      td(escapeHtml(s.filePath)) +
      td(escapeHtml(s.componentName)) +
      td(escapeHtml(s.bucket)) +
      td(String(s.sharedAcrossRoutes.length), 'num') +
      '</tr>';
  }).join('') || '<tr><td colspan="5" class="muted">No shared components detected.</td></tr>';
}

function renderInvariants() {
  var inv = DATA.invariants;
  var label = inv.failed === 0
    ? inv.checked + ' usages checked · all invariants hold'
    : inv.failed + ' violation(s) across ' + inv.checked + ' usages';
  document.getElementById('invariants-summary').textContent = label;
  var warnings = DATA.warnings || [];
  var block = document.getElementById('warnings-block');
  if (warnings.length === 0 && inv.violations.length === 0) {
    block.innerHTML = '<p class="muted">No warnings.</p>';
    return;
  }
  var html = '';
  if (inv.violations.length > 0) {
    html += '<p><strong>Invariant violations:</strong></p>';
    html += inv.violations.map(function (v) {
      return '<div class="violation-row">' +
        escapeHtml(v.code) + ' × ' + v.count + ' — ' + escapeHtml(v.message) + '</div>';
    }).join('');
  }
  if (warnings.length > 0) {
    html += '<p><strong>Scan warnings:</strong></p>';
    html += warnings.slice(0, 50).map(function (w) {
      var loc = w.filePath ? ' @ ' + escapeHtml(w.filePath) : '';
      return '<div class="violation-row">' +
        escapeHtml(w.code) + loc + ' — ' + escapeHtml(w.message) + '</div>';
    }).join('');
    if (warnings.length > 50) {
      html += '<p class="muted">(' + (warnings.length - 50) + ' more — see warnings.json)</p>';
    }
  }
  block.innerHTML = html;
}

function bindTabs() {
  var tabs = document.querySelectorAll('.tab');
  var byComp = document.getElementById('shadow-component-table');
  var byFile = document.getElementById('shadow-file-table');
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      if (tab.dataset.view === 'byFile') {
        byComp.classList.add('hidden');
        byFile.classList.remove('hidden');
      } else {
        byFile.classList.add('hidden');
        byComp.classList.remove('hidden');
      }
    });
  });
}

renderMeta();
renderHero();
renderPerRepo();
renderShadowComponent();
renderShadowFile();
renderCoverage();
renderPerRoute();
renderSharedComponents();
renderInvariants();
bindTabs();
`;
