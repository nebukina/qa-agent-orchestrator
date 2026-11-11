# Log ошибок инструмента — прогон `20261110-123101`

## Шаг
`1. Ingestion` + `2. Audit / QG1`, Оркестратор `qa-orchestrator`, субагент `@review`.

## Операции и результат

| Вызов | Результат |
|---|---|
| `get_issue(#67)` | ✅ OK (описание, AC, метаданные) |
| `get_issue(#67, summary:true)` | ✅ OK (подтверждает «Notas: 0») |
| `list_issues(project_id:"login", status:"*", include_relations:true, limit:100)` | ✅ OK (ровно 2 issue: #67, #68; строк связей и пометки «no verificable» нет) |
| `list_metadata(trackers, project_id:"login")` | ✅ OK (TestCase #1, Task #2) |
| `list_metadata(statuses)` | ✅ OK (ToDo #1, InCoding #2, InTesting #3, Ready #4 closed, ReadyForTest #5) |
| `get_issue(#65, summary:true)` | ❌ `Error: Recurso no encontrado en Redmine.` (404) |
| `get_issue(#66, summary:true)` | ❌ `Error: Recurso no encontrado en Redmine.` (404) |
| `list_issue_relations(#67)` | ❌ `Error: Credenciales inválidas o sin permiso para esta acción.` (403) |
| `list_issue_relations(#68)` | ❌ 403 |
| `list_metadata(custom_fields)` | ❌ 403 |
| `list_metadata(me)` | ❌ 403 |
| `skill(requirement-review)` внутри субагента `@review` | ❌ `Permission denied: skill` — методика применена непосредственно из `.opencode/skills/requirement-review/SKILL.md` |

Инстанс: `http://localhost:3000`, ключ из `REDMINE_KEY` (`opencode.json → mcp.servers.redmine.environment`). Ошибки детерминированные (права API-ключа / состояние данных), ретраи не применялись. Записей в Redmine за прогон не производилось (все вызовы — чтение).

## Два класса проблем

### A. Права API-ключа (403) — воспроизводится с прогонов `20261110-104421`, `20261110-112229`, `20261110-121304`
Недоступны: `GET /issues/:id/relations.json` (и на #67, и на #68), `/custom_fields.json`, `/current_user.json`.

Последствия:
- Наличие/отсутствие связей у #67 (и смежного #68) подтвердить или опровергнуть нельзя → в аудите это **Blocking `UNC-01`**, открытый вопрос **`OQ-02`**.
- Определения custom fields проекта неизвестны → набор обязательных полей при создании issues/кейсов неизвестен.
- Справочник пользователей недоступен → assignee/аппруверы не разрешимы в ID → владельцы вопросов проставлены условно (`GAP-19`).

### B. Расхождение данных (404 на #65/#66) — воспроизводится с прогона `20261110-121304`
`get_issue(#65)` и `get_issue(#66)` → ресурс отсутствует; в листинге проекта `login` их нет (только #67 и #68).
При этом их дословные тексты сохранены локально: `raw-20261110-112229.md`, `raw-20261110-114120.md`.
То есть предшественники того же продукта удалены из инстанса; восстановимые связи и журналы недоступны.
Зафиксировано в аудите как `CON-03` + `GAP-21` (разрыв наследования и неопределённые границы нормативной базы).

## Непройденные критерии
- Эскалационное правило Оркестратора №3 («Ошибка 401/403») — не пройдено.
- **QG1 = FAIL** (есть Blocking `UNC-01`) → эскалационное правило №1; конвейер остановлен, этапы `task`/`test` не запускались.
- Целостность корпуса (состав нормативной базы, связи, наследование) — не подтверждён.

## Какие данные/решение нужны
1. Выдать API-ключу права на чтение `/issues/:id/relations.json`, `/custom_fields.json`, `/users.json`, `/current_user.json` — **или**
2. Предоставить письменное подтверждение администратора: связи #67 ⟷ #68, преемственность #67 ← (удалённые #65/#66), местонахождение архива удалённых документов — **или**
3. Явно зафиксировать режим «корпус без связей и без custom fields» как допустимый для проекта `login` (принятие риска) — это отступление от Constraints, требуется разрешение человека.
4. Ответить на `OQ-01` (арбитраж нормативной базы #67 ⟷ #68) и `OQ-05` (критерии валидности полей) — без них корпус не перейдёт в CONDITIONAL даже после снятия `OQ-02`.

## Ссылки
- Снимок: `artifacts/00-raw-requirements/raw-20261110-123101.md`
- Аудит: `artifacts/01-requirement-review/review-report-20261110-123101.md` (`UNC-01`, `CON-01…CON-03`, `GAP-17…GAP-23`, `OQ-02`)
- Предыдущий лог: `artifacts/errors/redmine-permission-20261110-112229.md`