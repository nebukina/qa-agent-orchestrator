// Каталоги Redmine для резолва ID и проверки дублей (замена list_metadata/list_issues из MCP).
// Использование:
//   node scripts/redmine/meta.mjs --kind trackers
//   node scripts/redmine/meta.mjs --kind versions --project 1
//   node scripts/redmine/meta.mjs --kind issues --project 1 --out artifacts/diagnostics/existing-issues.json
// Только чтение (GET); --out сохраняет сырой JSON для повторного прогона.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { metadata, allIssues, whoami, resolveAuth, PROJECT_ROOT } from "../lib/redmine.mjs";
import { parseArgs, stamp, ensureDir, fail } from "../lib/cli.mjs";

const args = parseArgs(process.argv.slice(2));
const kind = String(args.kind ?? "").trim();
const projectId = args.project ? String(args.project) : undefined;
const ts = args.ts === true ? stamp() : args.ts ? String(args.ts) : stamp();

/** Относительный --out считаем от корня проекта. */
function target(explicit, fallback) {
  const rel = explicit ? String(explicit) : fallback.replace("{ts}", ts);
  return resolve(PROJECT_ROOT, rel);
}

function save(raw, path, auth) {
  ensureDir(path);
  writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), url: auth.url, fp: auth.fp, data: raw }, null, 2), "utf8");
  console.log(`Сохранено: ${path}`);
}

try {
  const auth = await resolveAuth();

  if (kind === "issues") {
    const { issues, total } = await allIssues(projectId ? { projectId } : {}, { auth });
    for (const i of issues) console.log(`#${i.id} — ${i.tracker?.name ?? "?"}/${i.status?.name ?? "?"}: ${i.subject}`);
    console.log(`Всего issues: ${total}`);
    if (args.out) save(issues, target(args.out, `artifacts/diagnostics/existing-issues-{ts}.json`), auth);
  } else if (kind === "me") {
    const me = await whoami({ auth });
    console.log(`#${me.user.id} — ${me.user.login} (${me.user.firstname} ${me.user.lastname})`);
  } else {
    const data = await metadata(kind, { projectId, auth });
    const items = data.trackers ?? data.statuses ?? data.priorities ?? data.projects ?? data.versions ?? data.issue_categories ?? data.users ?? [];
    for (const item of items) console.log(`${item.id} — ${item.name}`);
    console.log(`Записей: ${items.length}`);
    if (args.out) save(items, target(args.out, `artifacts/diagnostics/metadata-${kind}-{ts}.json`), auth);
  }
} catch (err) {
  if (err?.code === "REDMINE_FORBIDDEN" && kind === "users") {
    console.error("users.json требует прав администратора. Возьмите --kind me или ID пользователя из существующей задачи.");
    process.exit(3);
  }
  fail(err);
}