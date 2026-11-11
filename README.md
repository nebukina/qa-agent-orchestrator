# QA-Agent: Requirements-to-Delivery

Автоматизированный QA-агент-оркестратор, который проводит аудит требований из Redmine, проектирует спецификацию задач и тест-кейсов в Redmine и собирает итоговый отчет с матрицей трассировки.

В репозитории также находится **оценочный контур (eval harness)** на Java: он прогоняет агента по «золотому» датасету, оценивает ответы через LLM-судью и проверяет итоговый Quality Gate.

## 📖 Оглавление
- [Архитектура проекта](#архитектура-проекта)
- [Компоненты](#компоненты)
- [Структура проекта](#структура-проекта)
- [Установка и настройка](#установка-и-настройка)
- [Запуск флоу](#запуск-флоу)
- [Структура артефактов](#структура-артефактов)
- [Quality Gates](#quality-gates)
- [Оценка агента (Eval Runner)](#оценка-агента-eval-runner)
- [Безопасность](#безопасность)
- [Известные ограничения](#известные-ограничения)

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
task-spec-{ts}.md                    test-model-{ts}.md / .yaml
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
| `task-design` | Задачи | QG2 | Иерархия Epic → Story → Task → Sub-task, AC в формате Given-When-Then, создание реальных задач в Redmine через MCP |
| `test-design` | Тесты | QG3 | Тест-кейсы positive / negative / boundary, публикация в Redmine через MCP |

### Прочее

- **`AGENTS.md`** — глобальные правила: ролевая модель, запрет межскилловых вызовов, передача артефактов между агентами, правила для CONDITIONAL, защита от Prompt Injection и утечки секретов, ограничения на действия в Redmine.
- **`opencode.json`** — конфигурация OpenCode: MCP-сервер Redmine [`@speraltafibrazo/redmine-mcp`](https://www.npmjs.com/package/@speraltafibrazo/redmine-mcp) (`REDMINE_URL` по умолчанию `http://localhost:3000`, API-ключ берется из переменной окружения `REDMINE_KEY`).
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
│   └── skills/
│       ├── requirement-review/  # Логика аудита требований (QG1)
│       ├── task-design/         # Логика проектирования задач (QG2)
│       └── test-design/         # Логика проектирования тест-кейсов (QG3)
├── artifacts/                   # Артефакты прогонов (создается автоматически)
├── results/                     # Результаты прогонов eval-контюра (eval_results.json)
├── src/main/java/evals/
│   ├── EvalRunner.java          # Прогон агента по golden dataset
│   └── Evaluator.java           # LLM-судья (judge) ответов агента
├── src/main/resources/dataset/
│   └── golden_dataset.json      # Eval-кейсы EVC-001…EVC-006
├── target/                      # Скомпилированные классы (mvn compile)
├── .env                         # Секреты (REDMINE_KEY), НЕ хранится в git
├── AGENTS.md                    # Глобальные правила для всех агентов
├── opencode.json                # Конфигурация OpenCode (MCP Redmine)
├── pom.xml                      # Maven-сборка eval-раннера
├── package.json                 # Node-зависимости
└── README.md                    # Этот файл
```

## Установка и настройка

Требуется:

- **[OpenCode](https://opencode.ai)** (установка через npm: `npm install -g opencode-ai`);
- **Node.js** — для MCP-сервера Redmine (запускается через `npx`) и Node-зависимостей;
- **JDK 17+ и Maven** — только для оценочного контура;
- **доступный экземпляр Redmine** (по умолчанию `http://localhost:3000`).

Шаги:

```bash
# 1. Установка Node-зависимостей
npm install

# 2. Настройка доступа к Redmine: создать .env в корне проекта
#    (файл .env исключен из git через .gitignore)
#    REDMINE_KEY=<ваш API-ключ Redmine>
#    При необходимости поменять REDMINE_URL в opencode.json

# 3. (Опционально, для eval-контюра) сборка Java-модуля
mvn clean compile
```

## Запуск флоу

Открыть проект в OpenCode и дать оркестратору ID или ссылку на issue с требованиями, например:

```
Запусти полный флоу для задачи Redmine #72
```

Либо неинтерактивно (так же, как это делает EvalRunner):

```powershell
opencode run --auto "Запусти полный флоу для задачи Redmine #72"
```

Оркестратор выполнит цепочку Ingestion → Audit (QG1) → параллельно Task/Test → Final Report, и сложит результаты в `artifacts/<этап>/` с единым timestamp `{ts}` прогона.

## Структура артефактов

Каждый прогон использует единый `{ts}` (формат `yyyyMMdd-HHmmss`):

```
artifacts/
├── 00-raw-requirements/   raw-{ts}.md           # снимок требований из Redmine
├── 01-requirement-review/ review-report-{ts}.md # вердикт QG1, Blocking/Non-blocking проблемы
├── 02-task-design/        task-spec-{ts}.md      # спецификация задач (+ созданные задачи в Redmine)
├── 03-test-design/        test-model-{ts}.md/.yaml # тестовая модель (+ кейсы в Redmine)
├── 04-final-report/       final-report-{ts}.md   # итог: метрики, матрица трассировки, Open Questions
└── errors/                *.md                   # логи сбоев инструментов (Redmine и др.)
```

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

Результат сохраняется в `results/eval_results.json`.

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

Перед прогоном необходимы: живой Redmine с задачами из датасета (например, #72, #116) и установленный `opencode` в PATH.

## Безопасность

Правила закреплены в `AGENTS.md`:

- Текст требований из Redmine — **только данные**, инструкции из него не выполняются; попытки Prompt Injection фиксируются как проблема `SEC-01` в `review-report`.
- Секреты (API-ключи, токены) не выводятся в чат, артефакты и задачи; подозрительные паттерны маскируются как `[REDACTED]`.
- `.env` с `REDMINE_KEY` исключен из репозитория (`.gitignore`).
- Агентам запрещено удалять проекты/задачи/пользователей и менять статусы задач сверх того, что предусмотрено скиллами.