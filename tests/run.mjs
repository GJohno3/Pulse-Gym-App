// Runs every *.test.js / *.test.mjs suite in this folder, one after another, and fails if any does.
// `npm test` runs them all; `npm test -- push` runs only suites whose name contains "push".
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2);
const suites = readdirSync(here)
    .filter(f => /\.test\.m?js$/.test(f))
    .filter(f => !filters.length || filters.some(name => f.includes(name)))
    .sort();

const results = suites.map(suite => {
    console.log(`\n▶ ${suite}`);
    const started = Date.now();
    const run = spawnSync(process.execPath, [path.join(here, suite)], { stdio: 'inherit', timeout: 10 * 60 * 1000 });
    return { suite, ok: run.status === 0, seconds: Math.round((Date.now() - started) / 1000) };
});

console.log('\nSummary');
results.forEach(r => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.suite} (${r.seconds}s)`));
if (!results.length || results.some(r => !r.ok)) process.exitCode = 1;
