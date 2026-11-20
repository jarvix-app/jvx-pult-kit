// Каталог набора для тестов сторожа: копия scheduler/*.mjs и (по умолчанию) заглушки команд адъютанта.
//
// Настоящие команды в git набора не лежат: их ставит `pult kit pull` с сервера. Сторож ищет команду в
// <каталог набора>/.claude/commands, поэтому тест собирает свой временный набор, а не пишет в рабочий каталог репозитория
// (там мог бы лежать настоящий набор живого адъютанта).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Команды адъютанта, как их отдаёт сервер (resources/kit/adjutant/commands). Список сверяет сервер своим тестом. */
export const COMMANDS = ['cikl', 'den', 'mesyac', 'nedelya', 'obhod', 'plan', 'raund', 'razbor', 'sprint', 'utro', 'vecher'];

/**
 * @param {string} root корень набора (откуда копируются скрипты сторожа)
 * @param {{commands?: boolean}} [opts] commands: false - каталог без команд (набор ещё не поставлен)
 * @returns {string} путь к временному набору; удаляет вызывающий
 */
export function makeKitDir(root, { commands = true } = {}) {
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-kit-dir-'));
  fs.mkdirSync(path.join(kit, 'scheduler'));

  for (const name of fs.readdirSync(path.join(root, 'scheduler'))) {
    if (name.endsWith('.mjs')) fs.copyFileSync(path.join(root, 'scheduler', name), path.join(kit, 'scheduler', name));
  }

  if (commands) {
    fs.mkdirSync(path.join(kit, '.claude', 'commands'), { recursive: true });

    for (const name of COMMANDS) {
      fs.writeFileSync(path.join(kit, '.claude', 'commands', `${name}.md`), `---\ndescription: заглушка ${name}\n---\nтест\n`);
    }
  }

  return kit;
}
