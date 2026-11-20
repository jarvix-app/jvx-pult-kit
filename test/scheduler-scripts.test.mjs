import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function ps1Files(dir = ROOT, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'voice'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) ps1Files(full, out);
    else if (e.name.endsWith('.ps1')) out.push(full);
  }
  return out;
}

test('файлы .ps1 сохранены в UTF-8 с одной меткой BOM (иначе PowerShell 5.1 ломает кириллицу)', () => {
  const files = ps1Files();
  assert.ok(files.length >= 2);

  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(text.startsWith('﻿'), `${f}: нет метки BOM`);
    assert.equal(text.split('﻿').length - 1, 1, `${f}: метка BOM не одна`);
  }
});

test('файлы .ps1 разбираются парсером PowerShell', { skip: process.platform !== 'win32' && 'парсер Windows PowerShell есть только на Windows' }, () => {
  for (const f of ps1Files()) {
    const script = `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${f.replaceAll("'", "''")}',[ref]$t,[ref]$e);$e|%{$_.Message};exit $e.Count`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stdout}`);
  }
});
