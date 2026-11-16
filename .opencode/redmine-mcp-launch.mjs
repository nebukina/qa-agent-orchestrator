// Launcher для MCP-сервера Redmine.
//
// Зачем: OpenCode 2.2.7 не раскрывает {env:REDMINE_KEY} в environment локального сервера,
// а фоновый сервис наследует окружение момента своего запуска и может держать устаревшее
// значение переменной. Любой из этих случаев даёт молчаливую деградацию: пакет ходит в
// Redmine анонимно, чтение публичного проекта работает, а запись падает с
// "Credenciales inválidas o sin permiso para esta acción."
//
// Поэтому: кандидаты проверяются живым GET /users/current.json, побеждает первый
// аутентифицировавшийся. Источник истины — .env проекта, унаследованные переменные
// идут как резерв. Ключ в stderr не печатается, только отпечаток sha256.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIAG = join(process.env.TEMP ?? '/tmp', 'opencode', 'redmine-launch-diag.json');

function fromDotEnv(name) {
  const file = join(root, '.env');
  if (!existsSync(file)) return null;
  const line = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trimStart().startsWith(`${name}=`));
  if (!line) return null;
  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') || null;
}

// Ключ API Redmine — 40 hex-символов; граница 20 отсекает обрезанные и нераскрытые {env:...}.
const plausible = (v) => typeof v === 'string' && v.length >= 20 && !v.includes('{env:');

const url = [fromDotEnv('REDMINE_URL'), process.env.REDMINE_URL]
  .find((v) => plausible(v) && v.startsWith('http')) ?? 'http://localhost:3000';

const candidates = [
  ['.env', fromDotEnv('REDMINE_KEY')],
  ['REDMINE_KEY', process.env.REDMINE_KEY],
  ['REDMINE_API_KEY', process.env.REDMINE_API_KEY],
].filter(([, v]) => plausible(v));

async function authenticates(key) {
  try {
    const res = await fetch(`${url}/users/current.json`, {
      headers: { 'X-Redmine-API-Key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

let chosen = null;
for (const [source, key] of candidates) {
  if (await authenticates(key)) { chosen = { source, key }; break; }
  console.error(`redmine-mcp-launch: кандидат из ${source} не аутентифицировался, пробуем следующий`);
}

if (!chosen) {
  console.error(`redmine-mcp-launch: ни один ключ не аутентифицировался на ${url}. Проверьте .env и права ключа.`);
  process.exit(1);
}

const fp = createHash('sha256').update(chosen.key).digest('hex').slice(0, 12);
try {
  writeFileSync(DIAG, JSON.stringify({ at: new Date().toISOString(), url, source: chosen.source, fp, pid: process.pid }));
} catch { /* диагностика не критична */ }
console.error(`redmine-mcp-launch: ключ из "${chosen.source}" (sha ${fp}) аутентифицирован, url=${url}`);

// Локальная установка предпочтительнее кэша npx: путь в кэше меняется при апгрейде пакета.
const localEntry = join(root, 'node_modules/@speraltafibrazo/redmine-mcp/dist/index.js');
const cacheBase = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'npm-cache', '_npx') : null;
let cachedEntry = null;
if (cacheBase && existsSync(cacheBase)) {
  try {
    cachedEntry = readdirSync(cacheBase)
      .map((d) => join(cacheBase, d, 'node_modules/@speraltafibrazo/redmine-mcp/dist/index.js'))
      .find((p) => existsSync(p));
  } catch { cachedEntry = null; }
}
const entry = existsSync(localEntry) ? localEntry : cachedEntry;
const env = { ...process.env, REDMINE_URL: url, REDMINE_API_KEY: chosen.key };

const child = entry
  ? spawn(process.execPath, [entry], { stdio: 'inherit', env })
  : spawn('npx', ['-y', '@speraltafibrazo/redmine-mcp'], { stdio: 'inherit', env, shell: true });

child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (err) => {
  console.error('redmine-mcp-launch: не удалось запустить пакет:', err.message);
  process.exit(1);
});