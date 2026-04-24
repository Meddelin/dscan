# Product Requirements Document
# Beaver Adoption Scanner

**Version:** 2.0
**Status:** Draft
**Last updated:** 2026-04-20
**Owner:** Stanislav (Beaver team)

---

## 1. Context & Goals

### 1.1 Consumer

Единственный активный консьюмер MVP — **Beaver-команда (Stanislav + команда)**.
Частота использования — раз в 1–2 недели.
Назначение — оценка цифр adoption/shadow для:
- принятия продуктовых решений внутри команды;
- формулировки целей и стратегии развития Beaver;
- подготовки данных для будущего переезда в BI.

Будущие консьюмеры (фиксируются, но не определяют MVP):
- Внутренний T-Bank'овский BI → сканер становится data producer, отдаёт низкоуровневый датасет.
- OKR-метрика (какая именно — open question, см. раздел 11).

### 1.2 Problem

Beaver используется в ~100 консьюмер-репо. Adoption и shadow-слой невозможно измерять вручную. Текущие внешние тулзы (Omlet, react-scanner) не покрывают:
- per-package adoption для Beaver-структуры (пакеты как единица);
- различение adoption-wrapper vs shadow-компонент по props registry;
- per-repo конфигурацию локальных UI-либ;
- работу на 100 репо с self-hosted GitLab.

### 1.3 Goal

Построить CLI-тулзу, которая:
1. Сканирует 100 консьюмер-репо.
2. Детерминистически классифицирует JSX-использования по бакетам (adoption / shadow / neither).
3. Выдаёт instance-level JSONL-датасет + derived-агрегаты + self-contained HTML-viewer.

### 1.4 Non-Goals

- Не генерируем план миграции, не предлагаем рефакторинги.
- Не покрываем Vue / Angular / Svelte.
- Не трекаем runtime-usage (source-only).
- Не делаем визуальный regression / design diff.
- Не работаем с динамическим созданием компонентов по строке (`getComponent(name)`) — честно помечаем как `unresolved`.

### 1.5 Success Criteria (MVP)

- Сканер отрабатывает все 100 репо за один запуск.
- Классификация детерминистична: один и тот же git commit → бит-в-бит одинаковый датасет.
- HTML-viewer рендерится из сгенерированного датасета без дополнительных данных.
- Stanislav способен за раз в 1–2 недели принять решение по Beaver-roadmap на основе отчёта.
- False-positive rate shadow-детекции: **≤ 15%** на ручной выборке из 50 компонентов (целевая метрика, см. 10.3).

### 1.6 Out of MVP

- Incremental scan (сканим всё при каждом запуске).
- Webhook-триггеры.
- Runtime CI integration (PR checks).
- Multi-DS поддержка (только Beaver).

---

## 2. Scope & Assumptions

### 2.1 Deployment Scope

| Фаза | Где крутится | Триггер |
|------|-------------|---------|
| MVP | Локально на машине Stanislav | Manual run |
| v1.x | Выделенный runner | Cron (раз в неделю-две, полное клонирование + удаление) |

Источник репо — self-hosted T-Bank GitLab. Список репо:
- MVP: статический файл в конфиге.
- v1.x: auto-discovery через GitLab API (все репо группы / с определённым топиком).

### 2.2 Tech Scope

- Основная поддержка: **TypeScript + React**.
- Сопутствующие: JS, JSX — парсятся, но с ограничениями (отсутствие типов → props registry для local-libs собрать нельзя).
- **Route resolution:** поддерживается React Router v6 с `createBrowserRouter` + RouteObject-конфигами (в т.ч. lazy-loading). Вложенные `<Routes>` внутри фич схлопываются в родительский роут (гранулярность — уровень страницы).
- Next.js — не в MVP (если встретится — репо логируется как `unsupported-stack`, попадает в v2).
- React Native — пропускается, репо логируется как `unsupported-stack`.

### 2.3 Что сканируем

По дефолту сканируем `src/**/*.{ts,tsx,js,jsx}`.
Конфигурируемо per-repo:
- Исключения по дефолту: `*.test.*`, `*.spec.*`, `*.stories.*`, `node_modules`, `dist`, `build`, `.next`.
- Генерируемый код и vendored-папки — исключаются списком путей в per-repo конфиге.

Опционально: сканирование тестов/stories отдельным срезом (`coverage-in-tests`). Не входит в MVP.

### 2.4 Assumptions

- Beaver живёт в отдельном репо/монорепо, доступном на клонирование.
- Prescan Beaver происходит один раз за scan, версия фиксируется в метаданных датасета.
- Локальные UI-либы (в отдельных репо или внутри консьюмер-репо) объявляются вручную в per-repo конфиге.
- Сеть до GitLab и до Beaver-репо доступна на момент запуска.
- Порядок запусков не важен (один scan в момент времени).

---

## 3. Domain Model

### 3.1 Beaver Structure

Beaver — набор npm-пакетов с именованными экспортами. Возможные структурные варианты:

**Вариант 1: прямые пакеты.**
```ts
// @beaver-ui/side-navigation
export { SideNavigation, SideNavigationItem } from './components'

// consumer
import { SideNavigation } from '@beaver-ui/side-navigation'
<SideNavigation/>
```

**Вариант 2: агрегаторный пакет с re-exports.**
```ts
// @beaver-ui/components (aggregator)
export { SideNavigation } from '@beaver-ui/side-navigation'
export { Subheader } from '@beaver-ui/subheader'

// consumer
import { SideNavigation } from '@beaver-ui/components'
```

Сканер **канонизирует** использование через агрегатор к исходному пакету. В датасете запись выглядит как `@beaver-ui/side-navigation → SideNavigation`, даже если consumer импортировал из `@beaver-ui/components`.

**Вариант 3 (член-экспрешн, `<Subheader.Actions/>`)** в MVP не встречается по текущей договорённости. Если встретится — запись уйдёт в `unresolved-dynamic` с причиной `member-expression-not-supported`, и вопрос вернётся в open questions.

### 3.2 Единица adoption — пакет

Главная единица агрегации — **пакет Beaver**, не отдельный компонент. Компоненты сохраняются в датасете для drill-down, но метрики A/B/C/D оперируют пакетами.

### 3.3 Структурные категории

Категория назначается каждому JSX-использованию по факту импорта:

| Категория | Правило |
|-----------|---------|
| `html-native` | JSX-тег начинается с lowercase (`<div>`, `<span>`) |
| `beaver` | Резолвится в Beaver-пакет (включая канонизацию через агрегатор) |
| `local` | Относительный импорт из файла консьюмер-репо, не в `localLibraryPatterns` |
| `local-library` | Относительный/bare импорт, матчится в `localLibraryPatterns` per-repo |
| `third-party` | npm-пакет, не входящий в Beaver и не в local-library |

Категория — **структурный факт**, назначается до классификации.

### 3.4 Аналитические бакеты

Каждое JSX-использование попадает **ровно в один** бакет:

| Бакет | Определение | В знаменателе метрики A/B |
|-------|-------------|----------------------------|
| `adoption` | Прямое использование Beaver ИЛИ обвязка над Beaver без кастомизации UI | ✅ |
| `shadow` | Локальный компонент, дублирующий Beaver (параллельный UI-слой) | ✅ |
| `neither` | Утилитарные компоненты (providers, hooks, data-fetchers, layout-containers) | ❌ |

Знаменатель метрики adoption — `adoption + shadow`. `neither` трекается отдельно (метрика D — coverage, метрика diagnostics).

### 3.5 Shadow: три уровня

Уровень shadow отражает уверенность сканера. Для migration backlog (метрика C) уровень — главный фильтр приоритизации.

| Уровень | Критерий | Семантика |
|---------|----------|-----------|
| `confirmed` | Нет Beaver-импортов + primitive-like-name + substantial markup (≥ 5 JSX-элементов в source) | Почти наверняка дубль Beaver. Кандидат №1 на миграцию. |
| `likely` | Нет Beaver-импортов + (reusable-local ≥ 2 файлов) | Высокая вероятность дубля / кандидат в Beaver. |
| `possible` | Остальные сработавшие shadow-сигналы (styled без Beaver, parallel-layer, wraps-with-customization над Beaver) | Требует ручного review. |

BI/HTML-viewer фильтруют по уровню. В метрику A/B **все три уровня** попадают как `shadow`.

### 3.6 Adoption-wrapper vs Shadow: граница

**Продуктовая позиция: пуристская.** Любая визуальная кастомизация Beaver-компонента через `className` / `style` / `styled(BeaverX)` — **shadow**, даже если типы Beaver-компонента технически это разрешают. Отсутствие нужного пропса в Beaver — бэклог Beaver-команды, не повод разрешать обход.

Локальный компонент, импортирующий Beaver:

| Признак | Бакет |
|---------|-------|
| Передаёт `className` в Beaver-компонент | **shadow** |
| Передаёт `style` в Beaver-компонент | **shadow** |
| Применяет `styled(BeaverX)` / `emotion.styled(BeaverX)` | **shadow** |
| Оборачивает Beaver в `<div>` с < 5 JSX-элементов в source | **adoption-wrapper** |
| Оборачивает Beaver в markup с ≥ 5 JSX-элементов | **shadow** (substantial-markup) |
| Композиция нескольких Beaver-компонентов без передачи className/style | **adoption-wrapper** |
| Хуки / бизнес-логика без касания UI | **adoption-wrapper** |
| HTML-обёртка `<form>` / `<section>` без стилей | **adoption-wrapper** |

**Важные следствия:**
- Props registry (различение `variant="primary"` vs произвольный проп) в MVP **не используется**. Все пропсы Beaver кроме `className`/`style` считаются легитимными. Это сознательное упрощение — ложные негативы (человек передал кастомный проп, не предусмотренный Beaver) в MVP допустимы, чистится в v2 через props registry.
- Whitelist CSS-свойств для layout-обёрток **не нужен** — граница проходит через `substantial-markup < 5`, не через тип CSS.
- `css`-prop (emotion) не проверяется, т.к. не используется в экосистеме Beaver.

### 3.7 Классификационные источники

Каждая запись в датасете содержит `classificationSource`:

| Source | Значение |
|--------|----------|
| `direct-beaver` | Прямой импорт из Beaver-пакета |
| `beaver-backed-wrapper` | Local-library компонент, prescan которого нашёл Beaver-импорт |
| `beaver-composition` | Локальный компонент, импортирующий Beaver без передачи className/style, markup < 5 |
| `wraps-with-customization` | Локальный компонент с `className`/`style`/`styled()` на Beaver |
| `parallel-local-ui` | Локальный компонент без Beaver-импортов, shadow-сигналы сработали |
| `utility-heuristic` | Провайдер/хук/data-компонент/layout |
| `unresolved-dynamic` | Динамический lookup, не резолвится статически |

### 3.8 Route Model

Каждое JSX-использование в репо с поддерживаемым роутингом привязывается к роуту через **статический анализ import-графа** от page-компонентов, объявленных в route-конфигах.

Каждое usage-запись получает поле `route`:

```typescript
route:
  | { kind: 'bound'; path: string }          // достижим ровно от одного page-компонента
  | { kind: 'shared'; paths: string[] }      // достижим от 2+ page-компонентов
  | { kind: 'unmapped' }                     // не достижим от ни одного page-компонента
  | { kind: 'unsupported' }                  // репо не на поддерживаемом роутере
```

**Rationale:**
- `bound` → компонент живёт в контексте одной страницы (feature-компонент).
- `shared` → компонент живёт в нескольких страницах (хедеры, общие layouts, переиспользуемые feature-компоненты).
- `unmapped` → компонент не часть route-дерева (app shell, провайдеры, utils, глобальные компоненты).
- `unsupported` → репо без React Router v6 / без обнаруженных route-конфигов.

Дополнительно, никаких "confidence levels" (в отличие от v1). Либо статически резолвится, либо нет.

---

## 4. Pipeline

Пайплайн — 8 независимых стадий. Каждая стадия принимает и отдаёт документированный контракт. **Без guard-ов между стадиями** (в отличие от PRD v1).

```
[1] Discovery       → список файлов per-repo
[2] Parse           → AST per-file (tolerant mode)
[3] Resolve         → ImportMap + resolvedPaths
[4] Categorize      → структурная категория per-usage
[5] Prescan-Join    → enrich usage через Beaver props registry + local-lib registry
[6] Classify        → аналитический bucket + classificationSource
[7] Route-Resolve   → route-привязка per-usage через import-graph
[8] Aggregate       → derived-метрики A/B/C/D/E
```

### 4.1 Stage 1: Discovery

- Инструмент: `fdir` + `picomatch`.
- Input: список репо + per-repo конфиг (include/exclude).
- Output: `{ repoId, filePath }[]`.

### 4.2 Stage 2: Parse

- Инструмент: `@typescript-eslint/typescript-estree` с `errorOnUnknownASTType: false`.
- Tolerant mode: ошибки парсинга логируются в warnings, файл пропускается, scan продолжается.
- Caching: AST кэшируется per-scan (incremental — не в MVP).

### 4.3 Stage 3: Resolve

- Инструмент: TypeScript module resolution API + `tsconfig-paths`.
- Резолв через агрегаторный пакет: если `@beaver-ui/components` re-exports `SideNavigation` из `@beaver-ui/side-navigation`, ImportMap для consumer'a содержит резолв напрямую до исходного пакета.
- Caching: резолвы кэшируются per-repo.

### 4.4 Stage 4: Categorize

Priority order:
1. lowercase tag → `html-native`.
2. Beaver-пакет (по `beaverPackages` из prescan) → `beaver`.
3. Резолв в path, совпадающий с `localLibraryPatterns` (per-repo) → `local-library`.
4. Относительный резолв, не в localLibraryPatterns → `local`.
5. Иначе → `third-party`.

Категория — детерминированная функция от resolvedPath, ничего не зависит от prescan-а Beaver props registry.

### 4.5 Stage 5: Prescan-Join

**Prescan Beaver (один раз на scan):**

Beaver — Nx + npm workspaces монорепо с пакетами в `packages/*`. Prescan выполняется БЕЗ `ts.createProgram` (упрощение MVP — не используем TS compiler API).

Алгоритм:
1. Клонируется Beaver (SSH, `--depth=1`, `--single-branch`) в `.cache/beaver-ui/`.
2. Версия извлекается через `git describe --tags --always` (предпочтительно тег `v0.238.5`, fallback на SHA).
3. Сканируется `packages/*` по наличию `package.json` → список Beaver-пакетов.
4. Для каждого пакета парсится `src/index.ts` → список экспортируемых символов.
5. Строится re-export карта из агрегаторного пакета (`@beaver-ui/components`) с использованием `paths` из `tsconfig.base.json`. Рекурсивная обработка цепочек ре-экспортов, depth limit = 5.

**Props registry в MVP не строится.** Детекция кастомизации работает через AST-паттерны (3.6), не через сопоставление с типами пропсов. Props registry вынесен в v2 (см. Open Questions).

**Prescan local-libs (per-repo):**

Источник в MVP — только `local-path` (директория внутри того же репо). `git` и `npm` источники — v2.

Алгоритм:
1. Парсинг AST файлов указанной директории.
2. Проверка: импортирует ли компонент что-либо из `@beaver-ui/*` пакетов.
3. Бинарный флаг: `beaverBackedBy: true` если хоть один Beaver-импорт найден; иначе `false`.
4. Следование barrel re-exports с cycle detection и depth limit = 5.

Props registry для local libs не строится (согласованно с Beaver prescan).

**Join:**
- Каждому usage'у из Stage 4 приклеивается:
  - `beaverPackage` + `canonicalizedVia` (если категория `beaver`) — из re-export карты Beaver prescan.
  - `localLibBackingEntry` (если категория `local-library`) — бинарный флаг из local-lib prescan.

### 4.6 Stage 6: Classify

Классификация — **двухэтапная по категориям**, без перезаписей между этапами:

**Этап A (структурные категории → bucket):**
- `html-native` → `neither` / `utility-heuristic`.
- `beaver` → `adoption` / `direct-beaver`.
- `local-library` с `backedByBeaver=true` → `adoption` / `beaver-backed-wrapper`.
- `local-library` с `backedByBeaver=false` → идёт в этап B с флагом `fully-custom-lib`.
- `third-party` → `neither` / `utility-heuristic`. (См. 3.7: third-party без Beaver-backing не считается shadow, т.к. нет семантической связи с Beaver.)
- `local` → идёт в этап B.

**Этап B (local и fully-custom local-library):**
1. Построить профиль компонента: агрегировать все usage'и по `resolvedPath + exportedSymbol`.
2. Пройти neither-эвристики. Если матч — `neither` / `utility-heuristic`.
3. Пройти adoption-wrapper правила (3.6). Если матч — `adoption` / соответствующий source.
4. Пройти shadow-сигналы (5.1). Если хотя бы один — `shadow` + уровень (confirmed/likely/possible).
5. Иначе — `neither` (default для мелких локальных компонентов без сигналов).

Этап B **не трогает** записи, уже классифицированные как `adoption` в этапе A. Гарантируется не guard-ом, а разделением input-списков (этап B получает только `local` + `fully-custom local-library`).

### 4.7 Stage 7: Route-Resolve

Стадия опциональна per-repo (конфигом можно отключить). Если включена и репо поддерживает routing — каждому usage добавляется поле `route` (см. 3.8).

**4.7.1 Route Config Discovery.**

Сканер ищет файлы, содержащие один из паттернов:
- `createBrowserRouter([...])` / `createHashRouter([...])` / `createMemoryRouter([...])`.
- Экспорт `RouteObject[]` или `const routes: RouteObject[] = [...]`.
- Переменная, матчащая AST-форму `[{ path: ..., element|lazy|children: ... }, ...]`.

Опционально через конфиг: явно указать entry points (`routeResolution.entryPoints: string[]`) — тогда auto-detection отключается.

**4.7.2 Page Component Extraction.**

Для каждого route entry извлекается page-компонент по правилам:

| Форма route entry | Page component resolution |
|-------------------|---------------------------|
| `{ path, element: <Foo/> }` | Foo → резолв через ImportMap |
| `{ path, element: isFlag ? <A/> : <B/> }` | Обе ветки: A и B (branch enumeration, как в 5.4) |
| `{ path, lazy: () => import('./page') }` | Следование импорту → default export './page' |
| `{ path, Component: Foo }` | Foo → резолв |
| `{ path, children: [...] }` | Рекурсивный обход children, path конкатенируется |
| `[...base, ...feature]` | Следование variable references, depth limit 10, cycle detection |
| `{ path: getPath(...), ... }` | Path динамический → запись пропускается + warning |
| `{ path, element: getComp() }` | Element динамический → page component `unresolved`, route регистрируется с `pageComponent: null` |

**4.7.3 Nested `<Routes>` внутри фич.**

Паттерн декларативного JSX внутри lazy-loaded feature-модуля:
```tsx
// внутри CheckoutFeature.tsx, привязан к /checkout/*
<Routes>
  <Route path="payment" element={<PaymentStep/>} />
  <Route path="confirm" element={<ConfirmStep/>} />
</Routes>
```

В MVP **схлопываются в родительский роут**: `<PaymentStep/>` и `<ConfirmStep/>` привязываются к `/checkout`, без подробной гранулярности `/checkout/payment`. Это сознательное упрощение — гранулярность "страница" соответствует запросу консьюмера ("deep components → корневой роут").

При необходимости полной гранулярности — открытый вопрос 11.x.

**4.7.4 Route Binding через Import Graph.**

1. Построить import-graph для репо: `file → { импортируемые файлы }`.
   - Обход только своего репо, не выходим за его границы.
   - Учитываются статические импорты + динамические `import()` (для lazy-loading).
   - TypeScript path aliases резолвятся.
2. Для каждого page-компонента `P` вычислить reachable set: все файлы, достижимые по import-графу.
3. Для каждого файла `F` в репо вычислить:
   ```
   reachingRoutes(F) = { route.path | F ∈ reachableSet(route.pageComponent) }
   ```
4. Назначить `route` каждому usage'у в `F`:
   - `reachingRoutes(F) == ∅` → `{ kind: 'unmapped' }`.
   - `|reachingRoutes(F)| == 1` → `{ kind: 'bound', path }`.
   - `|reachingRoutes(F)| > 1` → `{ kind: 'shared', paths: [...] }`.

**4.7.5 Edge Cases.**

| Кейс | Поведение |
|------|-----------|
| Репо без React Router | Все usage'и → `{ kind: 'unsupported' }` |
| Route-конфиг найден, но page-компонент не резолвится | Route регистрируется, но не участвует в binding'е; usage'и получают `unmapped` с warning |
| Циклический импорт | Cycle detection через visited set; граф остаётся DAG после резолва |
| Page-компонент импортирует сам себя (рекурсивный компонент) | Не проблема — reachable set включает сам файл, всё штатно |
| Usage в файле с route-конфигом (например, `<DefaultFallback/>` прямо в роуте) | Файл входит в собственный reachable set, usage bound к этому роуту |

### 4.8 Stage 8: Aggregate

Вычисление derived-метрик (раздел 7) из классифицированного + route-tagged датасета. Output — JSON-агрегаты + инварианты.

---

## 5. Classification Logic

### 5.1 Shadow-сигналы

| Сигнал | Правило | Уровень shadow |
|--------|---------|----------------|
| `wraps-with-customization` | Local компонент импортирует Beaver + передаёт `className`/`style`/`css` ИЛИ применяет `styled(BeaverX)` | `possible` (strong) |
| `standalone-styled` | Local компонент использует `styled.button` / `emotion.styled` / `@emotion/styled` без Beaver-импорта | `possible` |
| `primitive-like-name` | Имя компонента матчится whitelist (`Button`, `Input`, `Select`, `Checkbox`, ...) | повышает до `confirmed` если + substantial-markup |
| `substantial-markup` | ≥ 5 JSX-элементов в source | усиливает `confirmed` |
| `reusable-local` | Используется в ≥ 2 файлов | `likely` |
| `multi-route` | (v2, требует route resolver) | `likely` |
| `parallel-layer` | Лежит в директории `ui/`, `components/ui/`, `shared/ui/`, `kit/` | `possible` |

**Логика уровней:**
- `confirmed`: нет Beaver-импортов в компоненте + `primitive-like-name` + `substantial-markup`.
- `likely`: нет Beaver-импортов + (`reusable-local` OR `multi-route`), но не confirmed.
- `possible`: любой другой shadow-сигнал сработал, но не выше.

Сигналы — функция от source + aggregated profile. Детерминистично.

### 5.2 Primitive-name whitelist

Дефолт (конфигурируется):
`Button`, `Input`, `TextField`, `Select`, `Checkbox`, `Radio`, `Switch`, `Toggle`, `Text`, `Heading`, `Title`, `Label`, `Icon`, `Avatar`, `Badge`, `Tag`, `Chip`, `Card`, `Modal`, `Dialog`, `Drawer`, `Tooltip`, `Popover`, `Popup`, `Menu`, `Dropdown`, `Tab`, `Tabs`, `Panel`, `Accordion`, `Divider`, `Spacer`, `Stack`, `Flex`, `Grid`, `Box`, `Container`, `Alert`, `Notification`, `Toast`, `Skeleton`, `Spinner`, `Loader`, `Progress`.

Whitelist можно **переопределить per-repo** — например, если в репо есть доменный компонент `Card` (карточка выплаты), который не про UI, его имя можно исключить.

### 5.3 Neither-эвристики

| Эвристика | Имя матчит | Макс. JSX-элементов |
|-----------|-----------|---------------------|
| `provider-context` | `*Provider`, `*Context`, `*Gate` | N/A |
| `hook-like` | `use*` (возвращает JSX, но "use" префикс) | N/A |
| `data-component` | `*Query`, `*Mutation`, `*Fetcher`, `*Loader`, `*Data` | ≤ 2 |
| `layout-wrapper` | `*Layout`, `*Page`, `*Template`, `*Shell`, `*Scaffold` | ≤ 3 |
| `business-container` | `*Container`, `*Wrapper` | N/A |

Эвристики применяются **до** shadow-сигналов. Если матч — компонент в `neither`, даже если имеет primitive-name.

### 5.4 Dynamic usage

Резолвим статически:
- `React.createElement(Button, props)` → пишется как использование `Button`.
- `const C = Button; <C/>` → локальный алиасинг резолвится.
- `<Comp {...props}/>` → identity `Comp` не меняется, spread не влияет.

**Branch enumeration (тернарники, 1 уровень вложенности):**
- `const C = cond ? A : B; <C/>` → **обе ветки** пишутся как usage с флагом `resolution: 'dynamic-branch'`. Обе идут в метрику.
- Вложенные тернарники (`cond1 ? A : cond2 ? B : C`) НЕ раскрываются — помечаются `unresolved-dynamic`.

**Не анализируются в MVP:**
- `if/else` с return разных компонентов → `unresolved-dynamic`.
- `switch` с разными case-компонентами → `unresolved-dynamic`.

**Unresolved (не идут в метрику, трекаются отдельно):**
- `<components[variant]/>` — lookup по строке.
- `React.createElement(getComponent(name), ...)` — динамический lookup.
- `styled(ExternalHOC(Comp))` — HOC из внешнего пакета без prescan.
- Spread-component: `const Comp = spreadSomewhere; <Comp/>`.
- Member expressions (`<Subheader.Actions/>`) — `reason: 'member-expression-not-supported'`.

Запись в датасет:
```jsonl
{"kind":"unresolved-dynamic","repoId":"...","filePath":"...","line":42,"reason":"lookup-by-string","context":"components[variant]"}
```

Warning в CLI, если `unresolved` > threshold (дефолт: 5% от всех usage'ей per-repo). Warnings пишутся в `warnings.json`.

### 5.5 JSX member expressions

`<Form.Item/>`:
- Если `Form` резолвится в Beaver-пакет — использование канонизируется как `beaver:@beaver-ui/form:Form.Item`.
- Пока в MVP такой структуры у Beaver нет (раздел 3.1, вариант 3). Встретится в данных — `unresolved-dynamic / member-expression-not-supported` + логирование (open question возвращается).

---

## 6. Dataset & Output

### 6.1 Instance-level JSONL (основной датасет)

Формат: JSON Lines (одна запись = одна строка). Файл: `dataset.jsonl`.

Схема записи (usage):
```typescript
interface UsageRecord {
  schemaVersion: "1.1";
  kind: "usage";
  repoId: string;
  filePath: string;          // relative to repo root
  line: number;
  column: number;
  componentName: string;     // "Button", "SideNavigation"
  category: "beaver" | "local" | "local-library" | "third-party" | "html-native";
  bucket: "adoption" | "shadow" | "neither";
  shadowLevel?: "confirmed" | "likely" | "possible";  // only if bucket=shadow
  classificationSource: ClassificationSource;
  // Beaver-specific
  beaverPackage?: string;            // "@beaver-ui/side-navigation"
  canonicalizedVia?: string;         // "@beaver-ui/components" (aggregator)
  // Local-lib-specific
  localLibId?: string;
  beaverBackedByLib?: boolean;
  // Route binding
  route:
    | { kind: "bound"; path: string }
    | { kind: "shared"; paths: string[] }
    | { kind: "unmapped" }
    | { kind: "unsupported" };
  // Diagnostic
  resolution: "static" | "dynamic-branch";
}
```

**Component-level records.** Помимо per-usage записей, датасет содержит записи о самих shadow-компонентах (один компонент = одна запись), с полями для будущего AI-слоя:

```typescript
interface ShadowComponentRecord {
  schemaVersion: "1.1";
  kind: "shadow-component";
  // Identity
  repoId: string;
  filePath: string;
  componentName: string;
  // Signature (AI-ready, NDA-safe)
  signature: {
    propNames: string[];             // имена пропсов из type annotation
    jsxElementCount: number;
    localImports: string[];          // имена компонентов-импортов из того же репо
    beaverImports: string[];         // прямые Beaver-импорты внутри компонента
    htmlTags: string[];              // DOM-теги, встретившиеся в JSX
    usesStyled: boolean;             // styled-components / emotion
  };
  // Path hint (domain signal for AI)
  pathHint: {
    directorySegments: string[];     // ["src", "features", "checkout", "ui"]
    feature: string | null;          // эвристика: верхний "features/*" сегмент
  };
  // Code snippet (internal LLM → NDA ok)
  codeSnippet: string;               // исходник компонента, ≤ 200 строк; > 200 → truncate + флаг
  codeSnippetTruncated: boolean;
  // Future AI layer — пустой слот в MVP
  beaverCandidateMapping: {
    candidatePackage: string | null;    // заполняется внешним процессом (LLM)
    candidateComponent: string | null;
    confidence: number | null;          // 0..1
    source: "manual" | "llm-embedding" | "llm-reasoning" | null;
  };
  embedding: number[] | null;           // заполняется отдельной стадией
  // Aggregates
  usageCount: number;                // сколько раз используется в этом же репо
  filesUsedIn: number;
  shadowLevel: "confirmed" | "likely" | "possible";
  signals: string[];
}

interface UnresolvedRecord {
  schemaVersion: "1.1";
  kind: "unresolved-dynamic";
  repoId: string;
  filePath: string;
  line: number;
  reason: "lookup-by-string" | "member-expression-not-supported" | "external-hoc" | "spread-component" | "nested-ternary" | "if-else-branch" | "switch-branch";
  context: string;  // short code signature, no full source
}
```

**Про `codeSnippet`:** tech-constraint снят — AI-слой будет на внутреннем T-Bank LLM, NDA-safe. Сниппет хранится для будущих embeddings / reasoning. В MVP не используется сканером, но пишется в датасет.

**Про `beaverCandidateMapping` и `embedding`:** в MVP остаются `null`. Заполняются отдельной стадией (не частью сканера) — процесс вызывает LLM, читает `signature + codeSnippet`, пишет маппинг. Сканер не знает ничего про LLM.

### 6.2 Derived Aggregates (JSON)

Файл: `aggregates.json`. Генерируется из `dataset.jsonl` отдельной стадией.

Структура:
```typescript
interface Aggregates {
  schemaVersion: "1.1";
  meta: {
    scannerVersion: string;
    scannedAt: string;              // ISO
    scanDurationMs: number;
    beaverVersion: string;          // git tag preferred ("v0.238.5"), fallback SHA
    reposScanned: number;
    filesScanned: number;
  };
  metrics: {
    globalAdoption: { value: number; formula: string };       // A
    perRepoAdoption: Array<{ repoId: string; value: number }>;// B
    shadowLandscape: {                                        // C
      byFile: ShadowByFile[];        // per-file: одна запись = один shadow-файл
      byComponent: ShadowByComponent[]; // per-component: агрегация по имени+signature через репо
    };
    beaverCoverage: Array<{ package: string; reposUsing: number; instances: number }>; // D
    perRouteAdoption: Array<{                                 // E
      repoId: string;
      routePath: string;
      value: number;
      adoptionInstances: number;
      shadowInstances: number;
    }>;
    sharedComponentsAdoption: Array<{
      repoId: string;
      filePath: string;
      componentName: string;
      sharedAcrossRoutes: string[];
      bucket: "adoption" | "shadow" | "neither";
    }>;
  };
  invariants: InvariantReport;
  warnings: Warning[];
}

// Per-file: одна строка = один shadow-файл в конкретном репо.
// Use case: локальный migration task (какой файл переписывать).
interface ShadowByFile {
  repoId: string;
  filePath: string;
  componentName: string;
  level: "confirmed" | "likely" | "possible";
  signals: string[];
  usageCount: number;
  filesUsedIn: number;
  primaryRoute:
    | { kind: "bound"; path: string }
    | { kind: "shared"; paths: string[] }
    | { kind: "unmapped" }
    | { kind: "unsupported" };
}

// Per-component: агрегация по ключу (componentName + signature hash) через репо.
// Use case: стратегические решения Beaver-команды ("кнопку переизобрели в 23 репо").
// MVP: signature hash = hash(componentName + sorted(propNames) + jsxElementCount bucket).
// v2: замена на embedding-based similarity.
interface ShadowByComponent {
  groupKey: string;                  // computed from signature
  componentName: string;
  level: "confirmed" | "likely" | "possible";
  reposCount: number;                // в скольких репо встречается
  totalUsages: number;               // суммарное usageCount по всем репо
  implementations: Array<{           // все найденные реализации
    repoId: string;
    filePath: string;
  }>;
  candidateBeaverPackage: string | null;  // в MVP null, заполняется AI-слоем
}
```
```

### 6.3 HTML Viewer

Артефакт: `report.html` — self-contained один файл (inlined CSS/JS, vanilla, без фреймворков).

Содержимое (MVP):
- Header: метаданные (scan date, Beaver version, repos scanned).
- Hero-блок: 4 метрики (A, B mean, C confirmed-count, D coverage).
- Секция A: Global Adoption — число.
- Секция B: Per-repo Adoption — таблица (репо, adoption%, shadow%).
- Секция C: Shadow Landscape — **дефолтный вид: per-component** (имя компонента, уровень, сколько репо, суммарные использования). Переключатель на per-file view.
- Секция D: Beaver Coverage — таблица пакетов (package, reposUsing, instances).
- Секция E: Per-Route Adoption — таблица (репо, роут, adoption%, число инстансов); топ shared-компонентов.

Обоснование дефолтного view в C: migration backlog работает на уровне "какие компоненты добавить в Beaver" (стратегическое решение), per-file нужен только когда уже решено мигрировать конкретную реализацию.

**Не входит в MVP:** фильтры, сортировки, drill-down, графики — это ответственность BI.

HTML читает данные из `aggregates.json` через inline-инжект (один файл, без fetch).

### 6.4 Schema Versioning

- Каждая запись датасета содержит `schemaVersion`.
- Major bump (1.x → 2.0) — breaking change для BI-консьюмеров.
- Minor bump (1.0 → 1.1) — добавление опциональных полей, backward-compatible.
- Текущая версия: `1.1` (bumped from 1.0: добавлены `ShadowComponentRecord` с AI-ready полями).

### 6.5 CLI Output Modes

```bash
beaver-scan run --config ./.beaver-scan.config.ts
# полный pipeline: клонирование → scan → dataset.jsonl + aggregates.json + report.html

beaver-scan aggregate --dataset ./results/dataset.jsonl --out ./results/
# только пересчёт агрегатов из датасета

beaver-scan viewer --aggregates ./results/aggregates.json --out ./results/report.html
# только HTML из агрегатов

beaver-scan update
# git pull для всех репо в .cache/repos/ и .cache/beaver-ui/

beaver-scan clean
# удалить .cache/
```

---

## 7. Metrics

Все метрики детерминированы, формулы документированы в выходе.

### 7.1 Метрика A — Global Adoption Rate

```
A = Σ(bucket=adoption) / (Σ(bucket=adoption) + Σ(bucket=shadow))
```

Считается по всем 100 репо. Знаменатель — `adoption + shadow`, `neither` не участвует.

### 7.2 Метрика B — Per-Repo Adoption Rate

Та же формула, вычисленная для каждого `repoId` отдельно. В отчёте — рейтинг репо.

### 7.3 Метрика C — Shadow Landscape (Migration Backlog)

Не формула, а **два датасета**, предназначенные для migration backlog:

**C.1 — Per-component (основной).** Агрегация по `groupKey = hash(componentName + sorted(propNames) + jsxElementCount_bucket)`. Одна запись = один "тип shadow-компонента" через все репо.

Поля: `componentName`, `level`, `reposCount`, `totalUsages`, `implementations[]`, `candidateBeaverPackage` (в MVP null).

**Use case:** Beaver-команда решает, какие компоненты **добавить в Beaver** (топ по `reposCount × totalUsages`).

**C.2 — Per-file.** Одна запись = один файл с shadow-компонентом в конкретном репо.

**Use case:** точечные миграционные задачи после решения "мигрируем X" — какие файлы переписывать.

**Про группировку в C.1:** в MVP группировка heuristic'ная (по имени + сортированным пропсам). Это грубо: `Button` с пропсами `[onClick, size]` и `Button` с пропсами `[onClick, size]` в разных репо попадут в одну группу, даже если тело разное.

В v2 — замена группировки на **embedding-based similarity** через внутренний T-Bank LLM. Схема датасета уже закладывает слот `embedding` в `ShadowComponentRecord` (см. 6.1).

**Candidate Beaver-замена** (`candidateBeaverPackage`) в MVP всегда `null`. Заполняется отдельным процессом после сканирования (LLM читает `codeSnippet` + `signature`, предлагает пакет).

### 7.4 Метрика D — Beaver Package Coverage

Для каждого Beaver-пакета:
- `reposUsing` — в скольких из 100 репо импортируется хоть раз.
- `instances` — общее число JSX-использований.

Используется для решений "какой пакет deprecate", "какой недопромоушен".

### 7.5 Метрика E — Per-Route Adoption

Для каждой пары `(repoId, routePath)`:

```
E(r, p) = Σ(bucket=adoption ∧ route.kind=bound ∧ route.path=p ∧ repoId=r) /
          (Σ(bucket∈{adoption,shadow} ∧ route.kind=bound ∧ route.path=p ∧ repoId=r))
```

**Важные правила подсчёта:**

- В знаменатель идут только usage'и c `route.kind === 'bound'`. Shared и unmapped — **не участвуют** в per-route метрике.
- Shared-компоненты трекаются отдельно (`sharedComponentsAdoption` в агрегатах) — их adoption важен, но они не принадлежат одному роуту.
- Unmapped usage'и (глобальные провайдеры, app shell) — в per-route не попадают, но остаются в глобальной метрике A.
- Unsupported репо (без резолва роутов) — не дают записей в E.

Используется для:
- Приоритизации миграций (роуты с низким adoption + высоким бизнес-весом).
- Shadow prioritization: shadow-компонент на `/checkout` заметнее, чем на `/admin/debug`.
- Navigation coverage (какие разделы на Beaver, какие legacy).

Business impact weighting (traffic-aware) — **не делается сканером**, BI применяет веса к метрике E.

---

## 8. Operational Model

### 8.1 Deployment

**MVP (Фаза 1):**
- Локальный запуск на машине Stanislav.
- Клонирование репо SSH: `ssh://git@gitlab.tbank.ru:7999/{group}/{repo}.git`, `--depth=1 --single-branch`.
- Структура кэша:
  ```
  .cache/
  ├── repos/          # consumer-репо
  │   ├── consumer-app-1/
  │   └── ...
  └── beaver-ui/      # Beaver
  ```
- Повторный запуск: репо из кэша используются как есть (команда `beaver-scan update` делает `git pull`).
- Beaver-версия фиксируется через `git describe --tags --always`.

**Phase 2 (после MVP):**
- Выделенный runner.
- Cron: раз в 1–2 недели, полное клонирование + скан + удаление клонов.
- Репо-список — auto-discovery через GitLab API.

### 8.2 Performance Requirements

Целевые:
- Полный scan 100 репо × ~5000 файлов (средн.) = ~500k файлов: **< 30 минут** на Phase 2 runner.
- Beaver prescan (один раз на scan): **< 60 секунд**.
- Генерация агрегатов из JSONL: **< 1 минута**.

Для достижения:
- Worker pool: `child_process.fork()` на `Math.max(1, os.cpus().length - 1)` воркеров.
- Воркеры получают пути к файлам, AST строится внутри воркера (минимизация serialization overhead).
- JSONL пишется streaming'ом (newline-delimited) по мере обработки — не грузим весь датасет в память.
- AST-кэш **не используется** в MVP (скан раз в 1–2 недели не окупает сложность).

**Incremental scan — не в MVP**, добавляется в Phase 2 при необходимости.

### 8.3 Error Handling (Degradation Strategy)

| Ошибка | Поведение |
|--------|-----------|
| Один файл не парсится | Skip файл, warning в `warnings.json`, scan продолжается |
| Beaver prescan упал | **Fail fast** — без prescan сканер не может канонизировать импорты и строить re-export map |
| Local-lib prescan упал (битый `local-path`) | Либа помечается как `prescan-failed`, компоненты из неё идут в обычный этап B классификации |
| Invalid config (битый TS / missing fields) | **Fail fast**, exit code 2, Zod-ошибка |
| Git clone fails (network, auth, missing repo) | **Fail fast**, stderr git как есть, exit code 3. Никаких retry. |
| Per-repo конфиг отсутствует | Fail fast для этого репо (конфиг обязателен — нет дефолтов per-repo) |

**Продуктовое обоснование no-retry / fail-fast на clone:** MVP-запуски редкие (раз в 1–2 недели), Stanislav запускает лично. Лучше упасть с понятной git-ошибкой, чем молча пропустить один репо из 100 и получить искажённую цифру в OKR-метрике.

### 8.4 Detruminism

- Стабильная сортировка usage'ей по `(repoId, filePath, line, column)` перед записью в датасет.
- Параллелизм не влияет на итоговый порядок (merge-sort после обработки).
- Prescan Beaver фиксирует git SHA — один SHA → один props registry → одна классификация.
- Никакого wall-clock timestamping внутри классификации (только в meta).

---

## 9. Configuration

### 9.1 Global Config

Файл: `.beaver-scan.config.ts` (TypeScript — гибкость, комментарии, автокомплит через Zod-схему).

```typescript
interface GlobalConfig {
  // Beaver definition
  beaverUrl: string;                 // SSH URL до Beaver репо

  // Repos discovery
  repositoriesFile: string;          // default: './repositories.json'
  // Структура repositories.json:
  // [{ "name"?: string, "gitUrl": "ssh://..." }, ...]

  // Output
  output: {
    dir: string;
    formats: Array<'jsonl' | 'aggregates' | 'html'>;  // default: all
  };

  // Thresholds
  thresholds: {
    reusableLocalFiles: number;           // default: 2
    substantialMarkupElements: number;    // default: 5
    unresolvedDynamicWarningPct: number;  // default: 0.05
    shadowFalsePositiveTarget: number;    // default: 0.15
    codeSnippetMaxLines: number;          // default: 200
  };

  // Route resolution
  routeResolution?: {
    enabled?: boolean;                    // default: true
    router?: 'react-router-v6';           // default: 'react-router-v6'
    entryPoints?: string[];               // glob patterns; auto-detect if omitted
    propagationBoundary?: 'repo' | 'src'; // default: 'repo'
    importGraphDepthLimit?: number;       // default: 20
    collapseNestedRoutes?: boolean;       // default: true
  };

  // Patterns
  primitiveNames?: string[];              // override default list
}
```

Валидация — **Zod**, fail fast при невалидном конфиге (exit code 2) с понятной ошибкой.

### 9.2 Per-Repo Config

Файл: `.beaver-scan.json` в корне каждого репо (**обязательный**, нет дефолтов — явное объявление scope'а и localLibraries требуется от консьюмер-команд).

```typescript
interface PerRepoConfig {
  include?: string[];            // glob patterns, default: ['src/**/*.{ts,tsx,js,jsx}']
  exclude?: string[];            // glob patterns, extends defaults
  tsconfig?: string;             // default: 'tsconfig.json'
  
  localLibraries?: Array<{
    libId: string;
    matchPattern: string;        // glob или package name
    source: { type: 'local-path'; path: string };  // в MVP только local-path
    kind: 'partially-beaver-backed' | 'fully-custom';
  }>;

  // Route resolution per-repo override
  routeResolution?: {
    enabled?: boolean;
    entryPoints?: string[];
  };

  // Overrides
  primitiveNamesOverride?: string[];
}
```

JSON-формат выбран сознательно: команды консьюмеров заполняют конфиг без необходимости `ts-node` / `esbuild`, нет зависимости от TS-инструментария в их репо.

Битый per-repo config → fail fast для этого репо (не молчаливый skip), exit code 2. Иначе scan будет считать репо без localLibraries → искажённая метрика.

### 9.3 Config Precedence

1. CLI flags (override всё).
2. Per-repo config (обязательный).
3. Global config.
4. Built-in defaults.

### 9.4 Unsupported Stacks

**В MVP не детектируются.** Список `repositories.json` контролируется Stanislav вручную — не-React репо туда просто не добавляются. Если случайно добавлено non-React репо — сканер упадёт на парсинге JSX, что и является сигналом.

---

## 10. Invariants & Testing

### 10.1 Domain Invariants

Проверяются после Stage 7, фейлят scan (exit 3) если не указано `--no-fail-on-invariant`:

1. **Mutual exclusivity:** каждый usage имеет ровно один `bucket`.
2. **No orphan classification:** `classificationSource` не `unclassified`.
3. **Shadow level consistency:** `shadowLevel` присутствует ⟺ `bucket === 'shadow'`.
4. **Beaver package canonicalization:** `beaverPackage` обязателен для `category === 'beaver'`.
5. **Dataset completeness:** число записей в датасете = сумме inst. по всем агрегатам (C/D).
6. **Schema version fixed:** все записи с одним `schemaVersion`.
7. **Route presence:** каждый usage имеет поле `route` (одно из 4 kind'ов).
8. **Per-route denominator correctness:** метрика E считается только по `route.kind === 'bound'`.
9. **Determinism check (опционально):** хэш датасета от двух последовательных запусков с одним SHA Beaver и одним SHA репо — одинаковый.

Инварианты 3 и 7 из v1 PRD (`Direct ≤ Effective`, `Transitive not overridden`) **убраны** как тавтологии / патчи архитектуры.

### 10.2 Fixture-based Tests

Тестовый подход — через фикстуры-репо в `tests/fixtures/`:
- `fixture-pure-adoption/` — репо с 100% прямых Beaver-импортов.
- `fixture-wrapper-adoption/` — композиция Beaver без кастомизации.
- `fixture-wrapper-customized/` — `className` передаётся в Beaver → должно быть shadow.
- `fixture-styled-beaver/` — `styled(Button)` → shadow.
- `fixture-shadow-primitive/` — локальный Button без Beaver → confirmed shadow.
- `fixture-layout-wrapper/` — div c flex вокруг Beaver → adoption-wrapper.
- `fixture-aggregator-package/` — импорт через `@beaver-ui/components` → канонизация.
- `fixture-dynamic-resolvable/` — branch enumeration.
- `fixture-dynamic-unresolvable/` — `components[variant]` → unresolved.
- `fixture-local-lib-backed/` — per-repo local-library с Beaver-backing.
- `fixture-local-lib-custom/` — fully-custom либа.
- `fixture-route-data-router/` — `createBrowserRouter` с RouteObject-конфигами.
- `fixture-route-lazy-loading/` — lazy-loaded feature-роуты.
- `fixture-route-nested-routes/` — вложенные `<Routes>` внутри фичи (проверка схлопывания).
- `fixture-route-shared-component/` — `<Header>` используется на 2+ роутах (проверка `kind: shared`).
- `fixture-route-unmapped/` — провайдеры и utils, недостижимые от page-компонентов.
- `fixture-route-conditional-element/` — `element: flag ? <A/> : <B/>` (branch enumeration на роутах).
- `fixture-route-dynamic-path/` — динамический path (должен скипаться с warning).
- `fixture-route-spread-routes/` — `[...base, ...feature]` (variable following).

Каждое правило классификации покрывается минимум одной фикстурой.

### 10.3 False-Positive Rate SLA

- Выборка: 50 случайных компонентов из `shadow`-бакета, ручной review Stanislav + команды.
- Метрика: % компонентов, которые ручной review счёл НЕ shadow.
- Цель MVP: ≤ 15%.
- Измеряется после первого полного scan'а. Если превышает — тюнинг порогов и whitelist.

---

## 11. Open Questions

Фиксируются явно, решаются после MVP-запуска:

1. **OKR-метрика.** Привязка к A / B / C / D / E — не определена. Решение после первого скана и обсуждения с менеджментом.
2. **BI-формат входа.** Подтверждено JSONL как дефолт; если T-Bank BI требует Parquet/CSV — добавить конвертер.
3. **Момент deprecation HTML-viewer.** Зависит от готовности BI.
4. **Runner deployment.** MVP — локально; детали Phase 2 (какой runner, где хранится history) — не в MVP.
5. **Auto-discovery репо через GitLab API.** Phase 2.
6. **Props registry через TS compiler API.** В MVP не строится. В v2 — для точного различения "передан ли кастомный проп, не входящий в Beaver API" vs "легитимный проп из Beaver". Пока MVP работает пуристски (любой className/style = shadow).
7. **AI-слой для mapping shadow → Beaver-кандидат.** Схема датасета готова (`embedding`, `codeSnippet`, `beaverCandidateMapping`). Сам процесс вызова внутреннего T-Bank LLM — отдельная стадия, вне scope сканера. Когда LLM-интеграция будет готова — `beaverCandidateMapping` заполняется.
8. **Embedding-based shadow similarity в метрике C.** Пока группировка через heuristic hash по signature. В v2 — через embedding vectors (снимает false positives в кросс-репо группировке).
9. **Granular nested routes.** Схлопывание `<Routes>` в родительский роут — ок для MVP. Если потребуется гранулярность `/checkout/payment` vs `/checkout/confirm` — расширение резолвера.
10. **Next.js роутинг.** Если часть консьюмер-репо перейдёт на Next.js — отдельный резолвер.
11. **Route business weighting.** Per-route adoption как есть, traffic-based веса делает BI.
12. **Programmatic API Beaver** (`notification.open()`, `Modal.confirm()`). Пока не актуально. Если появится — расширение бакет-модели: `programmatic-adoption`.
13. **Third-party shadow detection.** Сейчас `third-party` без Beaver-backing → `neither`. Если нужно ловить "команда принесла antd мимо Beaver" — вводится отдельный сигнал.
14. **Local-lib sources beyond local-path.** В MVP только `local-path`. `git` и `npm` источники — v2, когда появятся реальные use cases.
15. **Member expressions** (`<Subheader.Actions/>`). Все → `unresolved-dynamic` в MVP. Если в `warnings.json` таких случаев > порога — расширение резолвера.

---

## 12. Out of Scope

- Vue / Angular / Svelte / Solid.
- Next.js роутинг (App Router / Pages) — только React Router v6 в MVP.
- Runtime usage tracking.
- Visual regression / design diff.
- Automated refactoring / codemod предложения.
- Multi-DS (только Beaver на MVP).
- Эмбеддинги / семантическое сравнение компонентов.
- AI-классификация.
- Storybook / visual coverage analysis.
- Traffic-based / business impact веса на метрике E.
- Sub-page гранулярность вложенных `<Routes>`.
- Поддержка JS-only репо в части prescan props registry (для них деградация: все shadow-сигналы работают, props registry нет → больше false positives).

---

## 13. Glossary

| Термин | Определение |
|--------|-------------|
| **Beaver** | T-Bank design system, composite layer поверх TUI |
| **Package** | Единица Beaver — npm-пакет (`@beaver-ui/button`) |
| **Aggregator package** | Beaver-пакет, который re-exports другие Beaver-пакеты |
| **Adoption** | Прямое использование Beaver или обвязка без кастомизации UI |
| **Adoption-wrapper** | Локальный компонент, импортирующий Beaver без визуальной кастомизации |
| **Shadow** | Локальный компонент, дублирующий функциональность Beaver |
| **Neither** | Утилитарные компоненты (providers, hooks, containers) |
| **Props registry** | Карта `ComponentName → PropNames[]`, извлекаемая из Beaver prescan через TS compiler |
| **Canonicalization** | Приведение импорта через агрегатор к исходному пакету |
| **Instance-level** | Гранулярность датасета: одна запись = одно JSX-использование |
| **Derived aggregate** | Метрика, вычисленная поверх instance-level датасета |
| **Per-repo config** | Конфиг в корне консьюмер-репо, оверрайдит global |
| **Beaver-backed** | Local-library компонент, в источнике которого есть Beaver-импорт |
| **Page component** | Компонент, указанный в `element` или `lazy` RouteObject'а |
| **Route binding** | Привязка usage'а к роуту через import-graph от page-компонента |
| **Shared component** | Файл, достижимый от 2+ page-компонентов по import-графу |
| **Unmapped** | Файл, недостижимый от ни одного page-компонента (app shell, utils) |

---

## 14. Appendix

### 14.1 Example Configs

**Global config (`.beaver-scan.config.ts`):**
```typescript
import { defineConfig } from 'beaver-scan';

export default defineConfig({
  beaverUrl: 'ssh://git@gitlab.tbank.ru:7999/beaver-ui/beaver-ui.git',
  repositoriesFile: './repositories.json',
  output: { dir: './results', formats: ['jsonl', 'aggregates', 'html'] },
  thresholds: {
    reusableLocalFiles: 2,
    substantialMarkupElements: 5,
    unresolvedDynamicWarningPct: 0.05,
    shadowFalsePositiveTarget: 0.15,
    codeSnippetMaxLines: 200,
  },
  routeResolution: {
    enabled: true,
    router: 'react-router-v6',
    collapseNestedRoutes: true,
  },
});
```

**`repositories.json`:**
```json
[
  {
    "name": "consumer-app-1",
    "gitUrl": "ssh://git@gitlab.tbank.ru:7999/consumer/app-1.git"
  },
  {
    "gitUrl": "ssh://git@gitlab.tbank.ru:7999/consumer/app-2.git"
  }
]
```

**Per-repo config (`.beaver-scan.json` в корне консьюмер-репо):**
```json
{
  "exclude": ["src/legacy/**"],
  "localLibraries": [
    {
      "libId": "team-ui-kit",
      "matchPattern": "src/shared/ui-kit/**",
      "source": { "type": "local-path", "path": "src/shared/ui-kit" },
      "kind": "partially-beaver-backed"
    },
    {
      "libId": "legacy-components",
      "matchPattern": "src/shared/legacy-ui/**",
      "source": { "type": "local-path", "path": "src/shared/legacy-ui" },
      "kind": "fully-custom"
    }
  ],
  "routeResolution": {
    "entryPoints": ["src/app/router.tsx", "src/features/**/routes.ts"]
  }
}
```

### 14.2 JSONL Schema (formal)

См. раздел 6.1.

### 14.3 Decision Log (v1 → v2)

| Решение | v1 | v2 | Почему |
|---------|----|----|--------|
| Главный артефакт | HTML dashboard | JSONL instance-level | Будущий BI требует низкоуровневый датасет |
| Единица adoption | Компонент | Пакет Beaver | Соответствует структуре Beaver (Nx + npm workspaces) |
| Shadow granularity | Binary | Three-level (confirmed/likely/possible) | Консьюмер хочет фильтровать по уверенности |
| Shadow landscape unit | Per-file | Per-component (default) + per-file | Migration backlog работает на уровне "какие компоненты добавить в Beaver" |
| Shadow bucket semantics | Прагматичный (whitelist CSS) | **Пуристский** (любой className/style → shadow) | Продуктовая позиция Beaver-команды: "нет пропса → бэклог Beaver, не повод прощать className" |
| Props registry | TS compiler API для точного различения | **Отключён в MVP** | Упрощение MVP; детекция через AST-паттерны достаточна для пуристского подхода; v2 — через TS compiler |
| Layout CSS whitelist | Есть | **Удалён** | С пуристским подходом не нужен — граница через substantial-markup < 5 |
| AI/embeddings слот | Нет | **Есть** (`embedding`, `codeSnippet`, `beaverCandidateMapping`) | Внутренний T-Bank LLM → NDA-safe; будущий процесс будет заполнять |
| Code snippet в датасете | Нет (NDA concern) | **Есть** (≤ 200 строк) | Внутренний LLM снимает NDA-constraint |
| Classification Pass 2 guard | Есть | Нет | Заменено на разделение input'ов между этапами |
| Invariants | 7 штук, часть — тавтологии | 9 штук, все доменные | `Direct ≤ Effective` и `Transitive not overridden` убраны |
| Library prescan source | git clone on-scan, multiple sources | **Только local-path в MVP**, git/npm — v2 | Упрощение; большинство local-libs в том же репо |
| Barrel recursion | Без cycle detection | Cycle detection + depth limit = 5 | Защита от stack overflow |
| Route resolution | 4 резолвера + confidence downgrade | 1 резолвер под React Router v6 data-router | Покрытие 99% кейса без false positives универсального резолвера |
| Nested route granularity | Полная гранулярность | Схлопывание в родительский роут | Запрос "deep components → корневой роут" |
| Dynamic usage | Любые ветки | **Только тернарники 1 уровня**; if/else и switch → unresolved | Упрощение MVP; честный детерминированный подход |
| Error handling | Retry × 3 | **No retry, fail fast** | MVP запуски редкие и ручные, лучше понятная ошибка чем искажённая метрика |
| AST cache | Per-repo | **Нет** | Скан раз в 1–2 недели, кэш не окупается |
| Worker pool | `worker_threads` | **`child_process.fork()`** | Реальная параллелизация на CPU ядрах |
| Unsupported stacks detection | Автоматическая | **Нет** | Список репо вручную контролируется |
| Config validation | Runtime assertions | **Zod** | Автогенерация TS-типов, понятные ошибки |
| Global config format | Не определён | **TypeScript** (`.beaver-scan.config.ts`) | Гибкость, автокомплит |
| Per-repo config format | Не определён | **JSON** (`.beaver-scan.json`) | Команды консьюмеров не нуждаются в TS-тулинге |
| Per-repo config optional | Да | **Обязательный** | Нет дефолтов; явное объявление scope необходимо |
| Beaver version tracking | git SHA | `git describe --tags --always` (тег предпочт., SHA fallback) | Человекочитаемо, семантическое версионирование |
| Git clone options | Не определены | `--depth=1 --single-branch` | Скорость, место |
| Third-party bucket config | `neither | shadow` | Всегда `neither` | Нет семантической связи с Beaver без backing |

---

**END OF PRD v2**
