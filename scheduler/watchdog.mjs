#!/usr/bin/env node
// Сторож адъютанта. Без LLM и без зависимостей, Node 20+.
//
//   node watchdog.mjs              разовая проверка ленты событий (Планировщик зовёт раз в 5 минут)
//   node watchdog.mjs --run utro   плановый запуск адъютанта: utro, den, vecher, nedelya или mesyac (--force - даже если сегодня уже был)
//
// Плановые запуски сторож делает сам, по часам из настроек команды: утро, день и вечер в поясе команды. Сменили
// часы на экране сервера - Планировщик трогать не нужно. Окно запуска открывается в его час и закрывается в час
// следующего; пропущенное (компьютер был выключен) не догоняется. Слои пульса: /nedelya в день недели из настроек и
// /mesyac в последний рабочий день месяца - не раньше своего часа и только после сегодняшнего /vecher (в нём пишется
// слой дня); неделя раньше месяца. Пропущенные слои адъютант дописывает при первом запуске (`pult digest missing`).
// Задания Планировщика `--run` остались для ручного запуска и для установок старого вида: общий учёт «сегодня уже
// было» не даёт им сработать дважды.
//
// Роль адъютанта и его команды (.pult-role.md, .claude/commands/) лежат НЕ в git набора, а на сервере: их ставит
// `pult kit pull`. Перед каждым запуском адъютанта сторож сверяет `pult kit hash` с хешем установленного набора (kit.json
// в каталоге состояния) и при расхождении делает `pult kit pull`: сменили роль на сервере, и адъютант не стартует на старой
// копии. Сбой сверки или перетяжки запуск не роняет: адъютант стартует на том, что есть, а в журнал пишется строка.
//
// Единственное, что сторож делает с ИИ: запускает `claude -p "/razbor"` (или плановую команду). Текст событий
// в запуск не попадает: сторож видит только тип события и номер, а в claude уходит фиксированная команда.
//
// Переменные окружения (кроме тестов трогать не нужно):
//   PULT_BIN, PULT_CLAUDE_BIN             чем запускать pult и claude (.js/.mjs идёт через node)
//   PULT_WATCHDOG_DIR                     каталог состояния (курсор, замок, журнал)
//   PULT_WATCHDOG_MIN_INTERVAL_MS         не чаще одного запуска адъютанта за это время; не задано - из настроек команды
//                                         (`pult settings`, wake_min_interval_minutes), при их недоступности 15 минут
//   PULT_SETTINGS_TTL_MS                  как долго держать полученные настройки команды, по умолчанию 10 минут
//   PULT_WATCHDOG_NOW                     только для тестов: считать «сейчас» этим моментом (ISO 8601)
//   PULT_WAKE_TIMEOUT_MS                  предел одного запуска адъютанта, по умолчанию 30 минут
//   PULT_WAKE_COMMAND                     команда разбора, по умолчанию /razbor
//   PULT_WAKE_MODEL                       модель разбора, по умолчанию sonnet
//   PULT_LOCK_WAIT_MS                     сколько плановый запуск ждёт замок, по умолчанию 20 минут
//   PULT_TOKEN                            токен pult: сторож его не читает, только вычищает из своего журнала

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RHYTHM, RITUAL_NAMES, dueRitual, normalizeRhythm, teamClock } from './rhythm.mjs';

const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Таблица: требует ли событие мысли. Что в ней не названо, не будит, но считается и пишется в журнал.
const WAKE_TYPES = new Set(['inbox.received', 'inbox.transcribed', 'item.submitted']);
const QUIET_TYPES = new Set([
  'item.taken',
  'item.released',
  'item.accepted',
  'item.rejected',
  'item.noted',
  'item.claim_expired',
  'outbox.queued',
  'github.commit',
  // Обход проектов (волна 4): отметка «посмотрел» ставится по слову продакта в /obhod, работы адъютанту не даёт.
  'project.reviewed',
  // Сброс привязки Telegram человека: людей уведомляет сам сервер.
  'member.telegram_reset',
  // Циклы (ТЗ этапа 2 §9, §10): продакта о подтверждении «беру» уведомляет сам сервер, будить адъютанта незачем.
  'cycle.confirmed',
  'cycle.approved',
  'cycle.summarized',
  'cycle.closed',
  // Качество сдачи и карта тестирования (волна 3): сценарии, заявка и подтверждение стенда, баги и их причины, карта, проходы.
  // Продакта и людей о них уведомляет сам сервер (кнопка «Проверил сам», экран «Качество»); будить адъютанта незачем.
  'scenario.added',
  'scenario.retired',
  'submission.stand_claimed',
  'submission.stand_confirmed',
  'bug.grew_from',
  'bug.cause_proposed',
  'bug.cause_objected',
  'bug.cause_approved',
  'bug.cause_reset',
  'testmap.imported',
  'item.sections_set',
  'testrun.started',
  'testrun.finished',
  'testrun.bug_filed',
  // Ожидания («ждём чужих») и вопросы продакту (волна 2): напоминает и спрашивает сервер.
  'wait.created',
  'wait.updated',
  'wait.asked',
  'wait.nudged',
  'wait.received',
  'wait.dropped',
  'wait.noted',
  'wait.linked',
  'wait.unlinked',
  'question.asked',
  'question.answered',
  'question.defaulted',
  'question.withdrawn',
  // Регламенты (справочная система): публикует и снимает продакт в вебе, предложения читает он же; адъютанта не будят.
  'handbook.published',
  'handbook.retired',
  'handbook.suggested',
  // Смена настройки команды (экран или `pult settings set`): след для продакта, мысли не требует.
  'settings.changed',
  // Репозиторий закреплён за проектом или откреплён (`pult project repo add|remove`): след, мысли не требует.
  'repo.linked',
  'repo.unlinked',
]);
// Входящие и расшифровки будят, только если за ними свой человек команды (`member`). Событие без человека — это
// незнакомец, написавший боту (старые серверы писали такие события): писать боту может кто угодно, и будить из-за
// этого адъютанта, то есть расходовать подписку продакта и давать чужому тексту канал в разбор, нельзя.
const OWN_MEMBER_TYPES = new Set(['inbox.received', 'inbox.transcribed']);
const classify = (event) => {
  const type = event.type;
  if (OWN_MEMBER_TYPES.has(type) && !event.member) return 'quiet';
  return WAKE_TYPES.has(type) ? 'wake' : QUIET_TYPES.has(type) ? 'quiet' : 'unknown';
};

const SCHEDULED = new Set(RITUAL_NAMES);
const MAX_PAGES = 50;
const LOG_LIMIT_BYTES = 1024 * 1024;

// «Сейчас» для решений по часам команды. Переменная нужна только тестам.
const nowMs = () => {
  const t = Date.parse(process.env.PULT_WATCHDOG_NOW ?? '');
  return Number.isFinite(t) ? t : Date.now();
};

const intEnv = (name, fallback) => {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const cfg = {
  stateDir:
    process.env.PULT_WATCHDOG_DIR ||
    (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'pult-kit', 'watchdog')
      : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'pult-kit', 'watchdog')),
  // null - не задан: промежуток берётся из настроек команды.
  minIntervalOverrideMs: process.env.PULT_WATCHDOG_MIN_INTERVAL_MS === undefined || process.env.PULT_WATCHDOG_MIN_INTERVAL_MS === '' ? null : intEnv('PULT_WATCHDOG_MIN_INTERVAL_MS', DEFAULT_RHYTHM.wake_min_interval_minutes * 60 * 1000),
  settingsTtlMs: intEnv('PULT_SETTINGS_TTL_MS', 10 * 60 * 1000),
  wakeTimeoutMs: intEnv('PULT_WAKE_TIMEOUT_MS', 30 * 60 * 1000),
  lockWaitMs: intEnv('PULT_LOCK_WAIT_MS', 20 * 60 * 1000),
  pultTimeoutMs: 60 * 1000,
  wakeCommand: process.env.PULT_WAKE_COMMAND || '/razbor',
  wakeModel: process.env.PULT_WAKE_MODEL || 'sonnet',
};

const files = {
  cursor: path.join(cfg.stateDir, 'cursor.json'),
  wake: path.join(cfg.stateDir, 'wake.json'),
  stats: path.join(cfg.stateDir, 'stats.json'),
  rhythm: path.join(cfg.stateDir, 'rhythm.json'),
  kit: path.join(cfg.stateDir, 'kit.json'),
  scheduled: path.join(cfg.stateDir, 'scheduled.json'),
  applied: path.join(cfg.stateDir, 'schedule.json'),
  lock: path.join(cfg.stateDir, 'watchdog.lock'),
  log: path.join(cfg.stateDir, 'watchdog.log'),
};

// --- журнал ---------------------------------------------------------------------------------

const redact = (text) => {
  let out = String(text);
  const token = process.env.PULT_TOKEN;
  if (token && token.length >= 4) out = out.split(token).join('***');
  return out;
};

// Типы событий и тексты ошибок приходят снаружи: в журнал только безопасные знаки и ограниченной длины.
const clean = (s, max = 64) => String(s).replace(/[^\p{L}\p{N}\p{P}\p{Zs}]/gu, '?').slice(0, max);

function log(level, message) {
  const line = `${new Date().toISOString()} ${level} ${redact(message)}`;

  try {
    fs.mkdirSync(cfg.stateDir, { recursive: true });
    if (fs.existsSync(files.log) && fs.statSync(files.log).size > LOG_LIMIT_BYTES) {
      fs.renameSync(files.log, `${files.log}.1`);
    }
    fs.appendFileSync(files.log, `${line}\n`);
  } catch {
    // журнал не должен валить сторожа; строка всё равно уйдёт в вывод
  }

  (level === 'INFO' ? process.stdout : process.stderr).write(`${line}\n`);
}

// --- состояние ------------------------------------------------------------------------------

class StateError extends Error {}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');

  try {
    fs.writeSync(fd, JSON.stringify(data));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(tmp, file);
}

function readJson(file) {
  let text;

  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }

  return JSON.parse(text.replace(/^﻿/, ''));
}

/** Нет файла: чтение с начала ленты. Файл есть, но не разбирается: ошибка, а не молчаливый пропуск истории. */
function loadCursor() {
  let data;

  try {
    data = readJson(files.cursor);
  } catch (e) {
    throw new StateError(
      `Файл курсора повреждён и не прочитан: ${files.cursor} (${clean(e.message, 120)}). ` +
        'Починить: вписать {"cursor": N} с номером последнего обработанного события, либо удалить файл — тогда ' +
        'лента читается с самого начала.',
    );
  }

  if (data === null) return null;

  if (typeof data !== 'object' || !Number.isSafeInteger(data.cursor) || data.cursor < 0) {
    throw new StateError(
      `В файле курсора нет целого неотрицательного поля «cursor»: ${files.cursor}. Курсор не тронут, ничего не пропущено.`,
    );
  }

  return data.cursor;
}

const saveCursor = (cursor) => atomicWrite(files.cursor, { cursor, updated_at: new Date().toISOString() });

function lastWakeStart() {
  try {
    const data = readJson(files.wake);
    const t = data === null ? null : Date.parse(data.last_start_at);
    if (t === null) return null;
    if (Number.isFinite(t)) return t;
  } catch {
    // ниже
  }

  // Повреждённый файл: считаем, что запуск только что был. Ошибиться в сторону «не будить» дешевле, чем жечь подписку.
  log('WARN', `Файл ${files.wake} не разобран: считаю, что запуск адъютанта был только что.`);
  markWakeStart(null);
  return Date.now();
}

const markWakeStart = (exitCode) =>
  atomicWrite(files.wake, { last_start_at: new Date().toISOString(), last_exit: exitCode });

function addStats(counts) {
  let stats = { types: {}, updated_at: null };

  try {
    const data = readJson(files.stats);
    if (data && typeof data.types === 'object' && data.types !== null) stats = data;
  } catch {
    log('WARN', `Файл ${files.stats} не разобран, счётчики начаты заново.`);
  }

  for (const [type, n] of Object.entries(counts)) stats.types[type] = (stats.types[type] ?? 0) + n;
  stats.updated_at = new Date().toISOString();
  atomicWrite(files.stats, stats);
}

// --- настройки команды ------------------------------------------------------------------------

let rhythmOnce;

/** Ритм из `pult settings`: из кеша, пока он свежий; иначе с сервера; недоступен - прошлый кеш, а без него null. */
function getRhythm() {
  rhythmOnce ??= loadRhythm();
  return rhythmOnce;
}

async function loadRhythm() {
  let cached = null;

  try {
    cached = readJson(files.rhythm);
  } catch {
    cached = null;
  }

  const age = cached ? Date.now() - Date.parse(cached.fetched_at) : Number.POSITIVE_INFINITY;

  if (cached && age >= 0 && age < cfg.settingsTtlMs) return normalizeRhythm(cached.body);

  const res = await runPult(['settings', '--section', 'adjutant', '--json']);
  let body = null;

  if (res.code === 0) {
    try {
      body = JSON.parse(res.stdout.replace(/^\uFEFF/, ''));
    } catch {
      body = null;
    }
  }

  const rhythm = normalizeRhythm(body);

  if (rhythm) {
    // В кеш только нужное: пояс и раздел адъютанта. Тексты людям и прочее сторожу ни к чему.
    atomicWrite(files.rhythm, { fetched_at: new Date().toISOString(), body: { team: body.team, settings: { adjutant: body.settings.adjutant } } });
    return rhythm;
  }

  const why = res.code === 0 ? 'ответ не похож на настройки' : `код выхода ${res.code ?? 'нет'}`;
  log('WARN', `Настройки команды не получены (${why}): ${cached ? 'беру прошлые' : 'часы плановых запусков неизвестны, промежуток побудки по умолчанию'}.`);

  return cached ? normalizeRhythm(cached.body) : null;
}

async function minIntervalMs() {
  if (cfg.minIntervalOverrideMs !== null) return cfg.minIntervalOverrideMs;

  return ((await getRhythm())?.wake_min_interval_minutes ?? DEFAULT_RHYTHM.wake_min_interval_minutes) * 60 * 1000;
}

/** Даты последних плановых запусков по именам: `{"utro": "2026-11-04"}`. Повреждённый файл - пустой учёт. */
function readDone() {
  try {
    const data = readJson(files.scheduled);
    return data && typeof data === 'object' ? data : {};
  } catch {
    log('WARN', `Файл ${files.scheduled} не разобран, учёт плановых запусков начат заново.`);
    return {};
  }
}

const markDone = (name, date) => atomicWrite(files.scheduled, { ...readDone(), [name]: date });

const localDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Интервал сторожа в Планировщике остался от установки: если команда его поменяла, сторож сам этого не исправит.
 * Говорим один раз на пару значений.
 */
function warnIfIntervalDrift(rhythm) {
  let applied = null;

  try {
    applied = readJson(files.applied);
  } catch {
    return;
  }

  const set = applied?.watchdog_interval_minutes;
  if (!Number.isInteger(set) || set === rhythm.watchdog_interval_minutes) return;

  const key = `${set}->${rhythm.watchdog_interval_minutes}`;
  let cache = null;

  try {
    cache = readJson(files.rhythm);
  } catch {
    return;
  }

  if (!cache || cache.drift_warned === key) return;

  log('WARN', `Интервал сторожа в настройках команды ${rhythm.watchdog_interval_minutes} мин, а в Планировщике ${set}. Обновить: powershell -File scheduler\\install-windows.ps1`);
  atomicWrite(files.rhythm, { ...cache, drift_warned: key });
}

// --- замок ----------------------------------------------------------------------------------

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function lockIsLive() {
  let text;

  try {
    text = fs.readFileSync(files.lock, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }

  try {
    return isAlive(JSON.parse(text).pid);
  } catch {
    // Пустой или битый замок: свежий считаем занятым (его пишут прямо сейчас), старый снимаем.
    return Date.now() - fs.statSync(files.lock).mtimeMs < 60 * 1000;
  }
}

function tryAcquireLock() {
  fs.mkdirSync(cfg.stateDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(files.lock, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }

    if (lockIsLive()) return false;

    log('WARN', 'Замок остался от мёртвого процесса, снимаю.');
    try {
      fs.unlinkSync(files.lock);
    } catch {
      // другой сторож успел снять раньше: следующая попытка разберётся
    }
  }

  return false;
}

function releaseLock() {
  try {
    if (JSON.parse(fs.readFileSync(files.lock, 'utf8')).pid === process.pid) fs.unlinkSync(files.lock);
  } catch {
    // замка нет или он чужой: нечего снимать
  }
}

// --- запуск программ ------------------------------------------------------------------------

const SAFE_ARG = /^[\p{L}\p{N}_./:=-]+$/u;

function command(envName, defaultName, args) {
  const bin = process.env[envName];

  if (bin && /\.(c|m)?js$/i.test(bin)) return { file: process.execPath, args: [bin, ...args], shell: false };

  // На Windows pult и claude — это .cmd или .exe из PATH: без оболочки их по имени не найти.
  // Аргументы фиксированные, но в командную строку идут целиком, поэтому проверяем.
  if (process.platform === 'win32' && !(bin && /\.exe$/i.test(bin))) {
    for (const a of args) if (!SAFE_ARG.test(a)) throw new Error(`Недопустимый аргумент команды: ${clean(a)}`);
    const name = bin ? `"${bin}"` : defaultName;
    return { file: `${name} ${args.join(' ')}`, args: [], shell: true };
  }

  return { file: bin || defaultName, args, shell: false };
}

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // процесс уже ушёл
  }
}

function run(spec, { cwd, timeoutMs, keepStdout }) {
  return new Promise((resolve) => {
    let child;

    try {
      child = spawn(spec.file, spec.args, {
        cwd,
        shell: spec.shell,
        windowsHide: true,
        stdio: ['ignore', keepStdout ? 'pipe' : 'ignore', 'pipe'],
      });
    } catch (e) {
      resolve({ code: null, error: e.message, stdout: '', stderr: '' });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, ...result });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.stdout?.on('data', (d) => {
      if (stdout.length < 8 * 1024 * 1024) stdout += d;
    });
    child.stderr?.on('data', (d) => {
      stderr = (stderr + d).slice(-2000);
    });
    child.on('error', (e) => finish({ code: null, error: e.message }));
    child.on('close', (code) => finish({ code }));
  });
}

const runPult = (args) =>
  run(command('PULT_BIN', 'pult', args), { cwd: KIT_DIR, timeoutMs: cfg.pultTimeoutMs, keepStdout: true });

// Разбор входящих идёт часто и не требует сильной модели; плановые запуски остаются на модели по умолчанию.
const runClaude = (slash) =>
  run(
    command('PULT_CLAUDE_BIN', 'claude', slash === cfg.wakeCommand ? ['-p', slash, '--model', cfg.wakeModel] : ['-p', slash]),
    {
      cwd: KIT_DIR,
      timeoutMs: cfg.wakeTimeoutMs,
      // claude пишет ошибки API в stdout. Вывод читается только при сбое: удачная работа в журнал не идёт.
      keepStdout: true,
    },
  );

// --- набор адъютанта с сервера ------------------------------------------------------------------

let kitOnce;

/** Хеш набора, который сторож поставил в прошлый раз, или null. */
function installedKitHash() {
  try {
    const data = readJson(files.kit);
    return typeof data?.hash === 'string' ? data.hash : null;
  } catch {
    return null;
  }
}

/**
 * Сверка набора с сервером: `pult kit hash` против установленного; расходятся - `pult kit pull` в каталог набора.
 * Не бросает и не меняет код выхода сторожа: что бы ни случилось, адъютант стартует на том, что лежит на диске.
 */
async function reallySyncKit() {
  try {
    const res = await runPult(['kit', 'hash', '--json']);

    if (res.code !== 0) {
      const why = res.code === 3 ? 'нет связи с сервером' : res.code === 5 ? 'у токена нет права на набор адъютанта' : `код выхода ${res.code ?? 'нет'}${res.timedOut ? ', таймаут' : ''}`;
      log(res.code === 3 ? 'INFO' : 'WARN', `Сверка набора адъютанта не удалась (${why}): запуск на том, что есть.`);
      return;
    }

    let hash = null;

    try {
      hash = JSON.parse(res.stdout.replace(/^﻿/, '')).hash;
    } catch {
      hash = null;
    }

    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      log('WARN', 'Сверка набора адъютанта: pult kit hash вернул не хеш. Запуск на том, что есть.');
      return;
    }

    if (installedKitHash() === hash) return;

    // Без --dir: утилита пишет в текущий каталог, а runPult запускает её из KIT_DIR. Путь аргументом не годится: на Windows pult - это
    // .cmd-обёртка, и SAFE_ARG не пропускает обратную косую и пробелы.
    const pull = await runPult(['kit', 'pull', '--json']);

    if (pull.code !== 0) {
      const last = clean(pull.stderr.trim().split('\n').pop() ?? '', 200);
      log('WARN', `Набор на сервере изменился (${hash.slice(0, 12)}…), но pult kit pull не удался (код ${pull.code ?? 'нет'}${pull.timedOut ? ', таймаут' : ''}): ${last} Запуск на том, что есть.`);
      return;
    }

    let pulled = hash;

    try {
      const body = JSON.parse(pull.stdout.replace(/^﻿/, ''));
      if (typeof body.hash === 'string' && /^[0-9a-f]{64}$/.test(body.hash)) pulled = body.hash;
    } catch {
      // файлы записаны; хеш берём из сверки выше
    }

    atomicWrite(files.kit, { hash: pulled, pulled_at: new Date().toISOString() });
    log('INFO', `Набор адъютанта обновлён с сервера: хеш ${pulled.slice(0, 12)}…`);
  } catch (e) {
    log('WARN', `Сверка набора адъютанта сорвалась: ${clean(e.message, 160)}. Запуск на том, что есть.`);
  }
}

/** Один раз за запуск сторожа: все пути запуска адъютанта получают один и тот же результат. */
function syncKit() {
  kitOnce ??= reallySyncKit();
  return kitOnce;
}

async function assertCommandExists(slash) {
  const name = slash.replace(/^\//, '');
  const file = () => path.join(KIT_DIR, '.claude', 'commands', `${name}.md`);
  const valid = /^[\p{L}\p{N}_-]+$/u.test(name);

  // Команд в git набора нет: их кладёт `pult kit pull`. Набор только что склонирован или команды стёрты - сначала тянем с сервера.
  if (valid && !fs.existsSync(file())) await syncKit();

  if (!valid || !fs.existsSync(file())) {
    throw new StateError(`Команды ${clean(slash)} нет в .claude/commands/: адъютанта не за чем будить. Набор ставит \`pult kit pull\` (нужны утилита и токен продакта или адъютанта).`);
  }
}

// --- запуск адъютанта -----------------------------------------------------------------------

async function wakeAdjutant(slash) {
  await syncKit();
  markWakeStart(null);
  const started = Date.now();
  const res = await runClaude(slash);
  const seconds = Math.round((Date.now() - started) / 1000);

  if (res.code === 0 && !res.timedOut) {
    log('INFO', `Адъютант отработал: ${clean(slash)}, ${seconds} с.`);
    markWakeStart(0);
    return true;
  }

  const why = res.timedOut ? 'не уложился во время и остановлен' : res.error ? clean(res.error, 120) : `код выхода ${res.code}`;
  const detail = res.stderr.trim().split('\n').pop() || res.stdout.trim().split('\n').pop() || '';
  log('ERROR', `Запуск адъютанта ${clean(slash)} не удался: ${why}. ${clean(detail, 200)}`);
  markWakeStart(res.code ?? -1);
  return false;
}

// --- проверка ленты -------------------------------------------------------------------------

function parseEvents(res, since) {
  let body;

  try {
    body = JSON.parse(res.stdout.replace(/^﻿/, ''));
  } catch {
    return { error: 'pult events вернул не JSON' };
  }

  const ok =
    body &&
    Array.isArray(body.events) &&
    Number.isSafeInteger(body.cursor) &&
    body.cursor >= since &&
    body.events.every((e) => e && Number.isSafeInteger(e.id) && e.id > since && typeof e.type === 'string');

  return ok ? { body } : { error: 'ответ pult events не похож на ленту событий' };
}

function countTypes(events) {
  const counts = {};
  const unknown = {};

  for (const e of events) {
    const type = clean(e.type);
    counts[type] = (counts[type] ?? 0) + 1;
    if (classify(e) === 'unknown') unknown[type] = (unknown[type] ?? 0) + 1;
  }

  return { counts, unknown };
}

function noteConsumed(events) {
  if (events.length === 0) return;
  const { counts, unknown } = countTypes(events);

  addStats(counts);
  const quiet = Object.entries(counts).map(([t, n]) => `${clean(t)}=${n}`).join(' ');
  log('INFO', `Прочитано событий: ${quiet}`);

  for (const [type, n] of Object.entries(unknown)) {
    log('WARN', `Неизвестный тип события «${type}» (${n}): не будит, добавьте его в таблицу сторожа, если должен.`);
  }
}

async function watch() {
  const code = await watchEvents();

  // Нет связи с сервером или нет прав: настроек не получить, а запуск адъютанта без сервера ничего не сделает.
  if (!serverReachable || code === 2 || code === 4 || code === 5) return code;

  const scheduled = await maybeRunScheduled();

  return code !== 0 ? code : scheduled;
}

let serverReachable = true;

async function watchEvents() {
  let since;

  try {
    since = loadCursor() ?? 0;
    await assertCommandExists(cfg.wakeCommand);
  } catch (e) {
    if (!(e instanceof StateError)) throw e;
    log('ERROR', e.message);
    return 2;
  }

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await runPult(['events', '--since', String(since), '--json']);

    if (res.code === 3) {
      log('INFO', 'Нет связи с сервером, жду следующего раза.');
      serverReachable = false;
      return 0;
    }

    if (res.code === 4 || res.code === 5) {
      log('ERROR', `pult events отказал с кодом ${res.code}: ${res.code === 4 ? 'токен не принят или его нет' : 'нет прав'}. Адъютант не будится.`);
      return res.code;
    }

    if (res.code !== 0) {
      const why = res.error ? clean(res.error, 120) : `код выхода ${res.code}${res.timedOut ? ', таймаут' : ''}`;
      log('ERROR', `pult events не удался: ${why}. ${clean(res.stderr.trim().split('\n').pop() ?? '', 200)}`);
      return res.code === null ? 2 : 1;
    }

    const parsed = parseEvents(res, since);

    if (parsed.error) {
      log('ERROR', `${parsed.error}. Курсор не тронут.`);
      return 1;
    }

    const { events, cursor, has_more: hasMore } = parsed.body;
    const firstWake = events.findIndex((e) => classify(e) === 'wake');

    if (firstWake === -1) {
      noteConsumed(events);
      if (cursor !== since) saveCursor(cursor);
      since = cursor;
      if (!hasMore) return 0;
      continue;
    }

    // Всё до первого будящего события — решение не будить, его можно считать прочитанным в любом случае.
    const before = events.slice(0, firstWake);
    const beforeCursor = firstWake > 0 ? events[firstWake - 1].id : since;
    const lastStart = lastWakeStart();
    const waitMs = lastStart === null ? 0 : lastStart + (await minIntervalMs()) - Date.now();

    if (waitMs > 0) {
      noteConsumed(before);
      if (beforeCursor !== since) saveCursor(beforeCursor);
      log('INFO', `Есть что разобрать (событие #${events[firstWake].id}), но адъютант запускался недавно: жду ещё ~${Math.ceil(waitMs / 60000)} мин.`);
      return 0;
    }

    const woke = await wakeAdjutant(cfg.wakeCommand);

    if (!woke) {
      noteConsumed(before);
      if (beforeCursor !== since) saveCursor(beforeCursor);
      return 1;
    }

    noteConsumed(events);
    saveCursor(cursor);
    // Остальные страницы — следующему разу: адъютант прочитал входящие на момент запуска, а позже пришедшее
    // получит свой запуск не раньше, чем позволит интервал.
    return 0;
  }

  log('WARN', `Лента длиннее ${MAX_PAGES} страниц за один проход: остаток читается в следующий раз.`);
  return 0;
}

// --- плановый запуск ------------------------------------------------------------------------

/** Пора ли по часам команды запустить /utro, /den, /vecher, /nedelya или /mesyac; если да, запускает. Зовётся под замком сторожа. */
async function maybeRunScheduled() {
  const rhythm = await getRhythm();

  if (!rhythm) return 0;

  warnIfIntervalDrift(rhythm);

  const name = dueRitual(rhythm, readDone(), nowMs());

  if (name === null) return 0;

  try {
    await assertCommandExists(`/${name}`);
  } catch (e) {
    log('ERROR', e.message);
    return 2;
  }

  // Отметка до запуска: сбойный запуск не должен повторяться каждые 5 минут (так же устроен и разбор по событию).
  markDone(name, teamClock(nowMs(), rhythm.timezone).date);
  log('INFO', `Пора по расписанию команды (пояс ${rhythm.timezone}): /${name}.`);

  return (await wakeAdjutant(`/${name}`)) ? 0 : 1;
}

async function runScheduled(name, force = false) {
  if (!SCHEDULED.has(name)) {
    log('ERROR', `Плановая команда «${clean(name)}» неизвестна. Допустимо: ${[...SCHEDULED].join(', ')}.`);
    return 2;
  }

  try {
    await assertCommandExists(`/${name}`);
  } catch (e) {
    log('ERROR', e.message);
    return 2;
  }

  const deadline = Date.now() + cfg.lockWaitMs;

  while (!tryAcquireLock()) {
    if (Date.now() > deadline) {
      log('ERROR', `Плановый запуск /${name} пропущен: адъютант всё ещё занят предыдущим запуском.`);
      return 1;
    }

    await new Promise((r) => setTimeout(r, Math.min(5000, Math.max(50, cfg.lockWaitMs / 10))));
  }

  try {
    // Один учёт на два пути запуска (Планировщик и сам сторож): второй за день не запускает, если не --force.
    const rhythm = await getRhythm();
    const date = rhythm ? teamClock(nowMs(), rhythm.timezone).date : localDate(nowMs());

    if (!force && readDone()[name] === date) {
      log('INFO', `/${name} сегодня (${date}) уже запускался: пропускаю. Запустить снова: --run ${name} --force.`);
      return 0;
    }

    markDone(name, date);

    return (await wakeAdjutant(`/${name}`)) ? 0 : 1;
  } finally {
    releaseLock();
  }
}

// --- вход -----------------------------------------------------------------------------------

async function main(argv) {
  const runIdx = argv.indexOf('--run');
  const force = argv.includes('--force');

  if (runIdx !== -1 && argv.every((a, i) => i === runIdx || i === runIdx + 1 || a === '--force')) {
    return runScheduled(argv[runIdx + 1] ?? '', force);
  }

  if (argv.length > 0) {
    log('ERROR', `Неизвестные аргументы. Использование: watchdog.mjs [--run ${RITUAL_NAMES.join('|')} [--force]]`);
    return 2;
  }

  if (!tryAcquireLock()) {
    log('INFO', 'Предыдущий запуск ещё идёт (замок занят живым процессом), пропускаю.');
    return 0;
  }

  try {
    return await watch();
  } finally {
    releaseLock();
  }
}

process.exitCode = await main(process.argv.slice(2)).catch((e) => {
  log('ERROR', `Сторож упал: ${clean(e.stack ?? e.message, 400)}`);
  return 1;
});
