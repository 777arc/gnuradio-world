import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const directory = new URL('.', import.meta.url);
const tests = (await readdir(directory))
  .filter(name => name.endsWith('.test.mjs'))
  .sort((a, b) => a.localeCompare(b));

for (const test of tests) {
  const child = spawn(process.execPath, [new URL(test, directory).pathname], {
    stdio: 'inherit',
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) process.exit(code ?? 1);
}

console.log(`passed ${tests.length} editor test files`);
