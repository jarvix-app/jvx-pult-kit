// Каждая команда `pult …`, упомянутая в инструкциях, должна быть в таблице операций настоящей утилиты.
// Путь к таблице — переменная PULT_OPERATIONS_JS (jvx-pult/cli/src/operations.js). Без неё проверка пропускается
// явно; рядом лежащий клон подхватывается только вне CI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Команды, которые есть в cli.js отдельно от таблицы операций.
const BUILTIN = new Set(['login', 'help']);
const GLOBAL_FLAGS = new Set(['json', 'timeout', 'help', 'version']);

/** Все .md набора, кроме voice/ (там свой автор и свои проверки) и служебных каталогов. */
function markdownFiles(dir = ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'voice'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Куски текста, где `pult …` — команда: строки внутри ``` и строчный `код`. */
export function codeSnippets(text) {
  const out = [];
  let fenced = false;

  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) out.push(line);
    else for (const m of line.matchAll(/`([^`]+)`/g)) out.push(m[1]);
  }

  return out;
}

/** Из куска кода достаёт вызовы утилиты: команда (до трёх слов) и флаги этого вызова. */
export function pultCalls(snippet) {
  const calls = [];

  for (const m of snippet.matchAll(/(?:^|[\s(;|&$])pult\s+([A-Za-z][A-Za-z-]*)(?:\s+([A-Za-z][A-Za-z-]*))?(?:\s+([A-Za-z][A-Za-z-]*))?([^`;|&]*)/g)) {
    const flags = [...m[4].matchAll(/(?:^|\s)--([A-Za-z][A-Za-z-]*)/g)].map((f) => f[1]);
    calls.push({ first: m[1], second: m[2], third: m[3], flags, text: m[0].trim() });
  }

  return calls;
}

function loadOperations() {
  const fromEnv = process.env.PULT_OPERATIONS_JS;
  const sibling = path.resolve(ROOT, '..', 'jvx-pult', 'cli', 'src', 'operations.js');
  const file = fromEnv || (!process.env.CI && fs.existsSync(sibling) ? sibling : null);

  return file ? import(pathToFileURL(file).href).then((m) => m.OPERATIONS) : null;
}

const flagNames = (op) => new Set(op.params.map((p) => p.flag ?? p.name.replaceAll('_', '-')));

/** Возвращает список расхождений; пустой — всё сходится. */
export function problems(calls, operations) {
  const found = [];

  for (const call of calls) {
    if (BUILTIN.has(call.first)) continue;

    const candidates = operations.filter((o) => o.cmd[0] === call.first);
    // Самая длинная подходящая команда: `project member add`, затем `project show`, затем `projects`.
    const op =
      candidates.find((o) => o.cmd.length === 3 && o.cmd[1] === call.second && o.cmd[2] === call.third) ??
      candidates.find((o) => o.cmd.length === 2 && o.cmd[1] === call.second) ??
      candidates.find((o) => o.cmd.length === 1);

    if (!op) {
      found.push(`нет такой команды: «${call.text}»`);
      continue;
    }

    for (const f of call.flags) {
      if (!GLOBAL_FLAGS.has(f) && !flagNames(op).has(f)) found.push(`у «pult ${op.cmd.join(' ')}» нет флага --${f}: «${call.text}»`);
    }
  }

  return found;
}

const skip = (await loadOperations()) === null && 'PULT_OPERATIONS_JS не задан (в CI это нормально): сверка имён команд с утилитой пропущена';

test('команды pult в инструкциях существуют в таблице операций утилиты', { skip }, async () => {
  const operations = await loadOperations();
  const calls = [];

  for (const file of markdownFiles()) {
    for (const snippet of codeSnippets(fs.readFileSync(file, 'utf8'))) {
      for (const c of pultCalls(snippet)) calls.push({ ...c, text: `${path.relative(ROOT, file)}: ${c.text}` });
    }
  }

  assert.ok(calls.length > 30, `нашлось подозрительно мало вызовов pult (${calls.length}): извлечение сломалось`);
  assert.deepEqual(problems(calls, operations), []);
});

test('сверка видит выдуманную команду и выдуманный флаг', async () => {
  const operations = [
    { cmd: ['done'], params: [{ name: 'proof_sha' }, { name: 'code' }] },
    { cmd: ['task', 'add'], params: [{ name: 'kind' }] },
    { cmd: ['task', 'edit'], params: [{ name: 'title' }] },
  ];
  const check = (text) => problems(codeSnippets(text).flatMap(pultCalls), operations);

  assert.deepEqual(check('`pult done D-07 --proof-sha abc --json`'), []);
  assert.deepEqual(check('```sh\npult task add dev "x"\n```'), []);
  assert.equal(check('`pult frobnicate D-07`').length, 1);
  assert.equal(check('`pult task delete D-07`').length, 1);
  assert.equal(check('`pult done D-07 --proof-magic x`').length, 1);
  assert.equal(check('```sh\npult send Имя "текст"\n```').length, 1);
  assert.deepEqual(check('утилита pult ещё не готова, `pult-mcp` и `claude mcp add pult -- pult-mcp`'), []);
});

test('сверка понимает команды из трёх слов', async () => {
  const operations = [
    { cmd: ['project', 'show'], params: [{ name: 'limit' }] },
    { cmd: ['project', 'member', 'add'], params: [{ name: 'code' }, { name: 'member' }] },
  ];
  const check = (text) => problems(codeSnippets(text).flatMap(pultCalls), operations);

  assert.deepEqual(check('`pult project member add PLV Анна`'), []);
  assert.deepEqual(check('`pult project show PLV --limit 5`'), []);
  assert.equal(check('`pult project member kick PLV Анна`').length, 1);
  assert.equal(check('`pult project member add PLV Анна --force`').length, 1);
});

test('извлечение берёт команды только из кода и не принимает прозу за команду', () => {
  assert.deepEqual(codeSnippets('Текст про pult done и всё.\n\n```sh\npult my\n```\n`pult whoami --json`'), ['pult my', 'pult whoami --json']);
  assert.deepEqual(pultCalls('echo <токен> | pult login - --server https://x').map((c) => c.first), ['login']);
});
