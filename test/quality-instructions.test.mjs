// Качество сдачи и карта тестирования (волна 3) в инструкциях: ключевые фразы, чтобы запреты не пропали при правке текста.
// Имена команд и флагов сверяет instructions-vs-cli.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n').replace(/\s+/g, ' ');

test('member-agent: стенд за человека не подтверждается, отметок прохода нет, `all` только если прошёл всё', () => {
  const t = read('roles/member-agent.md');
  assert.match(t, /Подтверждать проверку стенда за человека/);
  assert.match(t, /Команды нет; искать обход/);
  assert.match(t, /Ставить отметки прохода карты тестирования/);
  assert.ok(t.includes('Выставлять `--stand-scenarios all`**, если человек прошёл не все'));
  assert.match(t, /Возражать по причине бага за человека/);
});

test('member-agent: сценарии, заявка на стенд, разделы и «вырос из»', () => {
  const t = read('roles/member-agent.md');
  assert.ok(t.includes('pult task scenario add'));
  assert.match(t, /иди по сценариям задачи/);
  assert.match(t, /Заявка «проверено на стенде»/);
  assert.match(t, /только по тем сценариям, которые он назвал пройденными/);
  assert.match(t, /Проверил сам/);
  assert.match(t, /без проверки на стенде/);
  assert.ok(t.includes('pult task sections'));
  assert.match(t, /Не знаешь, какие разделы, — спроси человека, не угадывай/);
  assert.ok(t.includes('--grew-from'));
  assert.ok(t.includes('**один раз возразить**'));
  assert.ok(t.indexOf('Заявка «проверено на стенде»') < t.indexOf('Упёрся — отпусти бронь'), 'заявка описана в шаге сдачи');
});
