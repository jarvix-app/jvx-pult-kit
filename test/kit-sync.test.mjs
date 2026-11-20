// Сторож и набор адъютанта с сервера: перед запуском адъютанта сверяется `pult kit hash` с хешем установленного набора и
// при расхождении делается `pult kit pull` в каталог набора. Сбой сверки или перетяжки запуск НЕ роняет: адъютант
// стартует на том, что есть. Сервер и claude подменяют поддельные (test-support/fake-pult.mjs, fake-claude.mjs).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeKitDir } from '../test-support/make-kit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_PULT = path.join(ROOT, 'test-support', 'fake-pult.mjs');
const FAKE_CLAUDE = path.join(ROOT, 'test-support', 'fake-claude.mjs');
const TOKEN = 'tok-secret-kit-123456';
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const ev = (id, type) => ({ id, type, at: '2026-11-03T10:00:00Z', item_code: null, member: { id: 'm1', name: 'Анна' }, payload: {} });

function setup({ kit, events = [ev(1, 'inbox.received')], commands = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-kit-sync-'));
  made.push(dir);
  const kitDir = makeKitDir(ROOT, { commands });
  made.push(kitDir);
  const ctx = { dir, kitDir, state: path.join(dir, 'state'), fake: path.join(dir, 'fake') };
  fs.mkdirSync(ctx.fake);
  scenario(ctx, { events, kit });
  return ctx;
}

const scenario = (ctx, data) => fs.writeFileSync(path.join(ctx.fake, 'scenario.json'), JSON.stringify(data));

function run(ctx, args = [], env = {}) {
  const child = spawn(process.execPath, [path.join(ctx.kitDir, 'scheduler', 'watchdog.mjs'), ...args], {
    env: { ...process.env, PULT_BIN: FAKE_PULT, PULT_CLAUDE_BIN: FAKE_CLAUDE, PULT_WATCHDOG_DIR: ctx.state, FAKE_DIR: ctx.fake, PULT_TOKEN: TOKEN, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));

  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
}

const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const pultCalls = (ctx) => lines(path.join(ctx.fake, 'pult-calls.log')).map((c) => c.args);
const claudeCalls = (ctx) => lines(path.join(ctx.fake, 'claude-calls.log'));
const kitCalls = (ctx, sub) => pultCalls(ctx).filter((a) => a[0] === 'kit' && (!sub || a[1] === sub));
const logText = (ctx) => (fs.existsSync(path.join(ctx.state, 'watchdog.log')) ? fs.readFileSync(path.join(ctx.state, 'watchdog.log'), 'utf8') : '');
const kitState = (ctx) => {
  const f = path.join(ctx.state, 'kit.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
};

const PULLED = { '.pult-role.md': '<!-- pult-role: adjutant -->\nновая роль\n', '.claude/commands/utro.md': '---\ndescription: новая\n---\nтело\n' };

test('набор расходится с сервером: сторож делает kit pull в каталог набора ДО запуска адъютанта и запоминает хеш', async () => {
  const ctx = setup({ kit: { hash: H1, files: PULLED } });
  const r = await run(ctx);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(kitCalls(ctx, 'hash').length, 1);
  assert.deepEqual(kitCalls(ctx, 'hash')[0], ['kit', 'hash', '--json']);
  assert.equal(kitCalls(ctx, 'pull').length, 1);
  // Без --dir: каталог набора - рабочий каталог запуска (путь аргументом не прошёл бы проверку аргументов на Windows).
  assert.deepEqual(kitCalls(ctx, 'pull')[0], ['kit', 'pull', '--json']);
  // Роль и команда перетянуты с сервера в набор.
  assert.match(fs.readFileSync(path.join(ctx.kitDir, '.pult-role.md'), 'utf8'), /новая роль/);
  assert.match(fs.readFileSync(path.join(ctx.kitDir, '.claude', 'commands', 'utro.md'), 'utf8'), /новая/);
  assert.equal(kitState(ctx).hash, H1);
  assert.match(logText(ctx), /Набор адъютанта обновлён с сервера: хеш aaaaaaaaaaaa/);
  // Адъютант запущен, и после перетяжки, а не до неё.
  assert.equal(claudeCalls(ctx).length, 1);
  assert.ok(
    fs.statSync(path.join(ctx.kitDir, '.pult-role.md')).mtimeMs <= claudeCalls(ctx)[0].at + 50,
    'роль записана до того, как стартовал адъютант',
  );
});

test('хеш тот же, что установлен: перетяжки нет, адъютант запускается, хеш спрошен один раз', async () => {
  const ctx = setup({ kit: { hash: H1, files: PULLED } });
  fs.mkdirSync(ctx.state, { recursive: true });
  fs.writeFileSync(path.join(ctx.state, 'kit.json'), JSON.stringify({ hash: H1 }));

  const r = await run(ctx);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(kitCalls(ctx, 'hash').length, 1);
  assert.equal(kitCalls(ctx, 'pull').length, 0);
  assert.equal(claudeCalls(ctx).length, 1);
  assert.ok(!fs.existsSync(path.join(ctx.kitDir, '.pult-role.md')), 'файлы набора не тронуты');
});

test('роль на сервере сменилась между запусками: второй запуск перетягивает набор, хеш в состоянии обновляется', async () => {
  const ctx = setup({ kit: { hashes: [H1, H2], files: PULLED } });

  const first = await run(ctx);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(kitState(ctx).hash, H1);

  // Следующий разбор разрешён не раньше промежутка: состаривание отметки побудки.
  fs.writeFileSync(path.join(ctx.state, 'wake.json'), JSON.stringify({ last_start_at: new Date(Date.now() - 3 * 3600000).toISOString(), last_exit: 0 }));
  scenario(ctx, { events: [ev(1, 'inbox.received'), ev(2, 'inbox.received')], kit: { hashes: [H1, H2], files: PULLED, pullHash: H2 } });
  const second = await run(ctx);

  assert.equal(second.code, 0, second.stderr);
  assert.equal(kitCalls(ctx, 'pull').length, 2);
  assert.equal(kitState(ctx).hash, H2);
});

test('плановый запуск (--run) тоже сверяет набор перед адъютантом', async () => {
  const ctx = setup({ kit: { hash: H1, files: PULLED }, events: [] });
  const r = await run(ctx, ['--run', 'utro']);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(kitCalls(ctx, 'pull').length, 1);
  assert.deepEqual(claudeCalls(ctx).map((c) => c.args), [['-p', '/utro']]);
});

test('нет связи с сервером при сверке: адъютант всё равно стартует на том, что есть; перетяжки нет, в журнале строка', async () => {
  const ctx = setup({ kit: { hashExit: 3, hashStderr: 'нет связи' } });
  const r = await run(ctx);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(claudeCalls(ctx).length, 1);
  assert.equal(kitCalls(ctx, 'pull').length, 0);
  assert.equal(kitState(ctx), null);
  assert.match(logText(ctx), /Сверка набора адъютанта не удалась \(нет связи с сервером\)/);
});

test('токену отказано в наборе (код 5): запуск не падает, в журнале про отсутствие права', async () => {
  const ctx = setup({ kit: { hashExit: 5, hashStderr: 'нет прав' } });
  const r = await run(ctx);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(claudeCalls(ctx).length, 1);
  assert.match(logText(ctx), /нет права на набор адъютанта/);
});

test('сервер без поддержки набора (kit hash не знает, код 2) или вывод не JSON: запуск идёт, перетяжки нет', async () => {
  for (const kit of [undefined, { hashGarbage: 'не json' }, { hash: 'не-хеш' }]) {
    const ctx = setup({ kit });
    const r = await run(ctx);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(claudeCalls(ctx).length, 1, JSON.stringify(kit));
    assert.equal(kitCalls(ctx, 'pull').length, 0);
    assert.match(logText(ctx), /Сверка набора адъютанта/);
  }
});

test('перетяжка не удалась (код 1): запуск идёт на старом наборе, хеш не запоминается, в журнале строка; следующий раз повторит', async () => {
  const ctx = setup({ kit: { hash: H1, pullExit: 1, pullStderr: 'набор не сошёлся' } });
  const r = await run(ctx);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(claudeCalls(ctx).length, 1);
  assert.equal(kitState(ctx), null);
  assert.match(logText(ctx), /pult kit pull не удался \(код 1\)/);
  assert.match(logText(ctx), /набор не сошёлся/);
});

test('тихие события адъютанта не будят, и набор при этом не спрашивается: проход по ленте остаётся дешёвым', async () => {
  const ctx = setup({ kit: { hash: H1, files: PULLED }, events: [ev(1, 'item.taken'), ev(2, 'outbox.queued')] });
  const r = await run(ctx);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(claudeCalls(ctx).length, 0);
  assert.equal(kitCalls(ctx).length, 0);
});

test('набора на диске ещё нет (свежий клон): сторож сам тянет команды и запускает адъютанта', async () => {
  const ctx = setup({ kit: { hash: H1, files: { ...PULLED, '.claude/commands/razbor.md': '---\ndescription: разбор\n---\nтело\n' } }, commands: false });
  const r = await run(ctx);

  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(ctx.kitDir, '.claude', 'commands', 'razbor.md')));
  assert.equal(claudeCalls(ctx).length, 1);
  assert.equal(kitCalls(ctx, 'pull').length, 1, 'одна перетяжка: после неё сверка не повторяется');
});

test('набора нет и сервер его не отдаёт: код 2, адъютанта не будят, причина названа (как раньше при отсутствии команды)', async () => {
  const ctx = setup({ kit: { hashExit: 5, hashStderr: 'нет прав' }, commands: false });
  const r = await run(ctx);

  assert.equal(r.code, 2);
  assert.equal(claudeCalls(ctx).length, 0);
  assert.match(logText(ctx), /нет в \.claude\/commands/);
  assert.match(logText(ctx), /pult kit pull/);
});

test('токен не попадает в журнал при сбое сверки', async () => {
  const ctx = setup({ kit: { hashExit: 1, hashStderr: `ошибка ${TOKEN}` } });
  await run(ctx);

  assert.ok(!logText(ctx).includes(TOKEN));
});

test('на Windows pult как .cmd-обёртка (так его ставит npm): сверка и перетяжка набора проходят, путь набора в аргументах не нужен', { skip: process.platform !== 'win32' && 'только Windows' }, async () => {
  const ctx = setup({ kit: { hash: H1, files: PULLED } });
  const shim = path.join(ctx.dir, 'pult shim.cmd'); // пробел в пути нарочно
  fs.writeFileSync(shim, `@echo off
"${process.execPath}" "${FAKE_PULT}" %*
`);

  const r = await run(ctx, [], { PULT_BIN: shim });

  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(logText(ctx), /Недопустимый аргумент/);
  assert.equal(kitCalls(ctx, 'pull').length, 1);
  assert.match(fs.readFileSync(path.join(ctx.kitDir, '.pult-role.md'), 'utf8'), /новая роль/);
  assert.equal(kitState(ctx).hash, H1);
  assert.equal(claudeCalls(ctx).length, 1);
});
