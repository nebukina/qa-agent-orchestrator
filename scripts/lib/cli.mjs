// Мелкие помощники для CLI-скриптов Redmine: разбор аргументов, {ts}, маска секретов.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Флаги вида `--key value` и булевы `--flag`. Возвращает объект без префиксов. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[name] = next;
      i += 1;
    } else {
      out[name] = true;
    }
  }
  return out;
}

/** {ts} в том же формате, что у артефактов: yyyyMMdd-HHmmss. */
export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function ensureDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

/** Читает текст из файла или из строки флага — для длинных описаний и заметок. */
export function readTextArg(value, filePath) {
  if (filePath) return readFileSync(filePath, "utf8");
  if (typeof value === "string" && value.trim()) return value;
  return null;
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{10,}/g,
  /\bATATT[A-Za-z0-9_/+=-]{10,}/g,
  /\b[0-9a-f]{40}\b/gi,
];

/**
 * Маскирует похожие на секрет фрагменты перед тем, как текст попадёт в артефакт
 * или в Redmine (правило Data Leakage в AGENTS.md).
 */
export function maskSecrets(text, key) {
  let out = String(text ?? "");
  if (key) out = out.split(key).join("[REDACTED]");
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

/** Читает JSON, срезая BOM: редакторы и PowerShell любят его добавлять. */
export function readJson(filePath) {
  const text = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

export function fail(err) {
  const code = err?.code ?? "UNEXPECTED";
  console.error(`${code}: ${err?.message ?? String(err)}`);
  if (err?.details) console.error(JSON.stringify(err.details));
  process.exit(1);
}