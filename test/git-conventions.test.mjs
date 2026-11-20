// Соглашение git (префикс ветки и ключ строки в коммите) - настройка команды (`git.branch_prefix`, `git.trailer_key`).
// Агент читает его у сервера: `pult settings --section git`. Значения прежних умолчаний (`t/`, `Pult-Item`) в инструкциях
// записывать нельзя: команда сменит соглашение, а агент будет делать ветки и трейлеры по памяти, и коммиты потеряют задачу.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
// Всё, что читает агент в наборе: общие правила и роль сотрудника. Роль и команды адъютанта лежат на сервере
// (cli/test/kit/instructions-git-conventions.test.js).
const INSTRUCTIONS = ['AGENTS.md', 'CLAUDE.md', 'roles/member-agent.md'];

const operationsFile = () => {
  const fromEnv = process.env.PULT_OPERATIONS_JS;
  const sibling = path.resolve(ROOT, '..', 'jvx-pult', 'cli', 'src', 'operations.js');

  return fromEnv || (!process.env.CI && fs.existsSync(sibling) ? sibling : null);
};
const skipOperations = operationsFile() === null && 'PULT_OPERATIONS_JS не задан (в CI это нормально): сверка с таблицей операций пропущена';

/** Зашитые значения соглашения git: ключ строки умолчанием, префикс ветки с кодом задачи или с местом под код. */
export function hardcodedGit(text) {
  const found = [];
  const patterns = {
    'ключ строки Pult-Item': /Pult-Item/i,
    'префикс ветки t/': /(?<![\p{L}\d_/.-])t\/(?=[A-ZА-Я]-?\d|<)/u,
  };

  for (const [what, re] of Object.entries(patterns)) {
    const m = text.match(re);
    if (m) found.push(`${what}: «${m[0]}»`);
  }

  return found;
}

test('в инструкциях нет зашитых Pult-Item и префикса ветки t/: значения берутся у сервера', () => {
  const problems = [];

  for (const file of INSTRUCTIONS) {
    for (const found of hardcodedGit(read(file))) problems.push(`${file}: ${found}`);
  }

  assert.deepEqual(problems, []);
});

test('детектор видит прежние умолчания и не трогает обычные слова с косой чертой', () => {
  assert.equal(hardcodedGit('Pult-Item: D-07').length, 1);
  assert.equal(hardcodedGit('ветка t/D-07-forma').length, 1);
  assert.equal(hardcodedGit('git push origin t/<код>-имя').length, 1);
  assert.deepEqual(hardcodedGit('`task edit/assign`, `epic add/edit/horizon`, git push origin <ветка>'), []);
  assert.deepEqual(hardcodedGit('`<trailer_key>: <код задачи>` и `<branch_prefix><код>-краткое-имя`'), []);
});

test('агент сотрудника читает соглашение git: pult settings --section git, ветка и трейлер из ответа', () => {
  const text = read('roles/member-agent.md').replace(/\s+/g, ' ');

  assert.match(text, /pult settings --section git/);
  assert.match(text, /`branch_prefix`/);
  assert.match(text, /`trailer_key`/);
  assert.match(text, /`<branch_prefix><код>-краткое-имя`/);
  assert.match(text, /`<trailer_key>: <код задачи>`/);
  // Чтение идёт до первой ветки и до первого коммита, а не после.
  assert.ok(text.indexOf('pult settings --section git') < text.indexOf('pult renew D-07'), 'соглашение git читается до работы, а не после');
  // Пуш и проверка origin - по ветке, названной по ответу сервера.
  assert.match(text, /git push origin <ветка>/);
  assert.match(text, /git ls-remote origin <ветка>/);
});

test('операция settings знает раздел git (иначе инструкция отправила бы агента в 422)', { skip: skipOperations }, async () => {
  const mod = await import(pathToFileURL(operationsFile()).href);
  const op = mod.OPERATIONS.find((o) => o.id === 'settings');

  assert.ok(op, 'в таблице операций нет settings');
  const section = op.params.find((p) => p.name === 'section');
  assert.ok(section && section.enum.includes('git'), 'у settings нет раздела git');
});

test('ключи git.branch_prefix и git.trailer_key есть в реестре настроек сервера', { skip: skipOperations }, () => {
  const registryFile = path.resolve(path.dirname(operationsFile()), '..', '..', 'app', 'Services', 'Settings', 'SettingsRegistry.php');

  if (!fs.existsSync(registryFile)) return; // операции есть, а исходников сервера рядом нет: сверять не с чем

  const registry = fs.readFileSync(registryFile, 'utf8');

  for (const key of ['git.branch_prefix', 'git.trailer_key']) assert.ok(registry.includes(`new Setting('${key}'`), `в реестре нет ${key}`);
});
