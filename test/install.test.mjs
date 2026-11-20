import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(ROOT, 'scripts', 'install.mjs');
const FAKE_PULT = path.join(ROOT, 'test-support', 'fake-pult.mjs');

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

// То, что «пишет» поддельный pult kit pull: роль адъютанта и все его команды (в настоящем наборе их отдаёт сервер).
const COMMANDS = ['utro', 'den', 'vecher', 'nedelya', 'mesyac', 'razbor', 'raund', 'cikl', 'sprint', 'plan', 'obhod'];
const SERVED = {
  '.pult-role.md': '<!-- pult-role: adjutant -->\nРоль адъютанта с сервера\n',
  ...Object.fromEntries(COMMANDS.map((c) => [`.claude/commands/${c}.md`, `---\ndescription: ${c}\n---\nс сервера\n`])),
};

function install({ whoami, exit, args = [], prepare, kit = { hash: 'c'.repeat(64), files: SERVED } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-kit-inst-'));
  made.push(dir);
  const fake = path.join(dir, 'fake');
  const target = path.join(dir, 'project');
  fs.mkdirSync(fake);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(fake, 'scenario.json'), JSON.stringify({ whoami, exit, stderr: 'нет токена', kit }));
  prepare?.(target);

  const res = spawnSync(process.execPath, [INSTALL, '--target', target, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PULT_BIN: FAKE_PULT, FAKE_DIR: fake },
  });
  const log = path.join(fake, 'pult-calls.log');
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).args) : [];

  return { ...res, target, calls, kitCalls: calls.filter((a) => a[0] === 'kit'), has: (p) => fs.existsSync(path.join(target, p)) };
}

const who = (role) => ({ member: { id: 'm1', name: 'Имя' }, role, machine: 'дом', team: { slug: 't', name: 'Т' } });

test('в наборе нет роли адъютанта и его команд: их отдаёт сервер', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'roles', 'adjutant.md')), false, 'roles/adjutant.md вернулся в набор');
  assert.equal(fs.existsSync(path.join(ROOT, '.claude', 'commands', 'utro.md')) && spawnSync('git', ['ls-files', '--error-unmatch', '.claude/commands/utro.md'], { cwd: ROOT }).status === 0, false, 'команды адъютанта лежат в git набора');
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^\.claude\/commands\/$/m, '.claude/commands/ не в .gitignore');
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^\.pult-role\.md$/m);
});

test('member получает файл роли member и больше ничего адъютантского; с сервера для него не просится ничего', () => {
  const r = install({ whoami: who('member') });

  assert.equal(r.status, 0, r.stderr);
  const role = fs.readFileSync(path.join(r.target, '.pult-role.md'), 'utf8');
  assert.match(role, /^<!-- pult-role: member -->/);
  assert.ok(!/journal|private add|expire-claim/.test(role), 'в файле member есть команды адъютанта');
  assert.ok(r.has('AGENTS.md') && r.has('CLAUDE.md'));
  assert.equal(r.has('.claude'), false, 'member получил команды или настройки адъютанта');
  assert.deepEqual(r.kitCalls, [], 'для сотрудника pult kit не зовётся вовсе');
});

for (const role of ['adjutant', 'product']) {
  test(`${role} получает роль и команды адъютанта через pult kit pull в каталог установки`, () => {
    const r = install({ whoami: who(role) });

    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.kitCalls.length, 1);
    assert.deepEqual(r.kitCalls[0].slice(0, 2), ['kit', 'pull']);
    assert.equal(r.kitCalls[0][r.kitCalls[0].indexOf('--dir') + 1], r.target);
    assert.match(fs.readFileSync(path.join(r.target, '.pult-role.md'), 'utf8'), /^<!-- pult-role: adjutant -->/);
    assert.match(fs.readFileSync(path.join(r.target, '.pult-role.md'), 'utf8'), /с сервера/);
    for (const c of COMMANDS) assert.ok(r.has(`.claude/commands/${c}.md`), c);
    assert.ok(r.has('.claude/settings.json'), 'разрешения запусков берутся из набора');
    assert.ok(r.has('AGENTS.md') && r.has('CLAUDE.md'));
  });
}

for (const role of ['admin', '', 'MEMBER', '__proto__', 'constructor']) {
  test(`неизвестная роль «${role}»: отказ, ничего не записано, pult kit не зовётся`, () => {
    const r = install({ whoami: who(role) });

    assert.equal(r.status, 2);
    assert.match(r.stderr, /не известна/);
    assert.deepEqual(fs.readdirSync(r.target), []);
    assert.deepEqual(r.kitCalls, []);
  });
}

test('whoami без поля роли: отказ', () => {
  const r = install({ whoami: { member: { name: 'x' } } });

  assert.equal(r.status, 2);
  assert.deepEqual(fs.readdirSync(r.target), []);
});

test('whoami не прошёл (токен не принят): отказ с тем же кодом, ничего не записано', () => {
  const r = install({ whoami: who('member'), exit: 4 });

  assert.equal(r.status, 4);
  assert.match(r.stderr, /Не удалось определить роль/);
  assert.deepEqual(fs.readdirSync(r.target), []);
});

test('сервер отказал в наборе (код 5) или нет связи (3): установка адъютанта не идёт, ничего не записано', () => {
  for (const code of [5, 3, 1]) {
    const r = install({ whoami: who('adjutant'), kit: { pullExit: code, pullStderr: 'отказ сервера' } });

    assert.notEqual(r.status, 0, `код ${code}`);
    assert.match(r.stderr, /Роль и команды адъютанта не получены/);
    assert.deepEqual(fs.readdirSync(r.target), [], `код ${code}: записано лишнее`);
  }
});

test('утилита без pult kit (код 2): понятное сообщение про обновление утилиты, ничего не записано', () => {
  const r = install({ whoami: who('adjutant'), kit: null });

  assert.equal(r.status, 2);
  assert.match(r.stderr, /обновите её/);
  assert.deepEqual(fs.readdirSync(r.target), []);
});

// B-158: проект со своим CLAUDE.md. Раньше установка отказывала целиком, а с --force затирала CLAUDE.md проекта файлом набора.
const OWN = { 'CLAUDE.md': '# Мой проект\nсвои правила\n', 'AGENTS.md': '# Мои агенты\n' };
const own = (names) => (t) => names.forEach((n) => fs.writeFileSync(path.join(t, n), OWN[n]));
const read = (r, p) => fs.readFileSync(path.join(r.target, p), 'utf8');

for (const args of [[], ['--force']]) {
  test(`проект со своим CLAUDE.md${args.length ? ' и --force' : ''}: файлы проекта не тронуты, правила набора легли рядом`, () => {
    const r = install({ whoami: who('member'), args, prepare: own(['CLAUDE.md', 'AGENTS.md']) });

    assert.equal(r.status, 0, r.stderr);
    assert.equal(read(r, 'CLAUDE.md'), OWN['CLAUDE.md'], 'CLAUDE.md проекта изменён');
    assert.equal(read(r, 'AGENTS.md'), OWN['AGENTS.md'], 'AGENTS.md проекта изменён');
    assert.match(read(r, '.pult-role.md'), /^<!-- pult-role: member -->/);
    assert.equal(read(r, '.pult-rules.md'), fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8'), 'правила набора — это его AGENTS.md целиком');
    assert.match(read(r, 'CLAUDE.local.md'), /^<!-- pult-kit: начало[^\n]*\n@\.pult-rules\.md\n[\s\S]*# Особенности Claude Code[\s\S]*<!-- pult-kit: конец -->\n$/);
    assert.ok(!read(r, 'CLAUDE.local.md').includes('@AGENTS.md'), 'блок не должен подключать AGENTS.md проекта');
    assert.match(r.stdout, /не тронуты/);
  });
}

test('только свой CLAUDE.md (AGENTS.md нет): AGENTS.md проекту не подкладывается', () => {
  const r = install({ whoami: who('member'), prepare: own(['CLAUDE.md']) });

  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(r, 'CLAUDE.md'), OWN['CLAUDE.md']);
  assert.equal(r.has('AGENTS.md'), false, 'набор подложил AGENTS.md в проект со своим CLAUDE.md');
  assert.ok(r.has('.pult-rules.md') && r.has('CLAUDE.local.md'));
});

test('чужой CLAUDE.md, начинающийся с @AGENTS.md, набором не считается и не перезаписывается', () => {
  const mine = '@AGENTS.md\n\n# Мой проект\n';
  const r = install({
    whoami: who('member'),
    args: ['--force'],
    prepare: (t) => {
      fs.writeFileSync(path.join(t, 'CLAUDE.md'), mine);
      fs.writeFileSync(path.join(t, 'AGENTS.md'), OWN['AGENTS.md']);
    },
  });

  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(r, 'CLAUDE.md'), mine);
  assert.equal(read(r, 'AGENTS.md'), OWN['AGENTS.md']);
});

test('свой CLAUDE.local.md сохраняется, блок набора дописывается, а при повторной установке заменяется, не дублируясь', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-kit-inst-'));
  made.push(dir);
  const fake = path.join(dir, 'fake');
  const target = path.join(dir, 'project');
  fs.mkdirSync(fake);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(fake, 'scenario.json'), JSON.stringify({ whoami: who('member') }));
  fs.writeFileSync(path.join(target, 'CLAUDE.md'), OWN['CLAUDE.md']);
  fs.writeFileSync(path.join(target, 'CLAUDE.local.md'), 'мои заметки\n');
  const run = () => spawnSync(process.execPath, [INSTALL, '--target', target], { encoding: 'utf8', env: { ...process.env, PULT_BIN: FAKE_PULT, FAKE_DIR: fake } });

  assert.equal(run().status, 0);
  // Человек дописал своё и после блока: повторная установка не должна это съесть.
  fs.appendFileSync(path.join(target, 'CLAUDE.local.md'), 'после блока\n');
  const second = run();
  assert.equal(second.status, 0, second.stderr);

  const local = fs.readFileSync(path.join(target, 'CLAUDE.local.md'), 'utf8');
  assert.match(local, /^мои заметки\n\n<!-- pult-kit: начало/);
  assert.match(local, /<!-- pult-kit: конец -->\nпосле блока\n$/);
  assert.equal(local.split('<!-- pult-kit: начало').length - 1, 1, 'блок набора задвоился');
  assert.equal(fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8'), OWN['CLAUDE.md']);
});

test('в git-проекте файлы набора попадают в .git/info/exclude; --dry-run туда не пишет', () => {
  const prepare = (t) => {
    own(['CLAUDE.md'])(t);
    fs.mkdirSync(path.join(t, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(t, '.git', 'info', 'exclude'), '# свои исключения\n*.tmp\n');
  };
  const r = install({ whoami: who('member'), prepare });

  assert.equal(r.status, 0, r.stderr);
  const exclude = read(r, '.git/info/exclude');
  assert.match(exclude, /^# свои исключения\n\*\.tmp\n/);
  for (const name of ['.pult-role.md', '.pult-rules.md', 'CLAUDE.local.md']) assert.ok(exclude.split('\n').includes(name), name);
  assert.match(r.stdout, /\.git\/info\/exclude/);

  const dry = install({ whoami: who('member'), args: ['--dry-run'], prepare });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(read(dry, '.git/info/exclude'), '# свои исключения\n*.tmp\n', '--dry-run записал в исключения');
  assert.equal(dry.has('.pult-rules.md'), false);
  assert.equal(dry.has('CLAUDE.local.md'), false);
});

test('файлы прошлой установки набора обновляются без --force: это свои файлы, а не чужие', () => {
  const stale = (t) => {
    fs.writeFileSync(path.join(t, 'AGENTS.md'), '<!-- Общий текст правил. Старая редакция. -->\nстарые правила\n');
    fs.writeFileSync(path.join(t, 'CLAUDE.md'), '@AGENTS.md\n\n# Особенности Claude Code\n\nстарое\n');
  };
  const r = install({ whoami: who('member'), prepare: stale });

  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(r, 'AGENTS.md'), fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8'));
  assert.equal(read(r, 'CLAUDE.md'), fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8'));
  assert.equal(r.has('.pult-rules.md'), false);
  assert.equal(r.has('CLAUDE.local.md'), false);
});

test('адъютант: чужие настройки .claude/settings.json без --force не перезаписываются, и набор с сервера не тянется', () => {
  const prepare = (t) => {
    fs.mkdirSync(path.join(t, '.claude'));
    fs.writeFileSync(path.join(t, '.claude', 'settings.json'), '{"mine":true}');
  };
  const adj = install({ whoami: who('adjutant'), prepare });

  assert.equal(adj.status, 2);
  assert.match(adj.stderr, /settings\.json/);
  assert.deepEqual(adj.kitCalls, [], 'конфликт найден до обращения к серверу');
  assert.equal(adj.has('.pult-role.md'), false);
  assert.equal(read(adj, '.claude/settings.json'), '{"mine":true}');
});

test('--force доходит до pult kit pull (перезапись чужих команд без метки набора)', () => {
  const r = install({ whoami: who('adjutant'), args: ['--force'] });

  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.kitCalls[0].includes('--force'));
});

test('--dry-run ничего не пишет; для адъютанта pult kit pull зовётся с --dry-run', () => {
  const r = install({ whoami: who('adjutant'), args: ['--dry-run'] });

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Будет записано/);
  assert.ok(r.kitCalls[0].includes('--dry-run'));
  assert.deepEqual(fs.readdirSync(r.target), []);

  const member = install({ whoami: who('member'), args: ['--dry-run'] });
  assert.equal(member.status, 0, member.stderr);
  assert.deepEqual(fs.readdirSync(member.target), []);
});
