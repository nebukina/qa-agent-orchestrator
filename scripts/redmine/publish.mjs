// Батч-публикация задач и тест-кейсов в Redmine по манифесту (замена череды create_issue из MCP).
//
// Использование:
//   node scripts/redmine/publish.mjs --manifest artifacts/02-task-design/task-manifest-20261118-120000.json --dry-run
//   node scripts/redmine/publish.mjs --manifest artifacts/03-test-design/test-manifest-20261118-120000.json
//
// Манифест (JSON):
// {
//   "project_id": 1,                       // обязательное
//   "ts": "20261118-120000",               // опциональное, для имени файла результатов
//   "defaults": { "tracker": "Task", "priority": "Normal" },
//   "issues": [
//     {
//       "key": "EPIC-01",                  // локальный уникальный ключ, обязателен
//       "subject": "Свести требования",    // обязательно
//       "description": "requirement_id: R-01\n...",
//       "tracker": "Epic",                 // имя или ID; иначе defaults
//       "priority": "High",
//       "category": "Auth",                // имя или ID категории проекта
//       "version": "1.0",                  // имя или ID версии проекта
//       "parent_key": null,                // key родителя: родитель создаётся раньше
//       "watchers": ["alice"],             // имена или ID наблюдателей
//       "requirement_id": "R-01"           // попадает в описание, если его там нет
//     }
//   ]
// }
//
// Правила: создаются только новые задачи (POST /issues.json). Поля status_id и done_ratio
// отклоняются, PUT/DELETE в клиенте нет. 401/403 останавливают батч немедленно.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createIssue, addWatcher, metadata, metadataSafe, resolveAuth, findById, redact, verifyParentLinkage, PROJECT_ROOT, RedmineError } from "../lib/redmine.mjs";
import { parseArgs, stamp, ensureDir, maskSecrets, readJson, fail } from "../lib/cli.mjs";

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args["dry-run"]);
const allowMissingReq = Boolean(args["allow-missing-requirement-id"]);

if (!args.manifest || args.manifest === true) fail(new Error("Укажите --manifest <путь к JSON>."));

const manifestPath = resolve(PROJECT_ROOT, String(args.manifest));
const manifest = readJson(manifestPath);
const ts = manifest.ts ?? (args.ts === true ? stamp() : args.ts ? String(args.ts) : stamp());
const resultsPath = resolve(PROJECT_ROOT, args.out ? String(args.out) : `artifacts/diagnostics/publish-results-${ts}.json`);

const startedAt = new Date().toISOString();
const created = [];
const skipped = [];
const warnings = [];
let aborted = null;

function saveResults(extra = {}) {
  const payload = {
    ts,
    at: new Date().toISOString(),
    started_at: startedAt,
    mode: dryRun ? "dry-run" : "live",
    manifest: manifestPath,
    project_id: manifest.project_id ?? null,
    created,
    skipped,
    warnings,
    ...extra,
  };
  ensureDir(resultsPath);
  writeFileSync(resultsPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Результаты: ${resultsPath}`);
  return payload;
}

try {
  if (!manifest.project_id) throw new RedmineError("manifest.project_id обязателен.", { code: "PROJECT_ID_REQUIRED" });
  const issues = Array.isArray(manifest.issues) ? manifest.issues : [];
  if (issues.length === 0) throw new RedmineError("manifest.issues пуст.", { code: "MANIFEST_EMPTY" });

  const auth = await resolveAuth();
  const key = auth.key;
  const defaults = manifest.defaults ?? {};

  // Каталоги проекта тянем один раз на батч.
  const [trackers, priorities, categories, versions] = await Promise.all([
    metadata("trackers", { auth }).then((d) => d.trackers ?? []),
    metadataSafe("priorities", { auth }).then((d) => d.priorities ?? []),
    metadataSafe("categories", { projectId: manifest.project_id, auth }).then((d) => d.issue_categories ?? []),
    metadataSafe("versions", { projectId: manifest.project_id, auth }).then((d) => d.versions ?? []),
  ]);

  const keys = new Set();
  const plans = [];
  for (const raw of issues) {
    const key2 = String(raw.key ?? "").trim();
    if (!key2) {
      skipped.push({ key: raw.key ?? null, code: "KEY_MISSING" });
      continue;
    }
    if (keys.has(key2)) {
      skipped.push({ key: key2, code: "KEY_DUPLICATE" });
      continue;
    }
    keys.add(key2);

    const subject = maskSecrets(redact(String(raw.subject ?? "").trim(), key), key);
    if (!subject) {
      skipped.push({ key: key2, code: "SUBJECT_REQUIRED" });
      continue;
    }

    let description = maskSecrets(redact(String(raw.description ?? ""), key), key);
    const reqId = raw.requirement_id ? String(raw.requirement_id) : null;
    if (reqId && !/requirement_id/i.test(description)) {
      description = `${description.trimEnd()}\n\nrequirement_id: ${reqId}`;
      warnings.push({ key: key2, code: "REQUIREMENT_ID_APPENDED", requirement_id: reqId });
    }
    if (!reqId && !/requirement_id/i.test(description)) {
      if (!allowMissingReq) {
        skipped.push({ key: key2, code: "MISSING_REQUIREMENT_ID" });
        continue;
      }
      warnings.push({ key: key2, code: "MISSING_REQUIREMENT_ID" });
    }

    const trackerId = findById(trackers, raw.tracker ?? defaults.tracker);
    if (trackerId === undefined) {
      skipped.push({ key: key2, code: "TRACKER_UNRESOLVED", value: raw.tracker ?? defaults.tracker ?? null });
      continue;
    }
    const priorityId = findById(priorities, raw.priority ?? defaults.priority);

    plans.push({
      key: key2,
      parentKey: raw.parent_key ? String(raw.parent_key) : null,
      requirement_id: reqId,
      payload: {
        project_id: manifest.project_id,
        tracker_id: trackerId,
        subject,
        description,
        ...(priorityId !== undefined ? { priority_id: priorityId } : {}),
        ...(findById(categories, raw.category) !== undefined ? { category_id: findById(categories, raw.category) } : {}),
        ...(findById(versions, raw.version) !== undefined ? { fixed_version_id: findById(versions, raw.version) } : {}),
        ...(raw.estimated_hours !== undefined ? { estimated_hours: raw.estimated_hours } : {}),
        watchers: raw.watchers ?? [],
      },
    });
  }

  // Родители создаются раньше детей: порядок — волнами по уже созданным key.
  const idByKey = new Map();
  const queue = [...plans];
  while (queue.length) {
    const ready = queue.filter((p) => !p.parentKey || idByKey.has(p.parentKey));
    if (ready.length === 0) {
      throw new RedmineError(`Цикл или висячий parent_key в манифесте: ${queue.map((p) => p.key).join(", ")}`, { code: "PARENT_CYCLE" });
    }
    for (const plan of ready) {
      const payload = { ...plan.payload };
      const watchers = payload.watchers;
      delete payload.watchers;
      if (plan.parentKey) payload.parent_id = idByKey.get(plan.parentKey);

      if (dryRun) {
        idByKey.set(plan.key, `dry:${plan.key}`);
        created.push({ key: plan.key, redmine_id: null, parent_key: plan.parentKey, subject: payload.subject, tracker_id: payload.tracker_id });
        console.log(`[dry-run] ${plan.key} ← ${payload.subject}`);
        queue.splice(queue.indexOf(plan), 1);
        continue;
      }

      try {
        const { issue } = await createIssue(payload, { auth });
        idByKey.set(plan.key, issue.id);
        let parentLinked = null;
        if (payload.parent_id) {
          parentLinked = await verifyParentLinkage(issue.id, payload.parent_id, { auth });
          if (!parentLinked) {
            warnings.push({
              key: plan.key,
              code: "PARENT_DROPPED",
              parent_key: plan.parentKey,
              hint: "Redmine отбросил parent_id: у трекёра ребёнка не настроен subtask для трекёра родителя",
            });
          }
        }
        created.push({ key: plan.key, redmine_id: issue.id, parent_key: plan.parentKey, parent_linked: parentLinked, subject: issue.subject, tracker_id: issue.tracker?.id });
        console.log(`#${issue.id} ← ${plan.key}: ${issue.subject}`);
        for (const w of watchers ?? []) {
          const userId = Number.isInteger(Number(w)) && typeof w !== "string" ? Number(w) : null;
          if (userId === null) {
            warnings.push({ key: plan.key, code: "WATCHER_SKIPPED", value: w, hint: "передайте numeric user_id: users.json требует прав администратора" });
            continue;
          }
          await addWatcher(issue.id, userId, { auth });
        }
      } catch (err) {
        if (err instanceof RedmineError && (err.code === "REDMINE_UNAUTHORIZED" || err.code === "REDMINE_FORBIDDEN")) {
          aborted = { code: err.code, status: err.status, message: redact(err.message, key), at_key: plan.key };
          break;
        }
        skipped.push({ key: plan.key, code: err?.code ?? "CREATE_FAILED", message: redact(err?.message ?? String(err), key) });
      }
      queue.splice(queue.indexOf(plan), 1);
    }
    if (aborted) break;
  }

  const results = saveResults(aborted ? { aborted } : {});
  console.log(`Создано: ${created.length}, отклонено: ${skipped.length}, предупреждений: ${warnings.length}`);
  if (aborted) {
    console.error(`ABORTED ${aborted.code}: батч остановлен на ${aborted.at_key}. Требуется эскалация (права ключа).`);
    process.exit(2);
  }
  if (skipped.length) process.exit(3);
  if (results.created.length === 0 && !dryRun) process.exit(3);
} catch (err) {
  saveResults({ fatal: { code: err?.code ?? "UNEXPECTED", message: err?.message ?? String(err) } });
  fail(err);
}