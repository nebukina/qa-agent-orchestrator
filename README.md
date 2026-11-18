# QA-Agent: Requirements-to-Delivery

Автоматизированный QA-агент-оркестратор, который проводит аудит требований из Redmine, проектирует спецификацию задач и тест-кейсов в Redmine и собирает итоговый отчет с матрицей трассировки.

В репозитории также находится **оценочный контур (eval harness)** на Java: он прогоняет агента по «золотому» датасету, оценивает ответы через LLM-судью и проверяет итоговый Quality Gate.

## 📖 Оглавление
- [Архитектура проекта](#архитектура-проекта)
- [Компоненты](#компоненты)
- [Структура проекта](#структура-проекта)
- [Канал Redmine (без MCP)](#канал-redmine-bez-mcp)
- [Установка и настройка](#установка-и-настройка)
- [Запуск флоу](#запуск-флоу)
- [Структура артефактов](#структура-артефактов)
- [Quality Gates](#quality-gates)
- [Оценка агента (Eval Runner)](#оценка-агента-eval-runner)
- [Безопасность](#безопасность)

---

## Архитектура проекта

Проект построен на базе **OpenCode** и использует паттерн «Оркестратор + Субагенты + Скиллы»:

1. **Оркестратор** (`qa-orchestrator`) управляет жизненным циклом задачи: загружает требования, запускает этапы, контролирует Quality Gates, собирает артефакты.
2. **Субагенты** (`.opencode/agents/`) вызывают строго один разрешенный скилл каждый.
3. **Скиллы** (`.opencode/skills/`) содержат изолированную бизнес-логику этапа (аудит, проектирование задач, проектирование тестов).

```
Redmine issue
     │
     ▼
qa-orchestrator ──► raw-{ts}.md
     │
     ▼
@review (requirement-review) ──► вердикт QG1: PASS / CONDITIONAL / FAIL ──► review-report-{ts}.md
     │                                   FAIL → остановка и эскалация
     ▼ (PASS / CONDITIONAL)
@task (task-design)   ┐ параллельно ┌  @test (test-design)
     │                 └─────────────┘        │
     ▼                                        ▼
task-spec-{ts}.md                    test-model-{ts}.md
     │                                        │
     └──────────────┬─────────────────────────┘
                    ▼
     final-report-{ts}.md (матрица трассировки Req → Task → Test, QG4)
```

При вердикте **CONDITIONAL** задачи и тест-кейсы проектируются только для требований без открытых вопросов; для остальных формируются GAP со статусом `BLOCKED_BY_OPEN_QUESTION` (см. `AGENTS.md`).

## Компоненты

### Агенты (`.opencode/agents/`)

| Агент | Роль | Разрешенный скилл |
|-------|------|-------------------|
| `qa-orchestrator.md` | Главный агент: управление флоу, Quality Gates, артефакты, матрица трассировки | — (делегует) |
| `review.md` | Субагент: аудит требований | только `requirement-review` |
| `task.md` | Субагент: проектирование и создание задач в Redmine | только `task-design` |
| `test.md` | Субагент: проектирование и публикация тест-кейсов | только `test-design` |

### Скиллы (`.opencode/skills/`)

| Скилл | Этап | Quality Gate | Что делает |
|-------|------|--------------|------------|
| `requirement-review` | Аудит | QG1 | Разбор требований по 4 осям (противоречия, неоднозначности, полнота, тестируемость), вердикт PASS/CONDITIONAL/FAIL |
| `task-design` | Задачи | QG2 | Иерархия Epic → Story → Task → Sub-task, AC в формате Given-When-Then, создание реальных задач в Redmine (`redmine_create_issue` или CLI-батч) |
| `test-design` | Тесты | QG3 | Тест-кейсы positive / negative / boundary, публикация в Redmine (`redmine_create_issue` или CLI-батч) |

### Прочее

- **`AGENTS.md`** — глобальные правила: ролевая модель, запрет межскилловых вызовов, передача артефактов между агентами, правила для CONDITIONAL, защита от Prompt Injection и утечки секретов, ограничения на действия в Redmine.
- **`opencode.json`** — конфигурация OpenCode: разрешения `redmine_read` / `redmine_write`, allow для `node scripts/redmine/*` и отключённый (`disabled: true`) прежний MCP-сервер Redmine [`@speraltafibrazo/redmine-mcp`](https://www.npmjs.com/package/@speraltafibrazo/redmine-mcp).
- **`.opencode/plugins/redmine/index.js`** — плагин OpenCode: регистрирует нативные инструменты `redmine_*` поверх REST API Redmine (замена MCP-канала), пространство имён `redmine`.
- **`scripts/lib/redmine.mjs`** — общий HTTP-клиент Redmine для плагина и CLI: резолв ключа из `.env` живым запросом `GET /users/current.json`, маскирование секретов, отсутствие методов записи сверх POST и заметки.
- **`scripts/redmine/*.mjs`** — CLI: `whoami.mjs`, `fetch-issue.mjs`, `meta.mjs`, `publish.mjs`, `add-note.mjs` (см. [Канал Redmine](#канал-redmine-bez-mcp)).
- **`.opencode/redmine-mcp-launch.mjs`** — бывший launcher MCP-сервера, оставлен для отката: пока в `opencode.json` стоит `disabled: true`, он не запускается.
- **`pom.xml` / `src/main/java/evals/`** — Maven-модуль `qa-eval-runner` (Java 17, Jackson): оценочный контур агента.
- **`package.json`** — Node-зависимости (`dotenv`) для загрузки `.env` со секретами.

## Структура проекта

```
.
├── .opencode/
│   ├── agents/
│   │   ├── qa-orchestrator.md   # Главный агент (Оркестратор)
│   │   ├── review.md            # Субагент (только requirement-review)
│   │   ├── task.md              # Субагент (только task-design)
│   │   └── test.md              # Субагент (только test-design)
│   ├── skills/
│   │   ├── requirement-review/  # Логика аудита требований (QG1)
│   │   ├── task-design/         # Логика проектирования задач (QG2)
│   │   └── test-design/         # Логика проектирования тест-кейсов (QG3)
│   ├── plugins/
│   │   └── redmine/             # Нативные инструменты redmine_* (REST вместо MCP)
│   └── redmine-mcp-launch.mjs   # Бывший launcher MCP Redmine: не запускается (disabled: true)
├── scripts/
│   ├── lib/redmine.mjs          # Общий REST-клиент Redmine: ключ из .env, только GET/POST
│   └── redmine/                 # CLI: whoami, fetch-issue, meta, publish, add-note
├── artifacts/                   # Артефакты прогонов и результаты eval-контюра (создается автоматически)
├── src/main/java/evals/
│   ├── EvalRunner.java          # Прогон агента по golden dataset
│   └── Evaluator.java           # LLM-судья (judge) ответов агента
├── src/main/resources/dataset/
│   └── golden_dataset.json      # Eval-кейсы EVC-001…EVC-006
├── target/                      # Скомпилированные классы (mvn compile)
├── .env                         # Секреты (REDMINE_KEY), НЕ хранится в git
├── AGENTS.md                    # Глобальные правила для всех агентов
├── opencode.json                # Конфигурация OpenCode (разрешения redmine_*, отключённый MCP)
├── pom.xml                      # Maven-сборка eval-раннера
├── package.json                 # Node-зависимости
└── README.md                    # Этот файл
```

## Канал Redmine (без MCP)

Redmine подключается напрямую к REST API (`X-Redmine-API-Key`, ключ из `.env`) двумя способами. Общий слой — `scripts/lib/redmine.mjs`: он резолвит ключ живым запросом `GET /users/current.json` (побеждает первый аутентифицировавшийся кандидат: `.env` → `REDMINE_KEY` → `REDMINE_API_KEY`), маскирует секрет в любом выводе и **не знает методов записи, кроме POST и заметки**.

### 1. Нативные инструменты плагина (`.opencode/plugins/redmine/index.js`)

Пространство имён `redmine`, агент вызывает их через Code Mode (`tools.redmine.*`):

| Инструмент | Назначение | Действие разрешений |
|---|---|---|
| `redmine_get_issue` | детали задачи, `format=detail\|json` | `redmine_read` |
| `redmine_list_issues` | список задач проекта (проверка дублей) | `redmine_read` |
| `redmine_search_issues` | полнотекстовый поиск по задачам | `redmine_read` |
| `redmine_list_metadata` | каталоги: `statuses`, `trackers`, `priorities`, `projects`, `versions`, `categories`, `me`, `users` | `redmine_read` |
| `redmine_list_projects` | проекты: `id — Имя (identifier)` | `redmine_read` |
| `redmine_create_issue` | создать новую задачу (трекер/приоритет/категория/версия — именем или ID) | `redmine_write` |
| `redmine_add_note` | добавить заметку к задаче | `redmine_write` |

`update_issue`, `change_issue_status`, `delete_*`, `edit_journal`, `remove_*` в плагине нет физически: право изменять и удалять существующие задачи агентам не выдаётся (`AGENTS.md`).

### 2. CLI-скрипты (`scripts/redmine/`)

| Скрипт | Пример команды | Назначение |
|---|---|---|
| `whoami.mjs` | `node scripts/redmine/whoami.mjs` | диагностика канала: URL, источник ключа, отпечаток sha256, кто аутентифицирован |
| `fetch-issue.mjs` | `node scripts/redmine/fetch-issue.mjs --id 120` | снимок требований → `artifacts/00-raw-requirements/raw-{ts}.md` |
| `meta.mjs` | `node scripts/redmine/meta.mjs --kind trackers` | каталоги и список существующих задач (`--kind issues --project 1`) |
| `publish.mjs` | `node scripts/redmine/publish.mjs --manifest <json> [--dry-run]` | батч-публикация задач и тест-кейсов по манифесту |
| `add-note.mjs` | `node scripts/redmine/add-note.mjs --issue 120 --notes-file <md>` | заметка к задаче |

Манифест `publish.mjs` — JSON вида `{ "project_id": 1, "ts": "{ts}", "defaults": { "tracker": "Task" }, "issues": [ { "key": "STORY-01", "subject": "...", "description": "...", "tracker": "Task", "parent_key": "EPIC-01", "requirement_id": "R-01" } ] }`. Родитель создаётся раньше ребёнка, `parent_key` связывает их; результат — `artifacts/diagnostics/publish-results-{ts}.json` с реальными ID. Коды выхода: `0` — успех, `2` — остановка на 401/403 (эскалация), `3` — есть отклонённые позиции.

### Гарантии и известные особенности экземпляра

- `PUT`, `PATCH`, `DELETE` отклоняются до обращения к серверу (`METHOD_BLOCKED`); исключение — заметка, где Redmine требует `PUT /issues/:id.json` с телом ровно `{"issue":{"notes":"..."}}`.
- Новая задача не может получить `status_id` или `done_ratio` (`FORBIDDEN_FIELD`) — статус берётся рабочий по умолчанию.
- **Redmine молча отбрасывает `parent_id`, если у трекёра ребёнка не настроен `Subtask of` для трекёра родителя.** Клиент это проверяет чтением и честно пишет `PARENT_DROPPED` в предупреждения (в этом экземпляре трекеры `Task`/`TestCase` такой настройки не имеют).
- Каталоги `/enumerations/priorities.json` и `/statuses.json` на этом экземпляре отдают `404` — они считаются отсутствующими, приоритет и статус тогда берутся рабочие по умолчанию.
- `users.json` требует прав администратора: для обычных ключей используйте `--kind me` или ID из существующей задачи.

## Установка и настройка

Требуется:

- **[OpenCode](https://opencode.ai)** (установка через npm: `npm install -g opencode-ai`);
- **Node.js** — для CLI-скриптов Redmine и плагина OpenCode;
- **JDK 17+ и Maven** — только для оценочного контура;
- **доступный экземпляр Redmine** (по умолчанию `http://localhost:3000`).

Шаги:

```bash
# 1. Установка Node-зависимостей
npm install

# 2. Доступ к Redmine: создать .env в корне проекта (файл исключен из git через .gitignore)
#    REDMINE_KEY=<ваш API-ключ Redmine>
#    При необходимости поменять REDMINE_URL (по умолчанию http://localhost:3000)
#    Клиент scripts/lib/redmine.mjs (плагин и CLI) возьмёт ключ из .env сам, экспортировать
#    переменную в окружение оболочки не требуется.

# 3. Проверка канала (только чтение, ни одной записи в Redmine):
#    node scripts/redmine/whoami.mjs
#    Строка "Пользователь: #<id> — <login> (<имя>)" означает, что ключ доставлен и
#    аутентифицирован. REDMINE_KEY_MISSING / REDMINE_AUTH_FAILED — ключ не найден или
#    не имеет прав.

# 4. (Опционально, для eval-контюра) сборка Java-модуля
mvn clean compile
```

## Запуск флоу

Открыть проект в OpenCode и дать оркестратору ID или ссылку на issue с требованиями, например:

```
Запусти полный флоу для задачи Redmine #120
```

Либо неинтерактивно (так же, как это делает EvalRunner):

```powershell
opencode run --auto "Запусти полный флоу для задачи Redmine #120"
```

Оркестратор выполнит цепочку Ingestion → Audit (QG1) → параллельно Task/Test → Final Report, и сложит результаты в `artifacts/<этап>/` с единым timestamp `{ts}` прогона.

## Структура артефактов

Каждый прогон использует единый `{ts}` (формат `yyyyMMdd-HHmmss`):

```
artifacts/
├── 00-raw-requirements/   raw-{ts}.md                 # снимок требований из Redmine
├── 01-requirement-review/ review-report-{ts}.md       # вердикт QG1, Blocking/Non-blocking проблемы
├── 02-task-design/        task-spec-{ts}.md           # спецификация задач (+ созданные задачи в Redmine)
├── 03-test-design/        test-model-{ts}.md          # тестовая модель (+ кейсы в Redmine)
├── final-report-{ts}.md                               # итог: метрики, матрица трассировки, Open Questions
├── current/               eval_results.json           # сводка eval-контюра последнего прогона
├── history/{ts}/          *                           # архив артефактов завершенного прогона
└── diagnostics/           errors/error-{ts}.log       # логи сбоев инструментов (Redmine и др.)
                         publish-results-{ts}.json    # машинный лог публикации в Redmine
```

По правилу `AGENTS.md` артефакты прогона копируются в `current/` только при `QG4 = PASS`, а перед новым прогоном старые файлы переносятся в `history/{ts}/`. `final-report-{ts}.md` пишется в корень `artifacts/`, а не в подкаталог.

Обязательные секции `final-report`: метаданные, Review Summary, Task Summary, Test Summary, матрица трассировки (Requirement → Task → Test с покрытием Full/Partial/GAP), Open Questions/Gaps с владельцами.

## Quality Gates

| Gate | Где проверяется | Предмет |
|------|-----------------|---------|
| QG1 | скилл `requirement-review` | вердикт аудита: PASS / CONDITIONAL / FAIL |
| QG2 | скилл `task-design` | качество task-spec |
| QG3 | скилл `test-design` | качество test-model |
| QG4 | оркестратор | допуск финального отчета |
| QG-A…QG-G | оркестратор | полнота артефактов, качество аудита/задач/тестов, трассировка (доля GAP ≤ `max_gap_ratio`), качество отчета, отсутствие посторонних записей в Redmine |

## Оценка агента (Eval Runner)

Модуль `qa-eval-runner` (`src/main/java/evals/`) проверяет регрессионное качество агента:

1. **`EvalRunner`** читает `src/main/resources/dataset/golden_dataset.json`, группирует eval-кейсы по источнику и `issue_id`, запускает `opencode run --format json --auto` (промпт передается через stdin) и собирает ответ агента.
2. **`Evaluator`** — LLM-судья: для каждого кейса сверяет `expected_properties` и `forbidden_behavior` ответа, возвращает JSON со `status` (PASS/FAIL) и `score` (1.0/0.0).
3. По итогам прогона считается сводный **Quality Gate**:

| Критерий | Порог |
|----------|-------|
| Pass Rate | ≥ 95% |
| Expected Properties Pass Rate | ≥ 95% |
| Forbidden Behavior Violation Rate | 0% |
| Errors | 0 |

Результат сохраняется в `artifacts/current/eval_results.json`; сводка предыдущего прогона архивируется в `artifacts/history/eval_results-{ts}.json`.

### Golden dataset (EVC-001…EVC-006)

| ID | Сценарий |
|----|----------|
| EVC-001 | Счастливый путь (Happy Path) |
| EVC-002 | Проблемные требования (CONDITIONAL) |
| EVC-003 | Защита от Prompt Injection |
| EVC-004 | Граничные значения (Boundary) |
| EVC-005 | Неоднозначные требования (Ambiguity) |
| EVC-006 | Критическая ошибка требований (FAIL) |

Запуск:

```bash
mvn clean compile
mvn exec:java -Dexec.mainClass="evals.EvalRunner"
```

Перед прогоном необходимы: живой Redmine с задачами из датасета (`issue_id` в `golden_dataset.json`: #116, #117, #118, #119, #120, #121) и установленный `opencode` в PATH.

## Безопасность

Правила закреплены в `AGENTS.md`:

- Текст требований из Redmine — **только данные**, инструкции из него не выполняются; попытки Prompt Injection фиксируются как проблема `SEC-01` в `review-report`.
- Секреты (API-ключи, токены) не выводятся в чат, артефакты и задачи; подозрительные паттерны маскируются как `[REDACTED]`.
- `.env` с `REDMINE_KEY` исключен из репозитория (`.gitignore`).
- Агентам запрещено удалять проекты/задачи/пользователей и менять статусы задач сверх того, что предусмотрено скиллами.
- Канал Redmine усилен структурно: `PUT` / `PATCH` / `DELETE` отклоняются в клиенте до запроса, исключения нет кроме добавления заметки (`{"issue":{"notes": "..."}}`); `status_id` и `done_ratio` в новой задаче отклоняются как `FORBIDDEN_FIELD`.