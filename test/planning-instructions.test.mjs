// Инструкции про планирование (волна 2.5): техдолг, эпики как сущности, вехи, доска, правила из настроек команды.
// Имена команд и флагов сверяет instructions-vs-cli.test.mjs; здесь - что нужные правила вообще записаны и что в тексте не
// осталось чисел и правил, которые теперь настройка команды (`pult settings`). Не заменяет чтения, но не даёт правилу
// тихо пропасть при правке.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

// Всё, что читает агент в наборе: общие правила и роль сотрудника. Роль и команды адъютанта лежат на сервере
// (cli/test/kit/instructions-planning.test.js).
const INSTRUCTIONS = ['AGENTS.md', 'CLAUDE.md', 'roles/member-agent.md'];

const operationsFile = () => {
  const fromEnv = process.env.PULT_OPERATIONS_JS;
  const sibling = path.resolve(ROOT, '..', 'jvx-pult', 'cli', 'src', 'operations.js');

  return fromEnv || (!process.env.CI && fs.existsSync(sibling) ? sibling : null);
};
const skipOperations = operationsFile() === null && 'PULT_OPERATIONS_JS не задан (в CI это нормально): сверка с таблицей операций пропущена';

/** Значения, которые теперь настройка команды: час, срок брони, день недели, длина спринта. Возвращает найденное. */
export function hardcodedSettings(text) {
  // Даты с временем в примерах (`--since "2026-10-01 00:00"`) числами-настройками не считаются.
  // Фраза «неделя принадлежит месяцу, в котором её четверг» - правило ISO-недели, а не день недельного слоя.
  const clean = text.replace(/в котором её четверг/g, '').replace(/\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?/g, '');
  const found = [];
  const patterns = {
    'час суток': /\b\d{1,2}:\d{2}\b/,
    'срок брони в примере': /--for\s+\d/,
    'срок числом': /\b\d+\s*(минут\p{L}*|мин\.|час\p{L}*|ч|m|h)(?![\p{L}\d])/u,
    'день недели': /(?<![\p{L}])(пятниц\p{L}*|понедельник\p{L}*|вторник\p{L}*|четверг\p{L}*|суббот\p{L}*|воскресень\p{L}*|сред[аыуе])(?![\p{L}])/iu,
    'длина спринта': /на месяц(?![\p{L}])/iu,
  };

  for (const [what, re] of Object.entries(patterns)) {
    const m = clean.match(re);
    if (m) found.push(`${what}: «${m[0]}»`);
  }

  return found;
}

test('техдолг (debt): буква L, всегда --why и --trigger, сотрудник предлагает только черновиком (роль сотрудника)', () => {
  for (const file of ['roles/member-agent.md']) {
    const text = read(file);

    assert.match(text, /pult task add debt [^\n]*--why [^\n]*--trigger /, `${file}: нет примера техдолга с --why и --trigger`);
    assert.match(text, /L-02/, `${file}: нет буквы кода техдолга`);
    assert.match(text.replace(/\s+/g, ' '), /без (них|обоих) сервер откажет \(422\)/, `${file}: не сказано, что без причины сервер откажет`);
  }

  assert.match(read('roles/member-agent.md'), /Долг тоже предлагается только черновиком/);
});

test('агент сотрудника не получает операций планирования: epic, milestone и task move закрыты сервером и названы запретами', () => {
  const text = read('roles/member-agent.md');

  assert.doesNotMatch(text, /^\s*pult (epic|milestone) (add|edit|horizon|remove)/m, 'в роли сотрудника есть шаг заведения эпика или вехи');
  assert.doesNotMatch(text, /^\s*pult task move/m);
  assert.match(text, /двигать их по\s+доске \(`task move`\), заводить и править эпики и вехи \(`epic add\/edit\/horizon`, `milestone add\/edit\/remove`\)/);
  assert.match(text, /эпики и вехи\s+заводят продакт и адъютант/);
  assert.match(text, /`pult epics` и `pult milestones`/, 'читать эпики и вехи сотрудник может');
});

test('правила из настроек команды: в общих правилах и роли сотрудника нет часов, сроков брони, дней недели и длины спринта', () => {
  const problems = [];

  for (const file of INSTRUCTIONS) {
    for (const found of hardcodedSettings(read(file))) problems.push(`${file}: ${found}`);
  }

  assert.deepEqual(problems, []);
});

test('детектор зашитых значений видит час, срок брони, день недели и длину спринта и не трогает даты в примерах', () => {
  assert.equal(hardcodedSettings('утренний запуск в 09:00').length, 1);
  assert.ok(hardcodedSettings('`pult take D-07 --for 2h`').length >= 1);
  assert.equal(hardcodedSettings('бронь на 90 минут').length, 1);
  assert.equal(hardcodedSettings('неделя - в пятницу').length, 1);
  assert.equal(hardcodedSettings('спринт на месяц').length, 1);
  assert.deepEqual(hardcodedSettings('`pult trace Имя --since "2026-10-01 00:00"` и `pult take D-07 --for <срок>`'), []);
  assert.deepEqual(hardcodedSettings('среди прочего: срок брони - настройка команды'), []);
});

test('срок брони у сотрудника - из настроек: примеры take и renew без --for, срок флагом --for <срок>', () => {
  const text = read('roles/member-agent.md');

  assert.match(text, /^\s+pult take D-07$/m);
  assert.match(text, /^\s+pult renew D-07$/m);
  assert.match(text, /`--for <срок>`/);
});

test('ключи настроек, названные в общих правилах, роли сотрудника и README, есть в реестре сервера', { skip: skipOperations }, () => {
  const registryFile = path.resolve(path.dirname(operationsFile()), '..', '..', 'app', 'Services', 'Settings', 'SettingsRegistry.php');

  if (!fs.existsSync(registryFile)) return; // операции есть, а исходников сервера рядом нет: сверять не с чем

  const keys = [...fs.readFileSync(registryFile, 'utf8').matchAll(/new Setting\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(keys.length > 30, `в реестре нашлось подозрительно мало ключей (${keys.length}): разбор сломался`);

  const named = [];
  for (const file of [...INSTRUCTIONS, 'README.md']) {
    for (const m of read(file).matchAll(/`((?:daily|claim|sprint|pulse|members|adjutant)\.[a-z_*.]+)`/g)) named.push({ file, key: m[1] });
  }

  // `sprint.plan` и `sprint.close` — моменты регламентов (`pult reg for sprint.plan`), а не ключи настроек:
  // у них тот же вид «слово.слово», поэтому из сверки с реестром настроек они исключаются явно.
  const MOMENTS = new Set(['sprint.plan', 'sprint.close']);
  for (let i = named.length - 1; i >= 0; i--) if (MOMENTS.has(named[i].key)) named.splice(i, 1);

  // Порог «ключи вообще нашлись» делился на двоих: здесь общие правила, роль сотрудника и README (ключ один), роль и команды
  // адъютанта (восемь ключей) сверяет сервер.
  assert.ok(named.length >= 1, 'не нашлось ключей настроек в инструкциях');

  for (const { file, key } of named) {
    const ok = key.endsWith('.*') ? keys.some((k) => k.startsWith(key.slice(0, -1))) : keys.includes(key);
    assert.ok(ok, `${file}: настройки «${key}» нет в реестре сервера`);
  }
});

test('README называет /plan (расспрос продакта); сам текст команды и роль адъютанта сверяет сервер', () => {
  assert.match(read('README.md').replace(/\s+/g, ' '), /`\/plan` — расспрос продакта/);
});
