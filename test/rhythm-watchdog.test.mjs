import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeKitDir } from '../test-support/make-kit.mjs';

/*
 * Сторож и настройки команды: плановые запуски по часам команды, промежуток побудки из настроек, общий учёт
 * «сегодня уже было» для сторожа и заданий Планировщика. Сервер подменяет поддельный pult (settings из сценария).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Сторож запускается из своего временного набора: команд адъютанта в git набора нет (их ставит pult kit pull).
const KIT = makeKitDir(ROOT);
const WATCHDOG = path.join(KIT, 'scheduler', 'watchdog.mjs');
const FAKE_PULT = path.join(ROOT, 'test-support', 'fake-pult.mjs');
const FAKE_CLAUDE = path.join(ROOT, 'test-support', 'fake-claude.mjs');

const made = [KIT];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function setup(events = [], extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-kit-rhythm-'));
  made.push(dir);
  const ctx = { dir, state: path.join(dir, 'state'), fake: path.join(dir, 'fake') };
  fs.mkdirSync(ctx.fake);
  scenario(ctx, { events, ...extra });
  return ctx;
}

const scenario = (ctx, data) => fs.writeFileSync(path.join(ctx.fake, 'scenario.json'), JSON.stringify(data));
const ev = (id, type) => ({ id, type, at: '2026-11-03T10:00:00Z', item_code: null, member: { id: 'm1', name: 'Анна' }, payload: {} });

function run(ctx, { env = {}, args = [] } = {}) {
  const child = spawn(process.execPath, [WATCHDOG, ...args], {
    env: { ...process.env, PULT_BIN: FAKE_PULT, PULT_CLAUDE_BIN: FAKE_CLAUDE, PULT_WATCHDOG_DIR: ctx.state, FAKE_DIR: ctx.fake, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));

  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
}

const lines = (file) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const claudeCalls = (ctx) => lines(path.join(ctx.fake, 'claude-calls.log'));
const pultCalls = (ctx) => lines(path.join(ctx.fake, 'pult-calls.log'));
const settingsCalls = (ctx) => pultCalls(ctx).filter((c) => c.args[0] === 'settings');
const cursorOf = (ctx) => {
  const f = path.join(ctx.state, 'cursor.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).cursor : null;
};
const logText = (ctx) => {
  const f = path.join(ctx.state, 'watchdog.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};
const ageWake = (ctx, minutes) =>
  fs.writeFileSync(
    path.join(ctx.state, 'wake.json'),
    JSON.stringify({ last_start_at: new Date(Date.now() - minutes * 60000).toISOString(), last_exit: 0 }),
  );
const doneOf = (ctx) => {
  const f = path.join(ctx.state, 'scheduled.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
};

const teamSettings = (adjutant = {}, timezone = 'Asia/Tashkent') => ({
  team: { timezone, language: 'ru', now: '2026-11-04T10:00:00+05:00' },
  settings: { adjutant: { utro_at: '09:00', den_at: '14:00', vecher_at: '19:00', watchdog_interval_minutes: 5, wake_min_interval_minutes: 15, ...adjutant } },
});
// 04:05 UTC = 09:05 в Ташкенте.
const NOW_0905 = { PULT_WATCHDOG_NOW: '2026-11-04T04:05:00Z' };
// 03:00 в Ташкенте: ни одно окно плановых запусков не открыто, часы команды запуску не мешают.
const NOW_NIGHT = { PULT_WATCHDOG_NOW: '2026-11-03T22:00:00Z' };

test('плановый запуск по часам команды: в 09:05 по её поясу сторож сам запускает /utro, один раз за день', async () => {
  const ctx = setup([], { settings: teamSettings() });

  const first = await run(ctx, { env: NOW_0905 });
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(claudeCalls(ctx).map((c) => c.args), [['-p', '/utro']]);
  assert.deepEqual(doneOf(ctx), { utro: '2026-11-04' });
  assert.match(logText(ctx), /Пора по расписанию команды \(пояс Asia\/Tashkent\): \/utro/);

  const second = await run(ctx, { env: NOW_0905 });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(claudeCalls(ctx).length, 1, 'утренний запуск повторился в тот же день');
});

test('свои часы команды: сменили на экране - сторож запускает день вместо утра, Планировщик не трогали', async () => {
  const ctx = setup([], { settings: teamSettings({ utro_at: '07:00', den_at: '08:30', vecher_at: '19:00' }) });

  assert.equal((await run(ctx, { env: NOW_0905 })).code, 0);
  assert.deepEqual(claudeCalls(ctx).map((c) => c.args), [['-p', '/den']]);
});

test('вне окон плановых запусков нет; пояс компьютера не влияет', async () => {
  const ctx = setup([], { settings: teamSettings() });

  // 03:00 в Ташкенте: окна ещё нет.
  const early = await run(ctx, { env: { PULT_WATCHDOG_NOW: '2026-11-03T22:00:00Z', TZ: 'Pacific/Honolulu' } });
  assert.equal(early.code, 0, early.stderr);
  assert.equal(claudeCalls(ctx).length, 0);

  // Тот же компьютер в другом поясе, 09:05 по команде: утро есть.
  const morning = await run(ctx, { env: { ...NOW_0905, TZ: 'Pacific/Honolulu' } });
  assert.equal(morning.code, 0, morning.stderr);
  assert.deepEqual(claudeCalls(ctx).map((c) => c.args), [['-p', '/utro']]);
});

test('пропущенное окно не догоняется: проснулись в 15:00 - запускается день, утро нет', async () => {
  const ctx = setup([], { settings: teamSettings() });

  assert.equal((await run(ctx, { env: { PULT_WATCHDOG_NOW: '2026-11-04T10:00:00Z' } })).code, 0);
  assert.deepEqual(claudeCalls(ctx).map((c) => c.args), [['-p', '/den']]);
  assert.deepEqual(doneOf(ctx), { den: '2026-11-04' });
});

test('нет связи с сервером: плановых запусков по часам нет, кеш настроек их не оживляет', async () => {
  const ctx = setup([], { settings: teamSettings(), exit: 3, stderr: 'нет связи' });

  const r = await run(ctx, { env: NOW_0905 });
  assert.equal(r.code, 0);
  assert.equal(claudeCalls(ctx).length, 0);
  assert.equal(settingsCalls(ctx).length, 0, 'без связи лишний запрос настроек');
});

test('настройки недоступны: часы неизвестны, плановый запуск не выдумывается, лента всё равно читается', async () => {
  const ctx = setup([ev(1, 'item.taken')]); // в сценарии нет settings

  const r = await run(ctx, { env: NOW_0905 });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(claudeCalls(ctx).length, 0);
  assert.equal(cursorOf(ctx), 1, 'лента не прочитана из-за настроек');
  assert.match(logText(ctx), /Настройки команды не получены/);
});

test('настройки держатся в кеше: следующая проверка до срока не ходит на сервер, после срока ходит', async () => {
  const ctx = setup([], { settings: teamSettings() });

  await run(ctx, { env: { PULT_WATCHDOG_NOW: '2026-11-04T02:00:00Z' } });
  await run(ctx, { env: { PULT_WATCHDOG_NOW: '2026-11-04T02:05:00Z' } });
  assert.equal(settingsCalls(ctx).length, 1);

  await run(ctx, { env: { PULT_WATCHDOG_NOW: '2026-11-04T02:10:00Z', PULT_SETTINGS_TTL_MS: '0' } });
  assert.equal(settingsCalls(ctx).length, 2);
});

test('прошлый кеш выручает, когда сервер не отвечает на настройки', async () => {
  const ctx = setup([], { settings: teamSettings() });
  await run(ctx, { env: { PULT_WATCHDOG_NOW: '2026-11-04T02:00:00Z' } });

  scenario(ctx, { events: [] }); // настройки пропали, кеш остался
  const r = await run(ctx, { env: { ...NOW_0905, PULT_SETTINGS_TTL_MS: '0' } });

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(claudeCalls(ctx).map((c) => c.args), [['-p', '/utro']]);
  assert.match(logText(ctx), /беру прошлые/);
});

test('промежуток побудки берётся из настроек команды, а явная переменная его перекрывает', async () => {
  const ctx = setup([ev(1, 'inbox.received')], { settings: teamSettings({ wake_min_interval_minutes: 30 }) });
  fs.mkdirSync(ctx.state, { recursive: true });
  ageWake(ctx, 20); // 20 минут назад: по умолчанию (15) можно, по настройке (30) нельзя

  const waiting = await run(ctx, { env: NOW_NIGHT });
  assert.equal(waiting.code, 0, waiting.stderr);
  assert.equal(claudeCalls(ctx).length, 0, 'промежуток 30 минут из настроек не соблюдён');
  assert.match(logText(ctx), /запускался недавно/);

  const forced = await run(ctx, { env: { ...NOW_NIGHT, PULT_WATCHDOG_MIN_INTERVAL_MS: String(5 * 60 * 1000) } });
  assert.equal(forced.code, 0, forced.stderr);
  assert.deepEqual(claudeCalls(ctx).map((c) => c.args), [['-p', '/razbor', '--model', 'sonnet']]);
});

test('--run и сам сторож не запускают одно и то же дважды за день; --force запускает', async () => {
  const ctx = setup([], { settings: teamSettings() });

  assert.equal((await run(ctx, { env: NOW_0905 })).code, 0);
  assert.equal(claudeCalls(ctx).length, 1);

  const again = await run(ctx, { args: ['--run', 'utro'], env: NOW_0905 });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(claudeCalls(ctx).length, 1, 'задание Планировщика повторило утро');
  assert.match(logText(ctx), /сегодня \(2026-11-04\) уже запускался/);

  const forced = await run(ctx, { args: ['--run', 'utro', '--force'], env: NOW_0905 });
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(claudeCalls(ctx).length, 2);

  const watch = await run(ctx, { env: NOW_0905 });
  assert.equal(watch.code, 0);
  assert.equal(claudeCalls(ctx).length, 2, 'после ручного запуска сторож повторил утро');
});

test('--run раньше сторожа: сторож в тот же день утро не повторяет', async () => {
  const ctx = setup([], { settings: teamSettings() });

  assert.equal((await run(ctx, { args: ['--run', 'utro'], env: NOW_0905 })).code, 0);
  assert.equal(claudeCalls(ctx).length, 1);
  assert.equal((await run(ctx, { env: NOW_0905 })).code, 0);
  assert.equal(claudeCalls(ctx).length, 1);
});

test('сбойный плановый запуск не повторяется каждые 5 минут', async () => {
  const ctx = setup([], { settings: teamSettings() });

  const failed = await run(ctx, { env: { ...NOW_0905, FAKE_CLAUDE_EXIT: '1' } });
  assert.equal(failed.code, 1);
  assert.equal(claudeCalls(ctx).length, 1);

  const next = await run(ctx, { env: NOW_0905 });
  assert.equal(next.code, 0, next.stderr);
  assert.equal(claudeCalls(ctx).length, 1, 'сбой повторился в тот же день');
});

test('интервал сторожа в Планировщике устарел относительно настроек: одно предупреждение', async () => {
  const ctx = setup([], { settings: teamSettings({ watchdog_interval_minutes: 10 }) });
  fs.mkdirSync(ctx.state, { recursive: true });
  fs.writeFileSync(path.join(ctx.state, 'schedule.json'), JSON.stringify({ watchdog_interval_minutes: 5 }));

  await run(ctx, { env: { PULT_WATCHDOG_NOW: '2026-11-04T02:00:00Z' } });
  await run(ctx, { env: { PULT_WATCHDOG_NOW: '2026-11-04T02:05:00Z' } });

  const warnings = logText(ctx).split('\n').filter((l) => /Интервал сторожа в настройках команды 10 мин, а в Планировщике 5/.test(l));
  assert.equal(warnings.length, 1, logText(ctx));
});

test('испорченный ответ сервера не запускает адъютанта', async () => {
  const ctx = setup([], { settings: { ...teamSettings(), team: { timezone: 'Asia/Tashkent; rm -rf', language: 'ru' } } });

  const r = await run(ctx, { env: NOW_0905 });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(claudeCalls(ctx).length, 0, 'ответ с неверным поясом запустил адъютанта');
});

/* Слои пульса: сторож сам запускает /nedelya и /mesyac после сегодняшнего /vecher. */

const withDone = (ctx, done) => {
  fs.mkdirSync(ctx.state, { recursive: true });
  fs.writeFileSync(path.join(ctx.state, 'scheduled.json'), JSON.stringify(done));
};
const layerSettings = (adjutant = {}) => {
  const s = teamSettings({ nedelya_day: '5', nedelya_at: '19:30', mesyac_at: '19:30', ...adjutant });
  s.team.workdays = [1, 2, 3, 4, 5];
  return s;
};
// 14:40 UTC = 19:40 в Ташкенте. 2026-11-06 - пятница; 2026-10-30 - пятница и последний рабочий день октября.
const FRI = { PULT_WATCHDOG_NOW: '2026-11-06T14:40:00Z' };
const MONTH_END = { PULT_WATCHDOG_NOW: '2026-10-30T14:40:00Z' };

test('в пятницу после вечернего запуска сторож сам запускает /nedelya, один раз', async () => {
  const ctx = setup([], { settings: layerSettings() });
  withDone(ctx, { vecher: '2026-11-06' });

  const first = await run(ctx, { env: FRI });
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(claudeCalls(ctx).map((c) => c.args), [['-p', '/nedelya']]);
  assert.deepEqual(doneOf(ctx), { vecher: '2026-11-06', nedelya: '2026-11-06' });
  assert.match(logText(ctx), /Пора по расписанию команды \(пояс Asia\/Tashkent\): \/nedelya/);

  // Месяц ещё не кончился, недели уже были: второй запуск ничего не делает.
  assert.equal((await run(ctx, { env: FRI })).code, 0);
  assert.equal(claudeCalls(ctx).length, 1, 'слой недели запустился дважды');
});

test('вечерний запуск не состоялся: сначала /vecher, и только потом слой недели', async () => {
  const ctx = setup([], { settings: layerSettings() });

  assert.equal((await run(ctx, { env: FRI })).code, 0);
  assert.deepEqual(claudeCalls(ctx).map((c) => c.args), [['-p', '/vecher']]);
});

test('в последний рабочий день месяца: сперва /nedelya, затем /mesyac; в обычную пятницу месяца нет', async () => {
  const ctx = setup([], { settings: layerSettings() });
  withDone(ctx, { vecher: '2026-10-30' });

  assert.equal((await run(ctx, { env: MONTH_END })).code, 0);
  assert.equal((await run(ctx, { env: MONTH_END })).code, 0);
  assert.equal((await run(ctx, { env: MONTH_END })).code, 0);
  assert.deepEqual(claudeCalls(ctx).map((c) => c.args), [['-p', '/nedelya'], ['-p', '/mesyac']]);
  assert.deepEqual(doneOf(ctx), { vecher: '2026-10-30', nedelya: '2026-10-30', mesyac: '2026-10-30' });

  const plain = setup([], { settings: layerSettings() });
  withDone(plain, { vecher: '2026-11-06', nedelya: '2026-11-06' });
  assert.equal((await run(plain, { env: FRI })).code, 0);
  assert.equal(claudeCalls(plain).length, 0, 'месяц не кончился, а слой месяца запустился');
});

test('слои вручную: --run nedelya и --run mesyac; незнакомое имя - отказ', async () => {
  const ctx = setup([], { settings: layerSettings() });

  assert.equal((await run(ctx, { args: ['--run', 'nedelya'], env: FRI })).code, 0);
  assert.equal((await run(ctx, { args: ['--run', 'mesyac'], env: FRI })).code, 0);
  assert.deepEqual(claudeCalls(ctx).map((c) => c.args), [['-p', '/nedelya'], ['-p', '/mesyac']]);

  const bad = await run(ctx, { args: ['--run', 'god'], env: FRI });
  assert.equal(bad.code, 2);
  assert.match(logText(ctx), /Допустимо: utro, den, vecher, nedelya, mesyac/);
});
