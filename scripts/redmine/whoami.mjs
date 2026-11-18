// Диагностика канала Redmine: кто аутентифицирован и откуда взят ключ.
// Использование: node scripts/redmine/whoami.mjs
// Никаких записей в Redmine не делает, значение ключа не печатает — только отпечаток sha256.
import { resolveAuth, whoami, baseUrl } from "../lib/redmine.mjs";
import { fail } from "../lib/cli.mjs";

try {
  const auth = await resolveAuth();
  const me = await whoami({ auth });
  console.log(`URL:      ${auth.url}`);
  console.log(`Источник: ${auth.source} (sha ${auth.fp})`);
  console.log(`Пользователь: #${me.user.id} — ${me.user.login} (${me.user.firstname} ${me.user.lastname})`);
  console.log("Ключ аутентифицирован: чтение и создание задач доступны.");
} catch (err) {
  if (baseUrl() === "http://localhost:3000") {
    console.error("Подсказка: проверьте, что Redmine поднят, и REDMINE_URL в .env.");
  }
  fail(err);
}