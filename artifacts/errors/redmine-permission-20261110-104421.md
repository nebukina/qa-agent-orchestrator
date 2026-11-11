# Log ошибок инструмента — прогон `20261110-104421`

## Шаг
`1. Ingestion` (+ опора на него при аудите `2. Audit / QG1`), Оркестратор `qa-orchestrator`.

## Операция
`redmine.list_metadata(kind="users")`, `redmine.list_metadata(kind="me")`, `redmine.list_metadata(kind="custom_fields")`
(выполнялись пакетом вместе с `get_issue(#64, summary:true)`, `statuses`, `priorities`, `categories(login)`, `versions(login)`).

## Результат
| Вызов | Результат |
|---|---|
| `get_issue(#64, summary:true)` | ✅ OK (`Notas: 0`) |
| `list_metadata(statuses)` | ✅ OK |
| `list_metadata(priorities)` | ✅ OK |
| `list_metadata(categories, project_id:"login")` | ✅ OK («проект login не имеет категорий») |
| `list_metadata(versions, project_id:"login")` | ✅ OK («проект login не имеет версий») |
| `list_metadata(users)` | ❌ `Error: Credenciales inválidas o sin permiso para esta acción.` (403) |
| `list_metadata(me)` | ❌ `Error: Credenciales inválidas o sin permiso para esta acción.` (403) |
| `list_metadata(custom_fields)` | ❌ `Error: Credenciales inválidas o sin permiso para esta acción.` (403) |

Инстанс: `http://localhost:3000`, ключ из `REDMINE_KEY` (`opencode.json → mcp.servers.redmine.environment`).
Чтение issues (`get_issue`, `list_issues`, `list_projects`, `list_metadata(trackers/statuses/priorities/categories/versions)`) работает штатно — 403 получен только на трёх каталогах. Повторных ретраев не требовалось: ошибка детерминированная (права API-ключа), а не сетевая.

## Непройденный критерий
Эскалационное правило Оркестратора №3 («Ошибка 401/403»). Последствия для конвейера зафиксированы в аудите как Non-blocking `GAP-24`.

## Что не удалось
- Разрешить ID пользователей (`assigned_to_id`, будущие assignee/аппруверы создаваемых задач и тест-кейсов).
- Получить определения custom fields (заполнение обязательных полей проекта при создании issues).
- Верифицировать состав исполнителей/согласующих у #64.

## Какие данные/решение нужны
1. Выдать API-ключу права на чтение `/users.json`, `/current_user.json`, `/custom_fields.json` — **или**
2. Предоставить выгрузку справочников (список пользователей с ID, определения custom fields проекта `login`) — **или**
3. Подтвердить режим «создание задач/кейсов без assignee и custom fields» как допустимый для этого проекта.

## Ссылки
- Снимок: `artifacts/00-raw-requirements/raw-20261110-104421.md`
- Аудит: `artifacts/01-requirement-review/review-report-20261110-104421.md` (`GAP-24`, `OQ-15`)