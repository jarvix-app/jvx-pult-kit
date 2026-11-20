// Поддельный claude для тестов сторожа: пишет, с чем его позвали, спит, выходит с заданным кодом.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.FAKE_DIR;

fs.appendFileSync(
  path.join(dir, 'claude-calls.log'),
  `${JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), at: Date.now() })}\n`,
);

if (process.env.FAKE_CLAUDE_STDOUT) process.stdout.write(`${process.env.FAKE_CLAUDE_STDOUT}\n`);

await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_SLEEP_MS ?? 0)));
process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? 0));
