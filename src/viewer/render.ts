import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Aggregates } from '../types/dataset.js';

/**
 * Self-contained interactive HTML report.
 *
 * One file, inline CSS/JS, aggregates injected as a JS object — no fetch,
 * no external network. Sections:
 *
 *   - Hero: четыре ключевых числа (adoption, среднее по репо,
 *     shadow-групп, Beaver-пакетов). Клик по карточке → модалка с формулой.
 *   - Сводка: автоматически собранный headline + 2–3 bullet'а.
 *   - Рекомендации: что делать первым, с раскрывающейся детализацией
 *     (полные списки репо / пакетов / компонентов).
 *   - Визуализация: donut по bucket'ам и Pareto топ-10 shadow.
 *   - Таблицы: маршруты, репо, shadow, покрытие, shared. У каждой —
 *     поиск, сортировка, пагинация, экспорт в CSV.
 *   - Методология + FAQ + глоссарий: чтобы фрешевый зритель ответил
 *     «что такое shadow», «как считается adoption» прямо в файле.
 *   - Проверки данных: статус инвариантов в человеческой формулировке.
 *
 * Инженерные детали:
 *   - JSON-инъекция экранирует `<`, `>`, `&`, U+2028, U+2029.
 *   - createTable использует mount+paint: фильтр-инпут строится один раз
 *     и не пересоздаётся, чтобы не сбивать фокус при печати.
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
    <div class="hero-card" data-metric="adoption" tabindex="0" role="button">
      <div class="hero-label">Adoption <span class="info-pill" data-glossary="adoption">?</span></div>
      <div class="hero-value" id="metric-adoption">—</div>
      <div class="hero-hint">из всех «решённых» юзеджей — доля Beaver</div>
    </div>
    <div class="hero-card" data-metric="perRepo" tabindex="0" role="button">
      <div class="hero-label">Среднее по репо</div>
      <div class="hero-value" id="metric-per-repo">—</div>
      <div class="hero-hint">репо весят одинаково, монорепо не доминирует</div>
    </div>
    <div class="hero-card" data-metric="shadow" tabindex="0" role="button">
      <div class="hero-label">Shadow-компонентов <span class="info-pill" data-glossary="shadow">?</span></div>
      <div class="hero-value" id="metric-shadow">—</div>
      <div class="hero-hint">переизобретений Beaver-примитивов</div>
    </div>
    <div class="hero-card" data-metric="packages" tabindex="0" role="button">
      <div class="hero-label">Beaver-пакетов в коде</div>
      <div class="hero-value" id="metric-packages">—</div>
      <div class="hero-hint">сколько разных пакетов реально используется</div>
    </div>
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
      Подсказки, куда смотреть первым. Сортировка по приоритету: красный
      кружок — действовать сейчас, жёлтый — на следующей неделе, синий —
      когда руки дойдут. Кнопка «Показать все…» под рекомендацией разворачивает
      полный список репо или пакетов.
    </p>
    <div id="recs-list"></div>
  </section>

  <section class="panel categories" id="panel-categories">
    <h2>Что значит adoption, shadow и neither</h2>
    <p class="muted">
      Это три категории, в которые сканер раскладывает каждое JSX-использование
      компонента. Все метрики выше — это пересчёты по этим категориям; если
      непонятно, что показывают числа в шапке, начинать читать стоит отсюда.
    </p>

    <div class="cat-grid">
      <div class="cat-card cat-adoption">
        <div class="cat-title"><span class="cat-dot"></span>adoption</div>
        <p class="cat-summary"><strong>Используешь Beaver как есть.</strong> Компонент пришёл из Beaver-пакета (или из локальной либы, которая внутри re-export'ит Beaver — это считается тем же) и не кастомизирован — без своих стилей сверху.</p>
        <pre class="cat-example"><code>import { Button } from '@beaver-ui/core';
&lt;Button onClick={handler}&gt;Привет&lt;/Button&gt;</code></pre>
        <p class="cat-note">Цель — чтобы доля adoption росла.</p>
      </div>

      <div class="cat-card cat-shadow">
        <div class="cat-title"><span class="cat-dot"></span>shadow</div>
        <p class="cat-summary"><strong>Локальное переизобретение Beaver-примитива.</strong> Бывает в трёх формах:</p>
        <ol class="cat-forms">
          <li><strong>Переписан с нуля</strong> — локальный компонент с именем «Button», «Card», «Input» и развёрнутой разметкой внутри.</li>
          <li><strong>Обёртка с кастомизацией</strong> — импортируешь Beaver, накидываешь свои стили через <code>className</code>, <code>style</code> или <code>sx</code>. Сам импорт из Beaver, но фактически появляется «не-совсем-Beaver» версия.</li>
          <li><strong>Standalone styled</strong> — компонент через <code>styled-components</code> или <code>emotion</code> в роли примитива.</li>
        </ol>
        <pre class="cat-example"><code>&lt;Button className="my-red"&gt;...&lt;/Button&gt;  // обёртка → shadow
const Button = styled.button\`...\`            // свой → shadow</code></pre>
        <p class="cat-note">Цель — мигрировать на Beaver или добавить shadow в Beaver, если он повторяется.</p>
      </div>

      <div class="cat-card cat-neither">
        <div class="cat-title"><span class="cat-dot"></span>neither</div>
        <p class="cat-summary"><strong>Всё остальное.</strong> Бизнес-компоненты (<code>UserCard</code>, <code>DealForm</code>), чужие либы без признаков UI-примитива. В метрику adoption не идут — это «не наша зона ответственности».</p>
        <pre class="cat-example"><code>&lt;UserCard user={u} /&gt;       // бизнес-логика
&lt;DataGrid data={rows} /&gt;    // чужая либа</code></pre>
        <p class="cat-note">Не двигаем — просто учитываем, что они есть.</p>
      </div>
    </div>

    <div class="formula-block">
      <strong>Формула общего adoption:</strong>
      <code>adoption / (adoption + shadow)</code>
      <span class="formula-note">— neither в знаменатель не идёт</span>
    </div>
  </section>

  <section class="panel viz-panel" id="panel-viz">
    <div class="panel-head">
      <h2>Распределение использований <span class="info-pill" data-glossary="bucket">?</span></h2>
    </div>
    <div class="viz-grid">
      <div class="viz-cell">
        <h4>Категории всех юзеджей</h4>
        <div id="donut-host"></div>
      </div>
      <div class="viz-cell">
        <h4>Топ-10 shadow по числу использований</h4>
        <div id="pareto-host"></div>
      </div>
    </div>
  </section>

  <section class="panel" id="panel-per-route">
    <h2>Adoption по маршрутам</h2>
    <p class="muted">
      Adoption по парам «репо + маршрут». В знаменатель идут только юзеджи из
      файлов, привязанных к одному конкретному маршруту. Продуктовым
      командам так удобнее: «<code>/checkout</code> хуже, чем <code>/admin</code>»
      понять проще, чем «adoption 67%».
    </p>
    <div class="table-host" data-table="per-route"></div>
  </section>

  <section class="panel" id="panel-per-repo">
    <h2>Adoption по репозиториям</h2>
    <p class="muted">
      Кому нужно внимание первым. Отсортируй по adoption — внизу таблицы
      будут репо-аутсайдеры, кандидаты на pre-pilot встречу.
    </p>
    <div class="table-host" data-table="per-repo"></div>
  </section>

  <section class="panel" id="panel-shadow">
    <div class="panel-head">
      <h2>Карта shadow-компонентов <span class="info-pill" data-glossary="shadow-level">?</span></h2>
      <div class="tabs" role="tablist">
        <button class="tab active" data-view="byComponent" role="tab">По компонентам</button>
        <button class="tab" data-view="byFile" role="tab">По файлам</button>
      </div>
    </div>
    <p class="muted">
      «По компонентам» — для стратегии: какой shadow добавить в Beaver,
      чтобы убить N миграций одной строкой. «По файлам» — когда уже решил
      мигрировать и нужны конкретные пути.
    </p>
    <div class="table-host" data-table="shadow-component"></div>
    <div class="table-host hidden" data-table="shadow-file"></div>
  </section>

  <section class="panel" id="panel-coverage">
    <h2>Покрытие Beaver-пакетов</h2>
    <p class="muted">
      Маленькое число в колонке «Репо» = пакет недопромоушен.
      Маленькое «Использований» — возможно, кандидат на deprecate.
    </p>
    <div class="table-host" data-table="coverage"></div>
  </section>

  <section class="panel" id="panel-shared">
    <h2>Shared-компоненты <span class="info-pill" data-glossary="shared">?</span></h2>
    <p class="muted">
      Файлы, достижимые из нескольких страниц (хедеры, общие layout'ы).
      Эти юзеджи не идут в знаменатель «Adoption по маршрутам» — но важны
      стратегически: переписать один общий хедер дешевле, чем 30 страниц.
    </p>
    <div class="table-host" data-table="shared"></div>
  </section>

  <section class="panel methodology" id="panel-methodology">
    <h2>Как сканер считает</h2>
    <p class="muted">
      Каждое JSX-использование компонента сканер кладёт в одну из трёх
      категорий: <strong class="bucket-text-adoption">adoption</strong> (импорт
      из Beaver и без кастомизации), <strong class="bucket-text-shadow">shadow</strong>
      (локальный или чужой компонент, который выполняет роль Beaver-примитива),
      <strong class="bucket-text-neither">neither</strong> (бизнес-компоненты,
      чужие либы без признаков примитива). Дальше из этих категорий считаются
      все метрики.
    </p>
    <div class="pipeline">
      <div class="stage"><strong>1. Поиск файлов</strong><span>.tsx / .jsx / .ts / .js, без mocks и тестов</span></div>
      <div class="stage"><strong>2. Парсинг</strong><span>AST: где какой компонент использован и откуда импортирован</span></div>
      <div class="stage"><strong>3. Резолв</strong><span>Импорт → реальный путь, через tsconfig и алиасы</span></div>
      <div class="stage"><strong>4. Категоризация</strong><span>Импорт ведёт в Beaver / локальную либу / наружу / динамика</span></div>
      <div class="stage"><strong>5. Свод с реестром</strong><span>Локальные либы, которые re-export'ят Beaver, канонизируются</span></div>
      <div class="stage"><strong>6. Классификация</strong><span>Каждый юзедж → adoption / shadow / neither</span></div>
      <div class="stage"><strong>7. Маршруты</strong><span>Файл → страница: bound, shared или unmapped</span></div>
      <div class="stage"><strong>8. Метрики</strong><span>Adoption, среднее по репо, shadow-группы, рекомендации</span></div>
    </div>
    <p class="muted small">
      Полное описание формул и порогов — в <code>docs/руководство.md</code>.
    </p>
  </section>

  <section class="panel faq" id="panel-faq">
    <h2>Частые вопросы</h2>
    <div id="faq-list"></div>
  </section>

  <section class="panel footnote" id="panel-warnings">
    <div class="panel-head">
      <h2>Проверки данных</h2>
      <button class="toggle" id="warnings-toggle" aria-expanded="false">—</button>
    </div>
    <p id="invariants-summary" class="checks-summary">—</p>
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
.page-header { display: flex; justify-content: space-between; align-items: flex-end;
  padding-bottom: 24px; border-bottom: 1px solid var(--panel-border); margin-bottom: 24px;
  flex-wrap: wrap; gap: 16px;
}
.brand-mark { font-family: var(--mono); font-size: 22px; font-weight: 700;
  letter-spacing: 0.1em; color: var(--accent); display: block; }
.brand-sub { font-size: 12px; color: var(--fg-dim); letter-spacing: 0.1em;
  text-transform: uppercase; }
.meta { font-family: var(--mono); font-size: 12px; color: var(--fg-dim);
  text-align: right; line-height: 1.7; }
.meta strong { color: var(--fg); font-weight: 600; }

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
.hero-hint { font-size: 11px; color: var(--fg-dim); }

.narrative { background: var(--panel); border: 1px solid var(--panel-border);
  border-left: 3px solid var(--accent); border-radius: 8px;
  padding: 20px 24px; margin-bottom: 24px; }
.narrative h3 { font-size: 16px; margin-bottom: 12px; line-height: 1.4; }
.narrative ul { margin: 0; padding-left: 20px; color: var(--fg-dim); font-size: 13px;
  line-height: 1.8; }
.narrative ul li strong { color: var(--fg); }

.panel { background: var(--panel); border: 1px solid var(--panel-border);
  border-radius: 8px; padding: 20px 24px; margin-bottom: 24px; }
.panel-head { display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 16px; flex-wrap: wrap; gap: 12px; }
.panel-head h2 { margin: 0; display: flex; align-items: center; gap: 8px; }

.recommendations .rec-card { display: flex; gap: 12px; padding: 14px 0;
  border-bottom: 1px solid var(--panel-border); }
.recommendations .rec-card:last-child { border-bottom: 0; }
.rec-priority { width: 10px; height: 10px; border-radius: 50%; margin-top: 6px;
  flex-shrink: 0; }
.rec-priority.high { background: var(--bad); box-shadow: 0 0 8px var(--bad); }
.rec-priority.medium { background: var(--warn); box-shadow: 0 0 6px var(--warn); }
.rec-priority.low { background: var(--info); }
.rec-body { flex: 1; min-width: 0; }
.rec-title { font-weight: 600; color: var(--fg); margin-bottom: 4px; font-size: 14px; }
.rec-rationale { color: var(--fg-dim); font-size: 13px; line-height: 1.5; }
.rec-expand { background: transparent; color: var(--accent); border: 0;
  cursor: pointer; padding: 6px 0 2px; font-family: inherit; font-size: 12px;
  text-decoration: underline; text-underline-offset: 3px; }
.rec-expand:hover { color: var(--fg); }
.rec-evidence { margin-top: 8px; padding: 10px 12px; background: var(--bg);
  border-radius: 4px; border: 1px solid var(--panel-border);
  display: flex; flex-wrap: wrap; gap: 6px; max-height: 280px; overflow-y: auto; }
.ev-chip { font-family: var(--mono); font-size: 11px; color: var(--fg);
  background: var(--panel); padding: 4px 8px; border-radius: 999px;
  border: 1px solid var(--panel-border); display: inline-flex; align-items: center; gap: 6px; }
.ev-chip code { background: transparent; border: 0; padding: 0; color: var(--fg); }
.ev-pct { color: var(--fg-dim); font-size: 10px; }
.rec-empty { color: var(--fg-dim); font-size: 13px; padding: 8px 0; }

.cat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;
  margin: 16px 0 20px; }
@media (max-width: 900px) { .cat-grid { grid-template-columns: 1fr; } }
.cat-card { background: var(--bg); border: 1px solid var(--panel-border);
  border-radius: 6px; padding: 16px 18px; border-left: 3px solid var(--panel-border);
  display: flex; flex-direction: column; }
.cat-card.cat-adoption { border-left-color: var(--good); }
.cat-card.cat-shadow { border-left-color: var(--bad); }
.cat-card.cat-neither { border-left-color: var(--fg-dim); }
.cat-title { font-family: var(--mono); font-weight: 600; font-size: 14px;
  display: flex; align-items: center; gap: 10px; margin-bottom: 12px;
  letter-spacing: 0.02em; }
.cat-adoption .cat-title { color: var(--good); }
.cat-shadow .cat-title { color: var(--bad); }
.cat-neither .cat-title { color: var(--fg-dim); }
.cat-dot { width: 10px; height: 10px; border-radius: 50%; background: currentColor;
  box-shadow: 0 0 8px currentColor; opacity: 0.85; }
.cat-summary { color: var(--fg-dim); font-size: 13px; line-height: 1.55;
  margin: 0 0 10px; }
.cat-summary strong { color: var(--fg); }
.cat-forms { color: var(--fg-dim); font-size: 12px; line-height: 1.55;
  margin: 8px 0 10px; padding-left: 18px; }
.cat-forms li { margin-bottom: 6px; }
.cat-forms strong { color: var(--fg); font-weight: 600; }
.cat-example { background: var(--panel); border: 1px solid var(--panel-border);
  border-radius: 4px; padding: 10px 12px; margin: 8px 0;
  font-family: var(--mono); font-size: 11px; line-height: 1.6;
  color: var(--fg); white-space: pre-wrap; word-break: break-word;
  overflow-x: auto; }
.cat-example code { background: transparent; border: 0; padding: 0;
  font-size: 11px; color: inherit; }
.cat-note { color: var(--fg-dim); font-size: 11px; font-style: italic;
  margin: auto 0 0; padding-top: 10px; border-top: 1px dashed var(--panel-border); }

.formula-block { background: var(--bg); border: 1px solid var(--panel-border);
  border-radius: 6px; padding: 12px 16px; font-size: 13px;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.formula-block strong { color: var(--fg); }
.formula-block code { background: var(--panel); color: var(--accent);
  font-size: 13px; padding: 4px 10px; border: 1px solid var(--panel-border); }
.formula-note { color: var(--fg-dim); font-size: 12px; }

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
.toggle:disabled { opacity: 0.3; cursor: default; }

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
.faq-a code { background: var(--bg); }

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

.hidden { display: none !important; }
.muted { color: var(--fg-dim); font-size: 13px; margin: 0 0 12px; }
.muted.small { font-size: 11px; }
.footnote { font-size: 12px; }
.checks-summary { font-size: 13px; margin: 0; }
.checks-summary.ok { color: var(--good); }
.checks-summary.bad { color: var(--bad); }
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
.bucket-text-adoption { color: var(--good); }
.bucket-text-shadow { color: var(--bad); }
.bucket-text-neither { color: var(--fg-dim); }
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
function ruRepoPlural(n) {
  return n + ' ' + (n === 1 ? 'репо' : (n >= 2 && n <= 4 ? 'репо' : 'репо'));
}
function ruUsagePlural(n) {
  var m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return n + " использование";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return n + " использования";
  return n + " использований";
}
function ruEntriesPlural(n) {
  var m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'запись';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'записи';
  return 'записей';
}

// --- DataTable: filter input survives re-renders (mount + paint) ---
function createTable(host, opts) {
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

  // Build skeleton ONCE; filter input persists across re-renders.
  var sizes = [50, 100, 250, 500, 0];
  var sizeOpts = sizes.map(function (sz) {
    var lbl = sz === 0 ? 'все' : String(sz);
    return '<option value="' + sz + '">' + lbl + '</option>';
  }).join('');
  host.innerHTML =
    '<div class="tbl-controls">' +
      '<input class="tbl-filter" type="search" placeholder="Поиск по таблице…" />' +
      '<span class="tbl-count"></span>' +
      '<label>Строк на странице: <select class="tbl-pagesize">' + sizeOpts + '</select></label>' +
      '<button class="csv-export" title="Скачать как CSV">⬇ CSV</button>' +
    '</div>' +
    '<div class="tbl-data"></div>';

  var filterInput = host.querySelector('.tbl-filter');
  var countEl = host.querySelector('.tbl-count');
  var pageSizeSelect = host.querySelector('.tbl-pagesize');
  var csvBtn = host.querySelector('.csv-export');
  var dataEl = host.querySelector('.tbl-data');
  pageSizeSelect.value = String(state.pageSize);

  var debounceTimer = null;
  filterInput.addEventListener('input', function (e) {
    var val = e.target.value;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      state.filter = val;
      state.page = 0;
      paint();
    }, 150);
  });
  pageSizeSelect.addEventListener('change', function (e) {
    state.pageSize = parseInt(e.target.value, 10);
    state.page = 0;
    paint();
  });
  csvBtn.addEventListener('click', exportCsv);

  function paint() {
    var rows = sorted(filtered());
    var total = rows.length;
    var totalAll = state.rows.length;
    countEl.textContent = state.filter
      ? total + ' из ' + totalAll
      : total + ' ' + ruEntriesPlural(total);

    var pageSize = state.pageSize === 0 ? Math.max(total, 1) : state.pageSize;
    var pages = Math.max(1, Math.ceil(total / pageSize));
    if (state.page >= pages) state.page = pages - 1;
    if (state.page < 0) state.page = 0;
    var start = state.page * pageSize;
    var end = Math.min(start + pageSize, total);
    var visible = rows.slice(start, end);

    var html = '';
    if (total === 0) {
      html = '<div class="tbl-empty">' + escapeHtml(state.emptyText) + '</div>';
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
    dataEl.innerHTML = html;
    bindDataPart();
  }

  function bindDataPart() {
    dataEl.querySelectorAll('th.sortable').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.dataset.col;
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === 1 ? -1 : state.sortDir === -1 ? 0 : 1;
          if (state.sortDir === 0) state.sortKey = null;
        } else {
          state.sortKey = key;
          state.sortDir = 1;
        }
        paint();
      });
    });
    dataEl.querySelectorAll('.tbl-pager button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var pageSize = state.pageSize === 0 ? Math.max(filtered().length, 1) : state.pageSize;
        var pages = Math.max(1, Math.ceil(filtered().length / pageSize));
        switch (btn.dataset.action) {
          case 'first': state.page = 0; break;
          case 'prev': state.page = Math.max(0, state.page - 1); break;
          case 'next': state.page = Math.min(pages - 1, state.page + 1); break;
          case 'last': state.page = pages - 1; break;
        }
        paint();
      });
    });
  }

  paint();
  return { rerender: paint };
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

// --- Hero metrics ---
function renderHero() {
  var a = DATA.metrics.globalAdoption.value;
  var perRepo = DATA.metrics.perRepoAdoption;
  var meanRepo = perRepo.length > 0
    ? perRepo.reduce(function (s, r) { return s + r.value; }, 0) / perRepo.length
    : 0;
  var shadowGroups = DATA.metrics.shadowLandscape.byComponent.length;
  var packages = DATA.metrics.beaverCoverage.length;

  document.getElementById('metric-adoption').textContent = pct(a);
  document.getElementById('metric-per-repo').textContent = pct(meanRepo);
  document.getElementById('metric-shadow').textContent = String(shadowGroups);
  document.getElementById('metric-packages').textContent = String(packages);

  document.querySelectorAll('.hero-card').forEach(function (card) {
    card.addEventListener('click', function () { openMetricModal(card.dataset.metric); });
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMetricModal(card.dataset.metric); }
    });
  });
}

// --- Narrative ---
function renderNarrative() {
  var a = DATA.metrics.globalAdoption.value;
  var perRepo = DATA.metrics.perRepoAdoption;
  var topShadow = (DATA.metrics.shadowLandscape.byComponent || [])
    .slice()
    .sort(function (a, b) { return b.totalUsages - a.totalUsages; })[0];
  var confirmedCount = DATA.metrics.shadowLandscape.byComponent
    .filter(function (c) { return c.level === 'confirmed'; }).length;
  var firstRec = (DATA.recommendations || [])[0];

  var headline;
  if (a >= 0.7) {
    headline = 'Beaver уже доминирует — adoption ' + pct(a) + '. Дотюнить оставшиеся маршруты.';
  } else if (a >= 0.4) {
    headline = 'Adoption в середине (' + pct(a) + '). Главный рычаг — закрыть топ shadow-компонентов.';
  } else if (a > 0) {
    headline = 'Adoption низкий (' + pct(a) + '). Стоит сначала понять, что переизобретено и почему.';
  } else {
    headline = 'Adoption нулевой — Beaver в этих репо не используется.';
  }
  document.getElementById('narrative-headline').textContent = headline;

  var bullets = [];
  bullets.push('<li><strong>' + pct(a) + '</strong> юзеджей идут из Beaver, среднее по репо — <strong>' +
    pct(perRepo.length ? perRepo.reduce(function (s, r) { return s + r.value; }, 0) / perRepo.length : 0) +
    '</strong> по ' + ruRepoPlural(perRepo.length) + '.</li>');
  if (topShadow) {
    bullets.push('<li>Самый частый shadow: <code>' +
      escapeHtml(topShadow.componentName) + '</code> — ' +
      ruUsagePlural(topShadow.totalUsages) + ' в ' + ruRepoPlural(topShadow.reposCount) +
      ' (уровень ' + levelBadge(topShadow.level) + ').</li>');
  }
  bullets.push('<li>Сильных shadow-групп (уровень <code>confirmed</code>): <strong>' + confirmedCount +
    '</strong> из ' + DATA.metrics.shadowLandscape.byComponent.length + '.</li>');
  if (firstRec) {
    bullets.push('<li>Первый шаг по мнению сканера: <strong>' + escapeHtml(firstRec.title) + '</strong>.</li>');
  }
  document.getElementById('narrative-bullets').innerHTML = bullets.join('');
}

// --- Recommendations with expandable evidence ---
function renderRecommendations() {
  var recs = DATA.recommendations || [];
  var host = document.getElementById('recs-list');
  var countEl = document.getElementById('recs-count');
  countEl.textContent =
    recs.length === 0 ? 'нет рекомендаций' :
    recs.length === 1 ? '1 рекомендация' :
    (recs.length >= 2 && recs.length <= 4 ? recs.length + ' рекомендации' : recs.length + ' рекомендаций');
  if (recs.length === 0) {
    host.innerHTML = '<div class="rec-empty">Метрики выглядят нейтрально — сканер ничего конкретного не советует.</div>';
    return;
  }

  // Build lookup tables for evidence enrichment.
  var perRepoLookup = {};
  DATA.metrics.perRepoAdoption.forEach(function (r) { perRepoLookup[r.repoId] = r.value; });
  var coverageLookup = {};
  DATA.metrics.beaverCoverage.forEach(function (p) { coverageLookup[p.package] = p; });

  host.innerHTML = recs.map(function (r, idx) {
    var evidenceHtml = '';
    var expandLabel = null;
    if (r.evidence && r.evidence.repoIds && r.evidence.repoIds.length > 0) {
      expandLabel = 'Показать все ' + r.evidence.repoIds.length + ' ' + ruRepoPlural(r.evidence.repoIds.length).replace(/^\\d+\\s/, '');
      evidenceHtml = r.evidence.repoIds.map(function (id) {
        var v = perRepoLookup[id];
        return '<span class="ev-chip"><code>' + escapeHtml(id) + '</code>' +
          (v !== undefined ? '<span class="ev-pct">' + pct(v) + '</span>' : '') +
          '</span>';
      }).join('');
    } else if (r.evidence && r.evidence.packages && r.evidence.packages.length > 0) {
      expandLabel = 'Показать все ' + r.evidence.packages.length + ' ' +
        (r.evidence.packages.length === 1 ? 'пакет' :
          (r.evidence.packages.length >= 2 && r.evidence.packages.length <= 4 ? 'пакета' : 'пакетов'));
      evidenceHtml = r.evidence.packages.map(function (pkg) {
        var c = coverageLookup[pkg];
        var pct_label = c ? c.reposUsing + ' репо · ' + c.instances + ' исп.' : '';
        return '<span class="ev-chip"><code>' + escapeHtml(pkg) + '</code>' +
          (pct_label ? '<span class="ev-pct">' + escapeHtml(pct_label) + '</span>' : '') +
          '</span>';
      }).join('');
    } else if (r.evidence && r.evidence.shadowGroupKeys && r.evidence.shadowGroupKeys.length > 0) {
      // For add-to-beaver: look up the group, show its stats.
      var byKey = {};
      DATA.metrics.shadowLandscape.byComponent.forEach(function (g) { byKey[g.groupKey] = g; });
      var groups = r.evidence.shadowGroupKeys.map(function (k) { return byKey[k]; }).filter(Boolean);
      if (groups.length > 0) {
        expandLabel = 'Подробнее о группе';
        evidenceHtml = groups.map(function (g) {
          return '<span class="ev-chip"><code>' + escapeHtml(g.componentName) + '</code>' +
            '<span class="ev-pct">' + g.reposCount + ' репо · ' + g.totalUsages + ' исп · ' + g.level + '</span>' +
            '</span>';
        }).join('');
      }
    }

    return '<div class="rec-card">' +
      '<div class="rec-priority ' + escapeHtml(r.priority) + '"></div>' +
      '<div class="rec-body">' +
      '<div class="rec-title">' + escapeHtml(r.title) + '</div>' +
      '<div class="rec-rationale">' + escapeHtml(r.rationale) + '</div>' +
      (expandLabel
        ? '<button class="rec-expand" data-i="' + idx + '" data-label="' + escapeHtml(expandLabel) + '">' + escapeHtml(expandLabel) + '</button>' +
          '<div class="rec-evidence hidden">' + evidenceHtml + '</div>'
        : '') +
      '</div></div>';
  }).join('');

  host.querySelectorAll('.rec-expand').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var ev = btn.nextElementSibling;
      var willOpen = ev.classList.contains('hidden');
      ev.classList.toggle('hidden');
      btn.textContent = willOpen ? 'Скрыть' : btn.dataset.label;
    });
  });
}

// --- Metric modal ---
var METRIC_DEFS = {
  adoption: {
    title: 'Общий adoption',
    formula: 'adoption / (adoption + shadow)',
    body: function () {
      return '<p>Какая доля «решённых» использований идёт из Beaver, а не из локальных shadow-альтернатив. Использования из чужих библиотек (<code>neither</code>) в знаменатель не попадают — они просто «не наша зона ответственности».</p>' +
        '<p>Значение сейчас: <strong>' + pct(DATA.metrics.globalAdoption.value) + '</strong>.</p>';
    }
  },
  perRepo: {
    title: 'Среднее adoption по репозиториям',
    formula: 'mean(adoption_repo) — невзвешенное',
    body: function () {
      var perRepo = DATA.metrics.perRepoAdoption;
      var mean = perRepo.length ? perRepo.reduce(function (s, r) { return s + r.value; }, 0) / perRepo.length : 0;
      return '<p>Невзвешенное среднее: маленькие репо весят столько же, сколько большие. Это специально — иначе монорепо доминировало бы и общая картина искажалась.</p>' +
        '<p>Сейчас: <strong>' + pct(mean) + '</strong> по ' + ruRepoPlural(perRepo.length) + '.</p>';
    }
  },
  shadow: {
    title: 'Shadow-групп',
    formula: 'count(distinct группа shadow-компонентов)',
    body: function () {
      var confirmed = DATA.metrics.shadowLandscape.byComponent.filter(function (c) { return c.level === 'confirmed'; }).length;
      var total = DATA.metrics.shadowLandscape.byComponent.length;
      return '<p>Каждая группа = уникальная комбинация имени компонента + сигнатуры пропсов + размера разметки. Уровень <code>confirmed</code> = сильный сигнал shadow (например, обёртка вокруг Beaver с кастомизацией). <code>likely</code> и <code>possible</code> — слабее, нуждаются в ручной проверке.</p>' +
        '<p>Сейчас: <strong>' + total + '</strong> групп всего, из них <strong>' + confirmed + '</strong> сильных.</p>' +
        '<p>Если <code>possible</code> сильно превышает <code>confirmed</code> — детекция шумит, стоит тюнить пороги (увидишь в рекомендациях).</p>';
    }
  },
  packages: {
    title: 'Beaver-пакетов в коде',
    formula: 'count(distinct package)',
    body: function () {
      var cov = DATA.metrics.beaverCoverage;
      var top = cov.slice().sort(function (a, b) { return b.instances - a.instances; }).slice(0, 3);
      return '<p>Сколько разных пакетов Beaver встречается в импортах хотя бы где-то. Косвенно показывает «ширину» использования.</p>' +
        '<p>Сейчас: <strong>' + cov.length + '</strong>. Топ-3 по частоте: ' +
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
    host.innerHTML = '<div class="donut-empty">Использований нет.</div>';
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
    emptyText: 'Репозитории не сканировались.',
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
    emptyText: 'Маршруты не нашлись — либо в сканированных репо нет конфига React Router v6, либо все использования в shared/unmapped файлах.',
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
    emptyText: 'Shadow-компонентов не найдено.',
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
      { key: 'totalUsages', label: 'Всего использований', num: true,
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
      { key: 'usageCount', label: 'Использований', num: true,
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
        key: 'bucket', label: 'Категория',
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

// --- Проверки данных ---
function renderInvariantsAndWarnings() {
  var inv = DATA.invariants;
  var warnings = DATA.warnings || [];
  var summary = document.getElementById('invariants-summary');
  var violationsBlock = document.getElementById('violations-block');
  var toggle = document.getElementById('warnings-toggle');
  var body = document.getElementById('warnings-body');

  var totalIssues = inv.violations.length + warnings.length;
  if (totalIssues === 0) {
    summary.textContent = 'Всё в порядке: ' + inv.checked + ' использований проверено, отклонений нет.';
    summary.classList.add('ok');
    toggle.textContent = 'Чисто';
    toggle.disabled = true;
    return;
  }
  if (inv.violations.length > 0) {
    summary.innerHTML = 'Найдено отклонений в проверках: <strong>' + inv.violations.length +
      '</strong>. Предупреждений: <strong>' + warnings.length + '</strong>. ' +
      'Это значит: где-то в данных есть несоответствие между категоризацией и агрегатами — стоит посмотреть детали.';
    summary.classList.add('bad');
  } else {
    summary.textContent = 'Проверки пройдены. Сканер выписал ' + warnings.length +
      ' предупреждений (например, не сумел зарезолвить динамический импорт) — не ошибки, но стоит просмотреть.';
  }

  toggle.textContent = 'Показать (' + totalIssues + ')';
  toggle.addEventListener('click', function () {
    body.classList.toggle('hidden');
    var expanded = !body.classList.contains('hidden');
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.textContent = expanded ? 'Скрыть' : 'Показать (' + totalIssues + ')';
  });

  var html = '';
  if (inv.violations.length > 0) {
    html += '<p><strong>Отклонения в проверках:</strong></p>';
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
    body: 'Использование, где компонент пришёл из Beaver (прямо или через канонизированный re-export) и не кастомизирован — без <code>className</code>, <code>style</code>, <code>sx</code>. Метрика adoption считает долю таких относительно суммы (adoption + shadow).'
  },
  shadow: {
    title: 'Shadow-компонент',
    body: 'Локальный или сторонний компонент, который выполняет роль Beaver-примитива: либо переписан с нуля (имя «Button», «Card» + развёрнутая разметка), либо обёртка вокруг Beaver с кастомизацией. Уровни: <strong>confirmed</strong>, <strong>likely</strong>, <strong>possible</strong> — по силе сигнала.'
  },
  bucket: {
    title: 'Категории использований',
    body: 'Каждое JSX-использование попадает ровно в одну категорию: <strong class="bucket-text-adoption">adoption</strong> (из Beaver, без кастомизации), <strong class="bucket-text-shadow">shadow</strong> (локальная альтернатива), <strong class="bucket-text-neither">neither</strong> (бизнес-компонент или чужая либа).'
  },
  'shadow-level': {
    title: 'Уровни shadow',
    body: '<strong>confirmed</strong> — сильный сигнал (обёртка с кастомизацией, развёрнутая разметка с primitive-именем). <strong>likely</strong> — несколько слабых сигналов. <strong>possible</strong> — только намёк по имени. Доверять и мигрировать сначала confirmed.'
  },
  shared: {
    title: 'Shared-компоненты',
    body: 'Файлы, до которых дотягивается импорт-граф от нескольких страниц (хедеры, общие layout\\'ы). Их использования не идут в знаменатель «Adoption по маршрутам» — иначе одна правка хедера двигала бы все маршруты сразу. Но они важны стратегически: один shared = много страниц.'
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
    q: 'Почему мой <code>&lt;Button className="..." /&gt;</code> попал в shadow?',
    a: 'Любая кастомизация Beaver-импорта (<code>className</code>, <code>style</code>, <code>sx</code>) переводит использование в shadow — даже если сам импорт из Beaver. Это пуристский подход: накинул свои стили — значит сделал локальную «не совсем-Beaver»-версию.'
  },
  {
    q: 'Какие уровни shadow и что они значат?',
    a: '<strong>confirmed</strong> — сильный сигнал (например, обёртка с кастомизацией + primitive-имя, или развёрнутая разметка с primitive-именем). <strong>likely</strong> — несколько слабых сигналов. <strong>possible</strong> — только эвристика по имени. Для миграционной стратегии смотри сначала confirmed.'
  },
  {
    q: 'Почему таблица «по маршрутам» пустая?',
    a: 'Скорее всего в сканированных репо: (а) нет конфига React Router v6, (б) Routes есть, но все файлы-использования достижимы с 2+ страниц (тогда они в shared), (в) роуты заданы способом, который сканер ещё не поддерживает (Next.js App Router — на v2). Смотри секцию «Проверки данных» — там будут предупреждения с кодами вида <code>route-resolver-*</code>.'
  },
  {
    q: 'Adoption у меня 20%. Что делать первым?',
    a: 'Открой карточку «Что советует сканер». Топ-рекомендация обычно — конкретный shadow-компонент, повторяющийся в N репозиториях. Добавить его в Beaver = убрать N миграций одним PR. Дальше смотри Pareto-чарт топ-10 shadow-компонентов: первые два-три занимают чаще всего 30–50% всех shadow-использований.'
  },
  {
    q: 'Как сканер понял, что мой <code>@my-lib/button</code> — это «обёртка над Beaver»?',
    a: 'На этапе «Свод с реестром» (Stage 5) сканер AST-парсит файлы локальной библиотеки, видит её re-export из, например, <code>@beaver-ui/core</code>, и канонизирует — все использования <code>@my-lib/button</code> начинают считаться как использования Beaver. Подробности см. в <code>docs/руководство.md</code>, раздел «Канонизация импортов».'
  },
  {
    q: 'Что такое sharedLibraries и почему они не идут в метрику маршрутов?',
    a: 'Если компонент используется на 2+ маршрутах, его использования формально нельзя «приписать» одному маршруту — отсюда они в отдельной секции shared. В стратегии миграции shared = «дорогая» цель: одна правка влияет на много маршрутов, поэтому стоит решать осознанно.'
  },
  {
    q: 'Как формируются рекомендации?',
    a: 'Четыре правила: (1) shadow-группа в ≥ N репозиториях → «добавить в Beaver», (2) репо с adoption ниже порога → «outreach», (3) Beaver-пакет в <code>&lt; X%</code> репо → «промоушн пакета», (4) когда possible сильно превышает confirmed — «тюнинг порогов». Пороги настраиваются в секции <code>recommendations</code> конфига.'
  },
  {
    q: 'Разные запуски на одних данных дают разный отчёт — это баг?',
    a: 'Да. Детерминизм — гарантия сканера. Повторный запуск на тех же коммитах должен дать байт-идентичный <code>dataset.jsonl</code>. Если diff не пустой — заводи issue.'
  },
  {
    q: 'У меня 50k+ shadow-использований — отчёт лагает.',
    a: 'Открой Developer Tools → Network → посмотри размер HTML. Если > 50 МБ, можно: (а) понизить <code>thresholds.maxShadowRows</code> в конфиге, (б) запустить с <code>--no-html</code> и работать с <code>dataset.jsonl</code> через jq/duckdb. Таблицы тут уже пагинируются, но JS-парсинг 100k+ объектов всё равно небыстрый.'
  },
  {
    q: 'JSX-элементы вида <code>&lt;namespace.Component /&gt;</code> поддерживаются?',
    a: 'Да. Сканер умеет резолвить <code>UI.Button</code>, <code>icons.X</code> и более глубокие цепочки (до 5 уровней обёрток и алиасов). Если что-то не резолвится — в секции «Проверки данных» будет предупреждение с кодом <code>jsx-member-unresolved</code>.'
  },
  {
    q: 'Какой целевой false-positive rate?',
    a: 'Цель — не выше 15% на 50-компонентной ручной выборке. Измеряется после большого dry-run на pilot-батче репо. До этого сканер работает в строгом режиме: лучше перестраховаться (классифицировать как shadow), чем пропустить.'
  },
  {
    q: 'Как выгрузить данные таблицы наружу?',
    a: 'Кнопка «⬇ CSV» в каждой таблице. Экспортирует ТЕКУЩИЙ вид — с фильтром и сортировкой, но БЕЗ пагинации (все отфильтрованные строки сразу). Полный сырой датасет — рядом с отчётом в <code>aggregates.json</code> и <code>dataset.jsonl</code>.'
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
renderMeta();
renderHero();
renderNarrative();
renderRecommendations();
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
