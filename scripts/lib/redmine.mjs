// Единый HTTP-клиент Redmine для плагина OpenCode и CLI-скриптов.
//
// Зачем: канал через MCP требовал дочерний процесс и зависел от того, раскроет ли
// OpenCode {env:REDMINE_KEY} в environment локального сервера (см. .opencode/redmine-mcp-launch.mjs).
// Здесь тот же порядок резолва ключа, но один на всех потребителей, и права на запись
// зашиты в код: реализованы только GET и POST, а PUT допускается исключительно для
// добавления заметки (Redmine умеет её добавлять только через PUT /issues/:id.json).
// PUT/PATCH/DELETE для изменения или удаления задачи здесь не существует физически.
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, "..", "..");
export const ENV_FILE = join(PROJECT_ROOT, ".env");

export const REDACTED = "[REDACTED]";
export const DEFAULT_URL = "http://localhost:3000";
const ALLOWED_METHODS = new Set(["GET", "POST"]);

/** Ошибка канала Redmine с машиночитаемым code — его пишут в артефакты и логи. */
export class RedmineError extends Error {
  constructor(message, { code = "REDMINE_ERROR", status, details } = {}) {
    super(message);
    this.name = "RedmineError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fromDotEnv(name) {
  if (!existsSync(ENV_FILE)) return null;
  const line = readFileSync(ENV_FILE, "utf8")
    .split(/\r?\n/)
    .find((l) => l.trimStart().startsWith(`${name}=`));
  if (!line) return null;
  return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") || null;
}

// Ключ API Redmine — 40 hex-символов; граница 20 отсекает обрезанные и нераскрытые {env:...}.
const plausible = (v) => typeof v === "string" && v.length >= 20 && !v.includes("{env:");

export function fingerprint(key) {
  return createHash("sha256").update(String(key)).digest("hex").slice(0, 12);
}

/** Маскирует ключ в любом тексте: ключ не должен попасть в чат, артефакт или заметку. */
export function redact(text, key) {
  if (typeof text !== "string" || !key) return text;
  return text.split(key).join(REDACTED);
}

export function baseUrl() {
  return [fromDotEnv("REDMINE_URL"), process.env.REDMINE_URL].find((v) => plausible(v) && v.startsWith("http")) ?? DEFAULT_URL;
}

function combineSignals(signal, timeoutMs) {
  const timer = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timer]) : timer;
}

async function authenticates(url, key, signal) {
  try {
    const res = await fetch(`${url}/users/current.json`, {
      headers: { "X-Redmine-API-Key": key, Accept: "application/json" },
      signal,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Резолвит ключ в порядке: .env → REDMINE_KEY → REDMINE_API_KEY, побеждает первый
 * аутентифицировавшийся живым GET /users/current.json. Значение ключа наружу не отдаётся
 * вместе с логом: наружу идёт только отпечаток sha256.
 */
export async function resolveAuth({ signal } = {}) {
  const url = baseUrl();
  const candidates = [
    [".env", fromDotEnv("REDMINE_KEY")],
    ["REDMINE_KEY", process.env.REDMINE_KEY],
    ["REDMINE_API_KEY", process.env.REDMINE_API_KEY],
  ].filter(([, v]) => plausible(v));

  if (candidates.length === 0) {
    throw new RedmineError(`Ключ Redmine не найден. Создайте ${ENV_FILE} со строкой REDMINE_KEY=<ключ>.`, {
      code: "REDMINE_KEY_MISSING",
    });
  }

  for (const [source, key] of candidates) {
    if (await authenticates(url, key, signal ?? AbortSignal.timeout(8000))) {
      return { url, key, source, fp: fingerprint(key) };
    }
  }
  throw new RedmineError(`Ни один ключ не аутентифицировался на ${url}. Проверьте .env и права ключа.`, {
    code: "REDMINE_AUTH_FAILED",
    details: { sources: candidates.map(([s]) => s) },
  });
}

// Единственный PUT, который мы разрешаем: заметка к задаче. Тело должно содержать ровно одно поле notes.
function isNotesOnlyBody(body) {
  return Boolean(body?.issue) && Object.keys(body.issue).length === 1 && "notes" in body.issue;
}

function describeError(status, payload) {
  const errors = payload?.errors;
  if (Array.isArray(errors) && errors.length) return errors.join("; ");
  if (typeof payload === "string" && payload.trim()) return payload.slice(0, 300);
  return "";
}

/**
 * Один вход для всех обращений к Redmine. Методы вне GET/POST отклоняются до запроса,
 * PUT — только как заметка-только-поле (см. isNotesOnlyBody).
 */
export async function api(path, { method = "GET", params, body, auth, signal, timeoutMs = 30000, appendNote = false } = {}) {
  const upper = String(method).toUpperCase();
  if (upper === "PUT") {
    if (!appendNote || !isNotesOnlyBody(body)) {
      throw new RedmineError(
        "PUT разрешён только для добавления заметки (тело вида {\"issue\":{\"notes\":\"...\"}}). Изменение полей задачи недоступно намеренно.",
        { code: "METHOD_BLOCKED" },
      );
    }
  } else if (!ALLOWED_METHODS.has(upper)) {
    throw new RedmineError(`Метод ${upper} запрещён: канал Redmine допускает только GET и POST.`, { code: "METHOD_BLOCKED" });
  }

  const creds = auth ?? (await resolveAuth({ signal }));
  const url = new URL(path.replace(/^\//, ""), creds.url.endsWith("/") ? creds.url.slice(0, -1) : creds.url);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method: upper,
    headers: {
      "X-Redmine-API-Key": creds.key,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: combineSignals(signal, timeoutMs),
  });

  const raw = await res.text();
  if (!raw) return {}; // Redmine отвечает 204 без тела на PUT с заметкой.
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = raw;
  }

  if (!res.ok) {
    const code = res.status === 401 ? "REDMINE_UNAUTHORIZED" : res.status === 403 ? "REDMINE_FORBIDDEN" : res.status === 404 ? "REDMINE_NOT_FOUND" : "REDMINE_HTTP_ERROR";
    throw new RedmineError(redact(describeError(res.status, payload) || `HTTP ${res.status}`, creds.key), {
      code,
      status: res.status,
      details: { url: url.pathname },
    });
  }
  return payload;
}

export function whoami(o = {}) {
  return api("/users/current.json", o);
}

export function getIssue(id, { include, ...o } = {}) {
  return api(`/issues/${id}.json`, { ...o, params: include ? { include } : undefined });
}

export function listIssues({ projectId, statusId, trackerId, categoryId, fixedVersionId, text, limit = 50, offset = 0, ...o } = {}) {
  return api(projectId ? `/projects/${projectId}/issues.json` : "/issues.json", {
    ...o,
    params: { status_id: statusId, tracker_id: trackerId, category_id: categoryId, fixed_version_id: fixedVersionId, limit, offset },
  });
}

/** Обходит страницы целиком; limit=0 в Redmine означает «все», но мы идём окнами по 100. */
export async function allIssues(filters = {}, o = {}) {
  const issues = [];
  for (let offset = 0; ; offset += 100) {
    const page = await listIssues({ ...filters, limit: 100, offset }, o);
    issues.push(...(page.issues ?? []));
    if ((page.total_count ?? issues.length) <= offset + 100 || (page.issues ?? []).length === 0) break;
  }
  return { issues, total: issues.length };
}

export function searchIssues(query, { projectId, scope = "all", limit = 50, ...o } = {}) {
  if (!String(query ?? "").trim()) throw new RedmineError("query обязателен.", { code: "QUERY_REQUIRED" });
  return api("/search.json", { ...o, params: { query, issues: 1, scope, project: projectId, limit } });
}

export function listProjects({ limit = 100, ...o } = {}) {
  return api("/projects.json", { ...o, params: { limit } });
}

const METADATA_ENDPOINTS = {
  me: () => "/users/current.json",
  users: () => "/users.json",
  statuses: () => "/statuses.json",
  trackers: () => "/trackers.json",
  priorities: () => "/enumerations/priorities.json",
  projects: () => "/projects.json",
  versions: (projectId) => `/projects/${projectId}/versions.json`,
  categories: (projectId) => `/projects/${projectId}/issue_categories.json`,
};

export const METADATA_KINDS = Object.keys(METADATA_ENDPOINTS);

/** Как metadata, но 404 считается «каталога нет»: на части инстансов enumerations отключены. */
export async function metadataSafe(kind, opts = {}) {
  try {
    return await metadata(kind, opts);
  } catch (err) {
    if (err?.code === "REDMINE_NOT_FOUND") return {};
    throw err;
  }
}

export function metadata(kind, { projectId, ...o } = {}) {
  const endpoint = METADATA_ENDPOINTS[kind];
  if (!endpoint) {
    throw new RedmineError(`Неизвестный kind "${kind}". Доступны: ${METADATA_KINDS.join(", ")}.`, { code: "METADATA_KIND_UNKNOWN" });
  }
  if ((kind === "versions" || kind === "categories") && !projectId) {
    throw new RedmineError(`kind "${kind}" требует projectId.`, { code: "PROJECT_ID_REQUIRED" });
  }
  return api(endpoint(projectId), o);
}

/** Поля, переводящие задачу по workflow: новая задача должна получать статус по умолчанию. */
const FORBIDDEN_CREATE_FIELDS = ["status_id", "done_ratio"];

/**
 * Создаёт новую задачу. Отказывается писать status_id: перевод задач по workflow
 * запрещён правилами AGENTS.md, новая задача получает статус по умолчанию.
 */
export async function createIssue(payload, o = {}) {
  const offending = FORBIDDEN_CREATE_FIELDS.filter((f) => payload[f] !== undefined);
  if (offending.length) {
    throw new RedmineError(`Поля ${offending.join(", ")} в новой задаче запрещены: смена статуса/назначения не входит в полномочия агентов.`, {
      code: "FORBIDDEN_FIELD",
    });
  }
  if (!payload.project_id) throw new RedmineError("project_id обязателен.", { code: "PROJECT_ID_REQUIRED" });
  if (!String(payload.subject ?? "").trim()) throw new RedmineError("subject обязателен.", { code: "SUBJECT_REQUIRED" });
  return api("/issues.json", { ...o, method: "POST", body: { issue: payload } });
}

/**
 * Заметка к задаче. Единственный легальный PUT в канале: тело содержит только notes.
 * Redmine отвечает на PUT пустым телом, поэтому факт заметки проверяется чтением journals.
 */
export async function addNote(issueId, notes, { include = "journals", ...o } = {}) {
  if (!String(notes ?? "").trim()) throw new RedmineError("Заметка не может быть пустой.", { code: "NOTE_EMPTY" });
  await api(`/issues/${issueId}.json`, {
    ...o,
    method: "PUT",
    appendNote: true,
    body: { issue: { notes } },
  });
  return api(`/issues/${issueId}.json`, { ...o, params: { include } });
}

/**
 * Redmine молча отбрасывает parent_id, если трекёр ребёнка не настроен как subtask
 * трекёра родителя. Возвращает false, когда связь не появилась — чтобы честный отчёт
 * о публикации отличал «создано» от «создано, но без родителя».
 */
export async function verifyParentLinkage(issueId, parentId, o = {}) {
  const { issue } = await getIssue(issueId, o);
  return issue.parent?.id === Number(parentId);
}

export function addWatcher(issueId, userId, o = {}) {
  return api(`/issues/${issueId}/watchers.json`, { ...o, method: "POST", body: { user_id: userId } });
}

/** Разворачивает имя каталога в ID; undefined, если совпадения нет. Регистронезависимо. */
export function findById(list, nameOrId) {
  if (nameOrId === undefined || nameOrId === null) return undefined;
  if (Number.isInteger(Number(nameOrId)) && typeof nameOrId !== "string") return Number(nameOrId);
  const needle = String(nameOrId).trim().toLowerCase();
  const hit = (list ?? []).find((item) => String(item.name).trim().toLowerCase() === needle);
  return hit?.id;
}

export function formatIssueLine(issue) {
  return `#${issue.id} — ${issue.tracker?.name ?? "?"}/${issue.status?.name ?? "?"}: ${issue.subject}`;
}

export function formatIssueDetail(issue) {
  const rows = [
    `#${issue.id} — ${issue.subject}`,
    `Проект: ${issue.project?.id} ${issue.project?.name ?? ""}`.trim(),
    `Трекер: ${issue.tracker?.id} ${issue.tracker?.name ?? ""}`.trim(),
    `Статус: ${issue.status?.id} ${issue.status?.name ?? ""}`.trim(),
    `Приоритет: ${issue.priority?.id} ${issue.priority?.name ?? ""}`.trim(),
    issue.assigned_to ? `Назначен: ${issue.assigned_to.id} ${issue.assigned_to.name}` : "Назначен: —",
    issue.parent ? `Родитель: #${issue.parent.id}` : "Родитель: —",
    issue.fixed_version ? `Версия: ${issue.fixed_version.id} ${issue.fixed_version.name}` : "Версия: —",
    issue.created_on ? `Создана: ${issue.created_on}` : "",
    issue.updated_on ? `Обновлена: ${issue.updated_on}` : "",
    "",
    "--- Описание ---",
    issue.description?.trim() || "(пусто)",
  ];
  return rows.filter(Boolean).join("\n");
}