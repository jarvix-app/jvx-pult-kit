// Порядок работы агента сотрудника: «как понял» до кода, отметка после волны, ручная проверка перед сдачей; и разбор сдач
// в /razbor. Ключевые фразы: правило не должно тихо пропасть при правке текста. Имена команд сверяет instructions-vs-cli.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n').replace(/\s+/g, ' ');

test('member-agent: «как понял» до кода, пересказ дословно со слов человека, план волн, вопросы, мелочь', () => {
  const t = read('roles/member-agent.md');
  assert.match(t, /Как понял — до кода/);
  assert.match(t, /Код не пишется, пока этого шага нет/);
  assert.match(t, /со слов человека/);
  assert.match(t, /дословно/);
  assert.match(t, /Пересказ за человека не сочиняй/);
  assert.match(t, /план волн/);
  assert.ok(t.includes('pult ask'), 'вопрос уходит командой pult ask');
  assert.doesNotMatch(t, /ВОПРОС:/, 'старый комментарий «ВОПРОС:» заменён командой');
  assert.match(t, /Не больше трёх открытых вопросов на задачу/);
  assert.match(t, /Что считать мелочью, решает человек/);
});

test('member-agent: отметка после каждой волны', () => {
  const t = read('roles/member-agent.md');
  assert.match(t, /Волны и отметка после каждой/);
  assert.match(t, /"Волна 1: что сделано; тесты: \d+; sha .*человек сам посмотрел/);
});

test('member-agent: ручная проверка перед сдачей идёт раньше сдачи и не подменяется тестами', () => {
  const t = read('roles/member-agent.md');
  assert.match(t, /Ручная проверка перед сдачей/);
  assert.match(t, /\*\*самому\*\*/);
  assert.match(t, /«Проверено руками» за человека не пиши/);
  assert.match(t, /свой прогон тестов за ручную проверку не выдавай/);
  assert.match(t, /сдаче это не мешает/);
  assert.ok(t.indexOf('Ручная проверка перед сдачей') < t.indexOf('**Сдача.**'), 'ручная проверка должна стоять до сдачи');
  assert.ok(t.indexOf('Как понял — до кода') < t.indexOf('Соглашение git'), '«как понял» должно стоять до работы в git');
});

test('README: адреса конкретной команды нет (набор готовится к публикации), адрес называет продакт', () => {
  const t = read('README.md');
  // Набор может стать публичным (C-172): адрес стенда конкретной команды в нём не пишется.
  assert.doesNotMatch(t, /jvx-team|jvx-pult\.uz/);
  assert.match(t, /https:\/\/<адрес команды>\/cli\/pult\.tgz/);
  assert.match(t, /называет продакт/);
  assert.match(t, /закрытый/);
  assert.doesNotMatch(t, /адрес-команды/);
});
