// Нативные инструменты Redmine вместо MCP-канала.
//
// Почему: MCP требовал дочерний процесс node и зависел от того, раскроет ли OpenCode
// {env:REDMINE_KEY} в environment сервера. Плагин исполняется внутри сервера OpenCode,
// берёт ключ из .env через общий клиент scripts/lib/redmine.mjs и регистрирует инструменты
// в пространстве имён `redmine` — правила `action: "redmine_*"` в агентах продолжают работать.
//
// Реализованы только чтение и создание новых сущностей. update_issue, change_issue_status,
// delete_*, edit_journal, remove_* здесь отсутствуют намеренно: право менять и удалять
// существующие задачи агентам не выдавалось (AGENTS.md), и теперь его нет ни в одном слое.
// `@opencode/plugin` нужен только ради Plugin.define (это тождественная функция).
// .opencode/package.json лежит в .gitignore, поэтому на свежем клоне пакета может не быть:
// подключаем его динамически и при отсутствии используем тождественный fallback.
let define = (plugin) => plugin;
try {
  const mod = await import("@opencode/plugin");
  define = mod.Plugin.define;
} catch {
  console.error("redmine-plugin: @opencode/plugin не найден, используется fallback-определитель");
}

import * as rm from "../../../scripts/lib/redmine.mjs";

const READ = { namespace: "redmine", permission: "redmine_read" };
const WRITE = { namespace: "redmine", permission: "redmine_write" };

const str = (v) => (typeof v === "string" ? v : JSON.stringify(v));

/** Приводит ошибку клиента к виду, который видит модель: CODE: текст (ключ замаскирован). */
function asToolError(err, auth) {
  const message = auth ? rm.redact(err?.message ?? String(err), auth.key) : (err?.message ?? String(err));
  return new Error(`${err?.code ?? "REDMINE_ERROR"}: ${message}`);
}

const obj = (props, required = []) => ({ type: "object", properties: props, required, additionalProperties: false });

export default define({
  id: "redmine",
  async setup(ctx) {
    let authPromise = null;
    const auth = () => (authPromise ??= rm.resolveAuth());
    // После 401/403 кэш ключа сбрасывается: правка .env применяется без перезагрузки плагина.
    const invalidate = () => {
      authPromise = null;
    };

    const call = async (fn) => {
      const creds = await auth().catch((err) => {
        throw asToolError(err);
      });
      try {
        return { creds, value: await fn(creds) };
      } catch (err) {
        if (err?.code === "REDMINE_UNAUTHORIZED" || err?.code === "REDMINE_FORBIDDEN") invalidate();
        throw asToolError(err, creds);
      }
    };

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "redmine",
        description:
          "Redmine через REST API напрямую (без MCP). Доступно чтение issues/каталогов и создание новых задач и заметок. " +
          "Изменение, удаление и смена статуса существующих задач физически не реализованы.",
      });

      editor.add({
        name: "get_issue",
        description: "Детали задачи Redmine по ID. format=detail — человекочитаемая сводка, format=json — полный ответ API.",
        input: obj({
          id: { type: "integer", description: "ID задачи" },
          format: { type: "string", enum: ["detail", "json"], description: "Формат вывода, по умолчанию detail" },
          include: { type: "string", description: "Дополнительные секции API, например journals,children,attachments" },
        }, ["id"]),
        options: READ,
        execute: async ({ id, format = "detail", include }, c) => {
          const { value } = await call((creds) => rm.getIssue(id, { include, auth: creds, signal: c.signal }));
          return { content: format === "json" ? str(value) : rm.formatIssueDetail(value.issue) };
        },
      });

      editor.add({
        name: "list_issues",
        description: "Список задач проекта (или всех доступных) для проверки дублей. Одна строка на задачу: #id — Трекер/Статус: Тема.",
        input: obj({
          project_id: { type: ["integer", "string"], description: "ID или identifier проекта" },
          tracker_id: { type: ["integer", "string"] },
          status_id: { type: ["integer", "string"], description: "Например open, all или ID статуса" },
          limit: { type: "integer", description: "Строк за запрос, по умолчанию 50" },
          all: { type: "boolean", description: "Обойти все страницы (дорого по контексту, используйте точечно)" },
        }),
        options: READ,
        execute: async ({ project_id, tracker_id, status_id, limit = 50, all = false }, c) => {
          const filters = { projectId: project_id, trackerId: tracker_id, statusId: status_id };
          const { value } = await call((creds) =>
            all ? rm.allIssues(filters, { auth: creds, signal: c.signal }) : rm.listIssues({ ...filters, limit }, { auth: creds, signal: c.signal }),
          );
          const issues = all ? value.issues : value.issues ?? [];
          const head = issues.map(rm.formatIssueLine).join("\n");
          return { content: `${head}\n\nИтого строк: ${issues.length}${all ? "" : ` (total в Redmine: ${value.total_count ?? issues.length})`}` };
        },
      });

      editor.add({
        name: "search_issues",
        description: "Полнотекстовый поиск по задачам (для поиска дублей без известного ID).",
        input: obj({
          query: { type: "string", description: "Текст запроса" },
          project_id: { type: ["integer", "string"], description: "Ограничить проект" },
          limit: { type: "integer", description: "Строк за запрос, по умолчанию 50" },
        }, ["query"]),
        options: READ,
        execute: async ({ query, project_id, limit = 50 }, c) => {
          const { value } = await call((creds) => rm.searchIssues(query, { projectId: project_id, limit, auth: creds, signal: c.signal }));
          const hits = (value.results ?? [])
            .filter((r) => r.type === "Issue")
            .map((r) => `#${r.id} — ${r.title} [${r.project?.name ?? "?"}]`)
            .join("\n");
          return { content: `${hits || "Совпадений нет."}\n\nВсего по поиску: ${value.total ?? 0}` };
        },
      });

      editor.add({
        name: "list_metadata",
        description: "Каталоги Redmine для резолва ID: statuses, trackers, priorities, projects, versions, categories, me, users.",
        input: obj({
          kind: { type: "string", enum: rm.METADATA_KINDS },
          project_id: { type: ["integer", "string"], description: "Обязателен для versions и categories" },
        }, ["kind"]),
        options: READ,
        execute: async ({ kind, project_id }, c) => {
          const { value } = await call((creds) => rm.metadataSafe(kind, { projectId: project_id, auth: creds, signal: c.signal }));
          if (kind === "me") {
            if (!value.user) return { content: `Каталог "${kind}" недоступен на этом экземпляре (HTTP 404).` };
            return { content: `#${value.user.id} — ${value.user.login} (${value.user.firstname} ${value.user.lastname})` };
          }
          const items =
            value.trackers ?? value.statuses ?? value.priorities ?? value.projects ?? value.versions ?? value.issue_categories ?? value.users;
          if (!items) return { content: `Каталог "${kind}" недоступен на этом экземпляре (HTTP 404).` };
          return { content: `${items.map((i) => `${i.id} — ${i.name}`).join("\n")}\n\nЗаписей: ${items.length}` };
        },
      });

      editor.add({
        name: "list_projects",
        description: "Проекты, доступные текущему ключу: id/identifier и название.",
        input: obj({ limit: { type: "integer", description: "По умолчанию 100" } }),
        options: READ,
        execute: async ({ limit = 100 }, c) => {
          const { value } = await call((creds) => rm.listProjects({ limit, auth: creds, signal: c.signal }));
          const rows = (value.projects ?? []).map((p) => `${p.id} — ${p.name} (${p.identifier})`).join("\n");
          return { content: `${rows}\n\nЗаписей: ${(value.projects ?? []).length}` };
        },
      });

      editor.add({
        name: "create_issue",
        description:
          "Создаёт НОВУЮ задачу в проекте (POST /issues.json). Принимает tracker/priority/category/version именем или ID. " +
          "Поля status_id и done_ratio отклоняются: перевод по workflow не входит в полномочия агентов. " +
          "requirement_id попадает в описание, если его там нет.",
        input: obj({
          project_id: { type: ["integer", "string"], description: "ID или identifier проекта" },
          subject: { type: "string", description: "Тема, с глагола" },
          description: { type: "string", description: "Описание в Markdown" },
          tracker: { type: ["integer", "string"], description: "Трекер: имя или ID" },
          priority: { type: ["integer", "string"], description: "Приоритет: имя или ID" },
          category: { type: ["integer", "string"], description: "Категория проекта: имя или ID" },
          version: { type: ["integer", "string"], description: "Версия/спринт: имя или ID" },
          parent_id: { type: "integer", description: "ID родительской задачи (для иерархии)" },
          requirement_id: { type: "string", description: "ID требования из review-report" },
        }, ["project_id", "subject"]),
        options: WRITE,
        execute: async (input, c) => {
          const { creds, value } = await call(async (creds) => {
            const [trackers, priorities, categories, versions] = await Promise.all([
              rm.metadata("trackers", { auth: creds, signal: c.signal }).then((d) => d.trackers ?? []),
              rm.metadataSafe("priorities", { auth: creds, signal: c.signal }).then((d) => d.priorities ?? []),
              input.category ? rm.metadataSafe("categories", { projectId: input.project_id, auth: creds, signal: c.signal }).then((d) => d.issue_categories ?? []) : [],
              input.version ? rm.metadataSafe("versions", { projectId: input.project_id, auth: creds, signal: c.signal }).then((d) => d.versions ?? []) : [],
            ]);

            const trackerId = rm.findById(trackers, input.tracker);
            if (trackerId === undefined) {
              throw new rm.RedmineError(
                `Трекер "${input.tracker}" не найден. Возьмите ID из list_metadata kind=trackers.`,
                { code: "TRACKER_UNRESOLVED" },
              );
            }

            let description = rm.redact(input.description ?? "", creds.key);
            if (input.requirement_id && !/requirement_id/i.test(description)) {
              description = `${description.trimEnd()}\n\nrequirement_id: ${input.requirement_id}`;
            }

            const created = await rm.createIssue(
              {
                project_id: input.project_id,
                tracker_id: trackerId,
                subject: rm.redact(input.subject, creds.key),
                description,
                ...(rm.findById(priorities, input.priority) !== undefined ? { priority_id: rm.findById(priorities, input.priority) } : {}),
                ...(rm.findById(categories, input.category) !== undefined ? { category_id: rm.findById(categories, input.category) } : {}),
                ...(rm.findById(versions, input.version) !== undefined ? { fixed_version_id: rm.findById(versions, input.version) } : {}),
                ...(input.parent_id ? { parent_id: input.parent_id } : {}),
              },
              { auth: creds, signal: c.signal },
            );

            // Redmine молча отбрасывает parent_id, если трекёр ребёнка не настроен как subtask.
            const parentLinked = input.parent_id
              ? await rm.verifyParentLinkage(created.issue.id, input.parent_id, { auth: creds, signal: c.signal })
              : null;
            return { issue: created.issue, parentLinked };
          });
          const issue = value.issue;
          const dropped =
            value.parentLinked === false
              ? "\nВНИМАНИЕ: Redmine отбросил parent_id — у трекёра ребёнка не настроен subtask для трекёра родителя. Задача создана без родителя."
              : "";
          return {
            content: `Создана задача #${issue.id} — ${issue.subject} [${issue.tracker?.name}/${issue.status?.name}] в проекте ${issue.project?.id}.${dropped}`,
          };
        },
      });

      editor.add({
        name: "add_note",
        description:
          "Добавляет заметку к существующей задаче. Единственная операция записи в существующую сущность: " +
          "изменение полей и статуса недоступно.",
        input: obj({
          issue_id: { type: "integer", description: "ID задачи" },
          notes: { type: "string", description: "Текст заметки в Markdown" },
        }, ["issue_id", "notes"]),
        options: WRITE,
        execute: async ({ issue_id, notes }, c) => {
          const { creds, value } = await call((creds) =>
            rm.addNote(issue_id, rm.redact(notes, creds.key), { auth: creds, include: "journals", signal: c.signal }),
          );
          const journals = value.issue.journals ?? [];
          return { content: `Заметка добавлена к #${issue_id}. Журналов: ${journals.length}, последний id: ${journals.at(-1)?.id ?? "?"}.` };
        },
      });
    });

    return () => {
      authPromise = null;
    };
  },
});