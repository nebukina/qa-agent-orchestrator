# REDMINE WRITE FORBIDDEN — flow 20261110-202208 (issue #72)

**Дата/время:** 2026-11-10, ~21:55 (локальное)
**Этапы, затронутые отказом:** `02-task-design`, `03-test-design` (публикация в Redmine)
**Код отказа:** `REDMINE_WRITE_FORBIDDEN` (эквивалент 401/403)
**Сообщение API:** `Credenciales inválidas o sin permiso para esta acción.`

## Диагноз: API-ключ read-only

| Проверка | Результат |
|---|---|
| Чтение (`get_issue #72`, `list_projects`, `list_issues`, `list_metadata`) | ✅ OK |
| Запись `add_note(#72)` (проба оркестратора) | ❌ отказ |
| Запись `create_issue_category(login)` (проба оркестратора) | ❌ отказ |
| `create_issue` — 6+ вариантов payload/tracker/project (агент `@task`) | ❌ отказ (все) |
| `create_issue` — 6 вариантов + `add_note(#72)` (агент `@test`) | ❌ отказ (все) |

Отказ **точный, нетранзитный, не зависит от параметров**: чтения успешно работают до и после серий отказов записи. Состояние инстанса **не изменено** (контрольная выборка: в проекте `login` только #72, probe-issue не созданы).

## Повторность

Это **4-й повтор отказа за день** (см. `redmine-permission-20261110-104421.md`, `redmine-permission-20261110-112229.md`, `redmine-permission-20261110-123101.md`). Проблема инфраструктурная, не разовая.

## Что нужно для разблокировки

MCP-профилю / API-ключу необходимы в проекте `login` (id=1):
- `Issues / Create issues` (POST /issues)
- `Issues / Edit issues` (PUT /issues/:id) — желательно
- `Issues / Add notes` (заметки)

## Replay-план (после выдачи прав, без переработки дизайна)

1. Перезапустить `@task` с меткой `20261110-202208` → replay-pack, §12 файла `artifacts\02-task-design\task-spec-20261110-202208.md` (порядок T-1…T-15, `project_id=login`, `tracker_id=2`, `priority_id=1`).
2. Перезапустить `@test` с меткой `20261110-202208` → чек-лист публикации, раздел 9 файла `artifacts\03-test-design\test-model-20261110-202208.md` (трекер TestCase id=1).
3. Обновить final-report (`04-final-report\final-report-20261110-202208.md`), внеся фактические ID.

## Эскалация

- **Ответственный:** Redmine Admin (выдача прав) / QA Lead (приоритет).
- **SLA-риск:** дизайн готов, публикация — единственное узкое место; простой только административный.