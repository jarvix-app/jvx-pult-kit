#!/usr/bin/env node
// Ставит файл роли по роли токена этой машины. Node 20+, без зависимостей.
//
//   node scripts/install.mjs [--target <каталог>] [--force] [--dry-run]
//
// Роль берётся из `pult whoami --json`, то есть от сервера, а не из аргументов: токен member никогда не получит
// инструкций адъютанта. Роль, которой нет в таблице, и любая ошибка whoami — отказ, ничего не записано.
//
// Роль и команды сотрудника лежат в этом наборе (roles/member-agent.md), роль и команды адъютанта — НЕТ: их отдаёт сервер
// только продакту и адъютанту. Для адъютанта и продакта установщик зовёт `pult kit pull --dir <каталог>`: тот пишет
// `.pult-role.md` и `.claude/commands/*.md` (с меткой «поставлено набором с сервера» у каждой команды). Сотрудник
// получает файл своей роли из набора, и сервер ему адъютантского не отдаст, даже если попросить.
//
// Без --target всё кладётся в сам набор (.pult-role.md; команды адъютанта — в .claude/commands/ набора, их читает сторож).
// С --target набор ставится в каталог проекта: AGENTS.md, CLAUDE.md и файл роли; для адъютанта и продакта ещё команды
// .claude/commands и .claude/settings.json (разрешения запусков, не директивы).
//
// Если у проекта УЖЕ есть свой CLAUDE.md или AGENTS.md, установщик их не трогает никогда (и с --force тоже): правила
// набора кладутся рядом в .pult-rules.md, а подключает их блок в CLAUDE.local.md (Claude Code читает его вместе с
// CLAUDE.md проекта). Файлы набора дописываются в .git/info/exclude проекта, чтобы не уехать в его репозиторий.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Какой токен что получает. `server: true` — роль и команды с сервера (`pult kit pull`), иначе файл из этого набора.
const ROLES = {
  member: { file: 'member-agent.md', marker: 'member', server: false },
  adjutant: { server: true },
  product: { server: true },
};

const fail = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

function parseArgs(argv) {
  const opts = { target: KIT, force: false, dryRun: false };

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--force') opts.force = true;
    else if (argv[i] === '--dry-run') opts.dryRun = true;
    else if (argv[i] === '--target' && argv[i + 1]) opts.target = path.resolve(argv[(i += 1)]);
    else fail('Использование: node scripts/install.mjs [--target <каталог>] [--force] [--dry-run]', 2);
  }

  return opts;
}

/** Запуск pult с аргументами: PULT_BIN (.js/.mjs идёт через node), на Windows .cmd-обёртка идёт через оболочку. */
function pult(args) {
  const bin = process.env.PULT_BIN;
  const viaNode = bin && /\.(c|m)?js$/i.test(bin);
  const shell = process.platform === 'win32' && !viaNode && !(bin && /\.exe$/i.test(bin));

  return viaNode
    ? spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })
    : shell
      ? spawnSync(`${bin ? `"${bin}"` : 'pult'} ${args.map((a) => (/[\s"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a)).join(' ')}`, { encoding: 'utf8', shell: true })
      : spawnSync(bin || 'pult', args, { encoding: 'utf8' });
}

function whoami() {
  const res = pult(['whoami', '--json']);

  if (res.error || res.status !== 0) {
    const reason = res.error ? res.error.message : `код выхода ${res.status}`;
    fail(
      `Не удалось определить роль: pult whoami не прошёл (${reason}). Привяжите машину: pult login <токен> --server <адрес>. ` +
        'Ничего не установлено.',
      res.status === 4 ? 4 : 1,
    );
  }

  try {
    return JSON.parse(res.stdout.replace(/^﻿/, ''));
  } catch {
    return fail('pult whoami вернул не JSON. Ничего не установлено.');
  }
}

const RULES_FILE = '.pult-rules.md';
const LOCAL_FILE = 'CLAUDE.local.md';
const BLOCK_START = '<!-- pult-kit: начало. Ставит jvx-pult-kit/scripts/install.mjs; правки внутри блока перезапишутся. -->';
const BLOCK_END = '<!-- pult-kit: конец -->';
// По этим первым строкам установщик узнаёт СВОИ файлы прошлой установки (их можно обновлять); всё остальное — файлы проекта.
const KIT_AGENTS_HEAD = '<!-- Общий текст правил.';
const KIT_CLAUDE_HEAD = '@AGENTS.md';
const KIT_CLAUDE_MARK = '# Особенности Claude Code';

const readIfExists = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const firstLine = (text) => text.replace(/^﻿/, '').split(/\r?\n/, 1)[0].trim();

/** У проекта есть свой CLAUDE.md или AGENTS.md, не поставленный этим набором. */
function hasOwnInstructions(target) {
  const agents = readIfExists(path.join(target, 'AGENTS.md'));
  const claude = readIfExists(path.join(target, 'CLAUDE.md'));

  if (agents === null && claude === null) return false;

  // «@AGENTS.md» первой строкой пишут и в чужих проектах, поэтому одной строки мало: свои файлы — это ПАРА
  // (AGENTS.md с шапкой набора и CLAUDE.md с шапкой и заголовком набора). Любое сомнение — файлы чужие, не трогаем.
  const kitAgents = agents !== null && firstLine(agents).startsWith(KIT_AGENTS_HEAD);
  const kitClaude = claude === null || (firstLine(claude) === KIT_CLAUDE_HEAD && claude.includes(KIT_CLAUDE_MARK));

  return !(kitAgents && kitClaude);
}

/** CLAUDE.local.md с блоком набора: свой текст человека сохраняется, блок прошлой установки заменяется, а не дублируется. */
function withKitBlock(existing, kitClaude) {
  const body = kitClaude.replace(/^﻿/, '').split(/\r?\n/).slice(1).join('\n').trim();
  // Роль сотрудника ссылается на «общие правила в AGENTS.md»: здесь AGENTS.md — файл проекта, поэтому говорим прямо, где правила набора.
  const note = `Общие правила Пульта, которые роль называет «AGENTS.md», в этом проекте лежат в \`${RULES_FILE}\`. Здешние \`AGENTS.md\` и \`CLAUDE.md\` — правила самого проекта, они действуют как раньше.`;
  const block = `${BLOCK_START}\n@${RULES_FILE}\n\n${note}\n\n${body}\n${BLOCK_END}\n`;

  if (existing === null || existing.trim() === '') return block;

  const from = existing.indexOf(BLOCK_START);
  const to = existing.indexOf(BLOCK_END);

  if (from !== -1 && to > from) {
    return `${existing.slice(0, from)}${block}${existing.slice(to + BLOCK_END.length).replace(/^\r?\n/, '')}`;
  }

  return `${existing.replace(/\s*$/, '')}\n\n${block}`;
}

/** Файлы набора в чужом проекте не должны уехать в его git: дописываем их в локальные исключения (.git/info/exclude). */
function excludeLocally(target, names) {
  const info = path.join(target, '.git', 'info');

  if (!fs.existsSync(path.join(target, '.git')) || !fs.statSync(path.join(target, '.git')).isDirectory()) return false;

  fs.mkdirSync(info, { recursive: true });
  const file = path.join(info, 'exclude');
  const have = readIfExists(file) ?? '';
  const lines = have.split(/\r?\n/).map((l) => l.trim());
  const missing = names.filter((n) => !lines.includes(n) && !lines.includes(`/${n}`));

  if (missing.length > 0) fs.writeFileSync(file, `${have.replace(/\s*$/, '')}${have.trim() === '' ? '' : '\n'}# jvx-pult-kit: файлы набора, в репозиторий проекта не идут\n${missing.join('\n')}\n`);

  return true;
}

/** Файлы, которые копируются из этого набора (роль сотрудника, общие правила, разрешения адъютанта). */
function plan(role, opts) {
  const spec = ROLES[role];
  const items = [];

  if (!spec.server) {
    const src = path.join(KIT, 'roles', spec.file);
    const body = fs.readFileSync(src, 'utf8');

    if (body.split(/\r?\n/, 1)[0].trim() !== `<!-- pult-role: ${spec.marker} -->`) {
      fail(`В ${src} нет метки роли «${spec.marker}»: файл не тот, ничего не установлено.`);
    }

    items.push({ to: path.join(opts.target, '.pult-role.md'), content: body, overwrite: true });
  }

  if (opts.target !== KIT) {
    const kit = { 'AGENTS.md': fs.readFileSync(path.join(KIT, 'AGENTS.md'), 'utf8'), 'CLAUDE.md': fs.readFileSync(path.join(KIT, 'CLAUDE.md'), 'utf8') };

    if (hasOwnInstructions(opts.target)) {
      // У проекта свои CLAUDE.md или AGENTS.md: их не трогаем НИКОГДА, и --force тоже. Правила набора ложатся рядом
      // (.pult-rules.md), а подключает их CLAUDE.local.md: Claude Code читает его вместе с CLAUDE.md проекта.
      items.push({ to: path.join(opts.target, RULES_FILE), content: kit['AGENTS.md'], overwrite: true });
      items.push({ to: path.join(opts.target, LOCAL_FILE), content: withKitBlock(readIfExists(path.join(opts.target, LOCAL_FILE)), kit['CLAUDE.md']), overwrite: true });
      opts.beside = true;
    } else {
      // Проект без своих инструкций (или с файлами прошлой установки набора): ставим и обновляем их целиком.
      for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        items.push({ to: path.join(opts.target, name), content: kit[name], overwrite: true });
      }
    }

    if (spec.server) {
      items.push({
        to: path.join(opts.target, '.claude', 'settings.json'),
        content: fs.readFileSync(path.join(KIT, '.claude', 'settings.json'), 'utf8'),
      });
    }
  }

  return items;
}

const opts = parseArgs(process.argv.slice(2));
const who = whoami();
const role = typeof who?.role === 'string' ? who.role : '';

if (!Object.hasOwn(ROLES, role)) {
  fail(`Роль «${role.slice(0, 40)}» установщику не известна: отказ, ничего не установлено. Известные роли: ${Object.keys(ROLES).join(', ')}.`, 2);
}

if (!fs.existsSync(opts.target) || !fs.statSync(opts.target).isDirectory()) {
  fail(`Каталог ${opts.target} не существует.`, 2);
}

const items = plan(role, opts);
const conflicts = items.filter((i) => !i.overwrite && fs.existsSync(i.to));

if (conflicts.length > 0 && !opts.force) {
  fail(
    `Уже существуют, ничего не записано (перезапись только с --force):\n${conflicts.map((c) => `  ${c.to}`).join('\n')}`,
    2,
  );
}

const name = who.member?.name ? `, ${String(who.member.name).slice(0, 80)}` : '';
process.stdout.write(`Роль: ${role}${name}. ${opts.dryRun ? 'Будет записано' : 'Записано'}:\n`);

// Роль и команды адъютанта — с сервера. Идут первыми: отказ сервера (нет прав, нет связи, набор не сошёлся по хешу) должен
// остановить установку до того, как записан хоть один файл набора.
if (ROLES[role].server) {
  const args = ['kit', 'pull', '--dir', opts.target, ...(opts.force ? ['--force'] : []), ...(opts.dryRun ? ['--dry-run'] : [])];
  const res = pult(args);

  if (res.error || res.status !== 0) {
    const reason = res.error ? res.error.message : `код выхода ${res.status}`;
    fail(
      `Роль и команды адъютанта не получены: pult kit pull не прошёл (${reason}). ${String(res.stderr ?? '').trim().slice(-400)}\n` +
        'Ничего не установлено. Нужна утилита, поддерживающая pult kit pull (обновите её: см. README), и токен продакта или адъютанта.',
      res.status === 4 || res.status === 5 || res.status === 2 ? res.status : 1,
    );
  }

  process.stdout.write(`${String(res.stdout).replace(/^[^\n]*\n/, '')}`);
}

for (const item of items) {
  if (!opts.dryRun) {
    fs.mkdirSync(path.dirname(item.to), { recursive: true });
    fs.writeFileSync(item.to, item.content);
  }

  process.stdout.write(`  ${item.to}\n`);
}

if (opts.beside) {
  const excluded = opts.dryRun ? false : excludeLocally(opts.target, ['.pult-role.md', RULES_FILE, LOCAL_FILE]);

  process.stdout.write(
    `У проекта свои CLAUDE.md или AGENTS.md: они не тронуты. Правила Пульта лежат рядом (${RULES_FILE}), подключает их ${LOCAL_FILE}.\n` +
      (excluded ? 'Файлы набора добавлены в .git/info/exclude: в репозиторий проекта они не попадут.\n' : `Не коммитьте в проект .pult-role.md, ${RULES_FILE} и ${LOCAL_FILE}.\n`) +
      `Агенту, который читает только AGENTS.md (не Claude Code), укажите на ${RULES_FILE} сами.\n`,
  );
}
