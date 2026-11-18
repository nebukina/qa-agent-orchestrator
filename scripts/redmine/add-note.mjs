// Добавляет заметку к существующей задаче (замена add_note из MCP).
// Использование:
//   node scripts/redmine/add-note.mjs --issue 120 --notes-file artifacts/01-requirement-review/report-summary.md
//   node scripts/redmine/add-note.mjs --issue 120 --notes "requirement_id: R-01, статус: GAP"
//
// Это единственная операция записи в существующую задачу, которую умеет канал: Redmine
// добавляет журналы только через PUT /issues/:id.json, и клиент пропускает тело ровно
// одного вида {"issue":{"notes":"..."}}. Другие поля PUT отклоняет.
import { resolve } from "node:path";
import { addNote, getIssue, resolveAuth, redact, PROJECT_ROOT } from "../lib/redmine.mjs";
import { parseArgs, readTextArg, maskSecrets, fail } from "../lib/cli.mjs";

const args = parseArgs(process.argv.slice(2));
const issueId = Number(args.issue);
if (!Number.isInteger(issueId) || issueId <= 0) fail(new Error("--issue обязателен и должен быть числом."));

const text = readTextArg(args.notes, args["notes-file"] ? resolve(PROJECT_ROOT, String(args["notes-file"])) : undefined);
if (!text) fail(new Error("Задайте текст через --notes или --notes-file."));

try {
  const auth = await resolveAuth();
  const notes = maskSecrets(redact(text, auth.key), auth.key);
  const { issue: before } = await getIssue(issueId, { auth });
  const { issue } = await addNote(issueId, notes, { auth, include: "journals" });
  const journals = issue.journals ?? [];
  const last = journals.at(-1);
  console.log(`Заметка добавлена к #${issueId} (${before.subject}).`);
  console.log(`Журналов теперь: ${journals.length}, последний id: ${last?.id ?? "?"} (user ${last?.user?.id ?? "?"})`);
} catch (err) {
  fail(err);
}