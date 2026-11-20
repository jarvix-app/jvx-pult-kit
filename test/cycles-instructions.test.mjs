// Инструкции про циклы и личные спринты (ТЗ этапа 2 §9, §10): правила, на которых держится доверие людей к системе.
// Роль адъютанта и команды /cikl, /sprint, /utro лежат на сервере и сверяются там (cli/test/kit/instructions-cycles.test.js);
// здесь - что у агента сотрудника этих действий нет.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

test('команды циклов в набор не входят, а у сотрудника этих действий нет: утверждать и предлагать спринт может только управление', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'roles', 'adjutant.md')), false, 'роль адъютанта вернулась в набор');

  const member = read('roles/member-agent.md');
  assert.doesNotMatch(member, /pult cycle (approve|propose|open)/);
});
