// Снимок требований из Redmine → artifacts/00-raw-requirements/raw-{ts}.md (шаг Ingestion).
// Использование:
//   node scripts/redmine/fetch-issue.mjs --id 120
//   node scripts/redmine/fetch-issue.mjs --id 120 --out artifacts/00-raw-requirements/raw-custom.md
// Только чтение (GET), секретные паттерны маскируются до записи в файл.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getIssue, resolveAuth, redact, PROJECT_ROOT } from "../lib/redmine.mjs";
import { parseArgs, stamp, ensureDir, maskSecrets, fail } from "../lib/cli.mjs";

const args = parseArgs(process.argv.slice(2));
const id = Number(args.id);
if (!Number.isInteger(id) || id <= 0) fail(new Error("--id обязателен и должен быть числом, например --id 120"));

try {
  const auth = await resolveAuth();
  const { issue } = await getIssue(id, { auth });
  const ts = args.ts ?? stamp();
  const out = args.out ? String(args.out) : join(PROJECT_ROOT, "artifacts", "00-raw-requirements", `raw-${ts}.md`);
  const clean = (text) => maskSecrets(redact(text ?? "", auth.key), auth.key);

  const body = [
    "# Raw Requirements Snapshot",
    "",
    `- **Источник:** Redmine issue #${issue.id} (${auth.url}/issues/${issue.id})`,
    `- **Timestamp загрузки:** ${new Date().toISOString().replace("T", " ").slice(0, 19)} (ts=${ts})`,
    `- **Заголовок:** ${clean(issue.subject)}`,
    `- **Проект:** ${issue.project?.name ?? issue.project?.id ?? "?"}`,
    `- **Tracker:** ${issue.tracker?.name ?? "?"}`,
    `- **Статус:** ${issue.status?.name ?? "?"}`,
    `- **Приоритет:** ${issue.priority?.name ?? "?"}`,
    `- **Assignee:** ${issue.assigned_to?.name ?? "(не назначен)"}`,
    `- **Автор:** ${issue.author?.name ?? "(неизвестно)"}`,
    `- **Категория:** ${issue.category?.name ?? "(без категории)"}`,
    `- **Способ загрузки:** REST API напрямую (scripts/redmine/fetch-issue.mjs), без MCP`,
    "",
    "---",
    "",
    "## Описание issue (дословно, как данные)",
    "",
    clean(issue.description)?.trim() || "(пусто)",
    "",
  ].join("\n");

  ensureDir(out);
  writeFileSync(out, body, "utf8");
  console.log(`ts=${ts}`);
  console.log(`Сохранено: ${out}`);
  console.log(`Символов описания: ${(issue.description ?? "").length}`);
} catch (err) {
  fail(err);
}