# Log ошибок инструмента — прогон `20261110-112229`

## Шаг
`1. Ingestion` + `2. Audit / QG1`, Оркестратор `qa-orchestrator`, субагент `@review`.

## Операции и результат
| Вызов | Результат |
|---|---|
| `get_issue(#65)` | ✅ OK (описание, AC, мета́данные) |
| `list_projects(limit:20)` | ✅ OK (2 проекта: `login` #1, `landing` #2) |
| `list_metadata(trackers, project_id:"login")` | ✅ OK (TestCase #1, Task #2) |
| `list_issues(project_id:"login", status:"*")` | ✅ OK (ровно 2 issue: #65, #66) |
| `get_issue(#66, summary:true)` | ✅ OK |
| `get_issue(#64, summary:true)` | ❌ `Error: Recurso no encontrado en Redmine.` (404) |
| `search("Login ТЗ")` | ✅ OK по механике, `No se encontraron resultados` — 0 результатов |
| `list_issue_relations(#65)` | ❌ `Error: Credenciales inválidas o sin permiso para esta acción.` (403) |
| `list_issue_relations(#66)` | ❌ `Error: Credenciales inválidas o sin permiso para esta acción.` (403) |
| `list_metadata(users)` | ❌ 403 |
| `list_metadata(me)` | ❌ 403 |
| `list_metadata(custom_fields)` | ❌ 403 |

Инстанс: `http://localhost:3000`, ключ из `REDMINE_KEY` (`opencode.json → mcp.servers.redmine.environment`). Ошибки детерминированные (права API-ключа / состояние данных), ретраи не применялись.

## Два класса проблем

### A. Права API-ключа (403) — воспроизводится с прогона `20261110-104421`
Расширился список недоступных операций: к `/users.json`, `/current_user.json`, `/custom_fields.json` добавился
`GET /issues/:id/relations.json` (403 и на #65, и на #66).

Последствия:
- Невозможно подтвердить или опровергнуть **наличие связей** у #65 и #66 → зафиксировано в аудите как Blocking `UNC-02`.
- Невозможно разрешить ID пользователей → assignee/аппруверы не назначаемы; зафиксировано как `GAP-25` (владельцы проставлены условно).
- Невозможно получить определения custom fields → заполнение обязательных полей проекта при создании issues неизвестно.

### B. Расхождение данных (404 на #64) — новое
`get_issue(#64)` → ресурс отсутствует; полнотекстовый поиск «Login ТЗ» → 0; в листинге проекта `login` #64 нет.
При этом `artifacts/00-raw-requirements/raw-20261110-104421.md` и `raw-20261110-104512.md` содержат дословный текст #64,
а `get_issue(#64, summary:true)` в прогоне `20261110-104421` отвечал ✅ OK.
То есть между 10:45 и 11:22 2026-11-10 issue #64 из инстанса исчез (удалён либо стал недоступен данной API-ключи).
Зафиксировано в аудите как Blocking `UNC-01` (противоречивые входы, самодеятельный выбор между входами запрещён).

## Непройденные критерии
- Эскалационное правило Оркестратора №3 («Ошибка 401/403») — не пройдено.
- Целостность корпуса (состав нормативной базы) — не подтверждён.

## Какие данные/решение нужны
1. Выдать API-ключу права на чтение `/users.json`, `/current_user.json`, `/custom_fields.json`, `/issues/:id/relations.json` — **или**
2. Предоставить выгрузку справочников (пользователи с ID, custom fields проекта `login`) и перечень связей #65/#66 — **или**
3. Подтвердить режим «задачи/кейсы без assignee и custom fields» как допустимый для проекта `login`.
4. Ответить на `OQ-01`: судьба #64 (удалён? восстановлен? перенесён?) и входит ли #66 в нормативный корпус продукта.

## Ссылки
- Снимок: `artifacts/00-raw-requirements/raw-20261110-112229.md`
- Аудит: `artifacts/01-requirement-review/review-report-20261110-112229.md` (`UNC-01`, `UNC-02`, `GAP-22`, `GAP-25`, `OQ-01`)
- Предыдущий лог: `artifacts/errors/redmine-permission-20261110-104421.md`