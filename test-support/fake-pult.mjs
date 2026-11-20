// Поддельный pult для тестов сторожа и установщика. Поведение задаёт $FAKE_DIR/scenario.json, вызовы пишутся в $FAKE_DIR/pult-calls.log.
//
// Набор адъютанта (`pult kit hash`, `pult kit pull`) задаёт scenario.kit:
//   hash        хеш, который отдаёт `kit hash`; hashes — список хешей по порядку вызовов (последний повторяется)
//   hashExit    код выхода `kit hash` (с текстом scenario.kit.hashStderr); hashGarbage — вывод не JSON
//   files       что «пишет» `kit pull` в --dir: { "относительный путь": "содержимое" }
//   pullHash    хеш, который `kit pull` называет в --json (по умолчанию hash)
//   pullExit    код выхода `kit pull` (с текстом pullStderr): файлы при этом не пишутся
// Без scenario.kit обе команды отвечают кодом 2, как утилита без такой поддержки.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));

fs.appendFileSync(path.join(dir, 'pult-calls.log'), `${JSON.stringify({ args })}\n`);

if (scenario.exit) {
  process.stderr.write(`${scenario.stderr ?? 'ошибка'}\n`);
  process.exit(scenario.exit);
}

if (args[0] === 'whoami') {
  process.stdout.write(JSON.stringify(scenario.whoami));
  process.exit(0);
}

// Хеш, который сейчас «на сервере»: по номеру вызова `kit hash` (последний повторяется). `kit pull` отдаёт тот же.
function currentHash(kit) {
  if (!kit.hashes) return kit.hash;

  const calls = fs
    .readFileSync(path.join(dir, 'pult-calls.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).args)
    .filter((a) => a[0] === 'kit' && a[1] === 'hash').length;

  return kit.hashes[Math.max(0, Math.min(calls - 1, kit.hashes.length - 1))];
}

if (args[0] === 'kit') {
  const kit = scenario.kit;

  if (!kit) {
    process.stderr.write('в сценарии нет набора адъютанта\n');
    process.exit(2);
  }

  if (args[1] === 'hash') {
    if (kit.hashExit) {
      process.stderr.write(`${kit.hashStderr ?? 'ошибка'}\n`);
      process.exit(kit.hashExit);
    }

    const hash = currentHash(kit);

    process.stdout.write(kit.hashGarbage ?? JSON.stringify({ hash }));
    process.exit(0);
  }

  if (args[1] === 'pull') {
    if (kit.pullExit) {
      process.stderr.write(`${kit.pullStderr ?? 'ошибка'}\n`);
      process.exit(kit.pullExit);
    }

    // Как у настоящей утилиты: без --dir пишет в текущий каталог.
    const target = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : process.cwd();
    const written = [];
    const dry = args.includes('--dry-run');

    for (const [rel, content] of Object.entries(kit.files ?? {})) {
      const file = path.join(target, ...rel.split('/'));

      if (!dry) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      }

      written.push(file);
    }

    const hash = kit.pullHash ?? currentHash(kit) ?? '';

    process.stdout.write(
      args.includes('--json')
        ? JSON.stringify({ hash, dry_run: dry, dir: target, written, removed: [] })
        : `Набор адъютанта, хеш ${String(hash).slice(0, 12)}…, ${Object.keys(kit.files ?? {}).length} команд. ${dry ? 'Будет записано' : 'Записано'}:\n${written.map((f) => `  ${f}`).join('\n')}\n`,
    );
    process.exit(0);
  }
}

if (args[0] === 'settings') {
  // Настройки команды: без них в сценарии `pult settings` не удаётся, как у недоступного сервера.
  if (!scenario.settings) {
    process.stderr.write('в сценарии нет настроек\n');
    process.exit(2);
  }

  process.stdout.write(JSON.stringify(scenario.settings));
  process.exit(0);
}

if (args[0] !== 'events') {
  process.stderr.write('поддельный pult знает только events, whoami, kit и settings\n');
  process.exit(2);
}

const since = Number(args[args.indexOf('--since') + 1] ?? 0);
const pageSize = scenario.pageSize ?? 1000;
const rest = scenario.events.filter((e) => e.id > since);
const page = rest.slice(0, pageSize);

process.stdout.write(
  scenario.garbage ??
    JSON.stringify({
      events: page,
      cursor: page.length ? page[page.length - 1].id : since,
      has_more: rest.length > page.length,
    }),
);
