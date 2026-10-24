// Tests per-exercise "What to track" measurements, starting from pre-existing data (no `track` fields).
// Run: node tests/measurements.test.js  (or npm test)
const { chromium, devices, siteDir: defaultSiteDir, outDir } = require('./harness');
const http = require('http');
const fs = require('fs');
const path = require('path');

const siteDir = process.argv[2] || defaultSiteDir;
const outPrefix = process.argv[3] || path.join(outDir, 'measurements');

const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(siteDir, p);
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, require('./harness').responseHeaders(f, siteDir));
    fs.createReadStream(f).pipe(res);
}).listen(0);

const checks = [];
const check = (name, actual, expected) => {
    const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
    checks.push({ ok, name, actual: ok ? undefined : actual, expected: ok || typeof expected === 'function' ? undefined : expected });
};

(async () => {
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'], viewport: { width: 402, height: 874 }, serviceWorkers: 'block', locale: 'en-GB' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.route(/fonts\./, r => r.abort());
    await page.goto(`http://localhost:${server.address().port}/`);

    // Existing user: sessions saved before measures existed (no `track`), a renamed cardio exercise, old cardio logs
    await page.evaluate(() => {
        const sessions = createDefaultGymDNA().sessions;
        sessions.forEach(s => s.exercises.forEach(ex => delete ex.track));
        sessions[3].exercises[1].name = 'Concept2 Rower';
        const wk1 = getWeekKey(-1);
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            dnaVersion: 2, unit: 'kg', sessions, isCustomized: true, updatedAt: Date.now() + 1000,
            logs: { [wk1]: {
                'session-1': { completed: true, exercises: { 'ex-101': [{ weight: '60', reps: '10', done: true }] } },
                'session-4': { completed: true, date: formatDateKey(getWeekMonday(-1)), exercises: { 'ex-401': [{ weight: '300', reps: '20', done: true }] } }
            } }
        }));
    });
    await page.reload();

    const card = i => page.locator('#exercises-list-container > div').nth(i);
    const headers = async i => (await card(i).locator('.grid.grid-cols-12').first().innerText()).replace(/\s+/g, ' ').trim();

    // Weights day untouched
    check('T1 Day 1 headers unchanged', await headers(0), 'SET WEIGHT (KG) REPS LOG');

    await page.click('#session-tabs-grid >> text=4. Cardio Day');
    check('T2 old cardio exercise keeps original labels', await headers(0), 'SET CALS / SPEED MINS / WATTS LOG');
    check('T3 last-time for old cardio entry', await card(0).locator('p.font-mono').first().textContent(), '300 / 20');

    // Edit the rower: pickers pre-filled from the old columns, then switch to Distance + Time
    await card(1).locator('button[title="Edit Exercise"]').click();
    check('T4 pickers map old columns', [await page.inputValue('#exercise-track-a-input'), await page.inputValue('#exercise-track-b-input')], ['cals', 'mins']);
    check('T5 edit note shown', await page.textContent('#exercise-track-note'), t => t.includes('relabels'));
    await page.selectOption('#exercise-track-a-input', 'km');
    await page.selectOption('#exercise-track-b-input', 'mins');
    await page.screenshot({ path: `${outPrefix}-modal.png` });
    await page.click('#exercise-modal button[type=submit]');
    check('T6 rower headers', await headers(1), 'SET DISTANCE (KM) TIME (MIN) LOG');
    const rowerInputs = card(1).locator('input[inputmode]');
    check('T7 decimal keypad for km', await rowerInputs.nth(0).getAttribute('inputmode'), 'decimal');
    await rowerInputs.nth(0).fill('5,2'); await rowerInputs.nth(0).blur();
    await rowerInputs.nth(1).fill('25'); await rowerInputs.nth(1).blur();
    await card(1).locator('button[aria-label="Log set 1"]').click();
    check('T8 stored raw (no kg conversion)', await page.evaluate(() => state.logs[getWeekKey(0)]['session-4'].exercises['ex-402'][0]).then(s => ({ weight: s.weight, reps: s.reps, done: s.done })), { weight: '5.2', reps: '25', done: true });
    check('T9 rower PB', await page.textContent('#pb-ex-402'), 'PB: 5.2 km · 25 min');
    check('T10 cardio not counted as a lift', await page.textContent('#kpi-lifts-up'), '–');

    // Ab work: Reps + Nothing -> one wide input
    await card(2).locator('button[title="Edit Exercise"]').click();
    await page.selectOption('#exercise-track-a-input', 'reps');
    await page.selectOption('#exercise-track-b-input', 'none');
    await page.click('#exercise-modal button[type=submit]');
    check('T11 single measure header', await headers(2), 'SET REPS LOG');
    check('T12 single input per set', await card(2).locator('input[inputmode]').count(), 3);
    await card(2).locator('input[inputmode]').nth(0).fill('15'); await card(2).locator('input[inputmode]').nth(0).blur();
    await card(2).locator('button[aria-label="Log set 1"]').click();
    check('T13 reps-only PB', await page.textContent('#pb-ex-403'), 'PB: 15 reps');

    // New exercise: defaults follow the chosen day until the user picks
    await page.click('#session-tabs-grid >> text=1. Chest & Tris');
    await page.click('button[onclick="openAddExerciseModal()"]');
    check('T14 weights-day default', [await page.inputValue('#exercise-track-a-input'), await page.inputValue('#exercise-track-b-input')], ['weight', 'reps']);
    await page.selectOption('#exercise-session-input', 'session-4');
    check('T15 switches to cardio default', [await page.inputValue('#exercise-track-a-input'), await page.inputValue('#exercise-track-b-input')], ['mins', 'cals']);
    await page.selectOption('#exercise-track-a-input', 'metres');
    await page.selectOption('#exercise-track-b-input', 'secs');
    await page.fill('#exercise-name-input', 'Row 500m Sprint');
    await page.click('#exercise-modal button[type=submit]');
    check('T16 new exercise headers', await headers(3), 'SET DISTANCE (M) TIME (S) LOG');

    // lbs: cardio values untouched, weights converted
    await page.click('#unit-toggle-btn');
    check('T17 km unaffected by lbs', await card(1).locator('input[inputmode]').nth(0).inputValue(), '5.2');
    await page.click('#session-tabs-grid >> text=1. Chest & Tris');
    check('T18 weights still convert', await headers(0), 'SET WEIGHT (LBS) REPS LOG');
    await page.click('#unit-toggle-btn');

    // History + chart
    await page.click('text=Workout History');
    await page.locator('#history-list details').first().locator('summary').click();
    const hist = (await page.locator('#history-list details').first().innerText()).replace(/\s+/g, ' ');
    check('T19 history shows measures', hist, t => t.includes('5.2 km / 25 min') && t.includes('15 reps'));
    await page.screenshot({ path: `${outPrefix}-history.png` });
    await page.click('#history-modal button[aria-label="Close history"]');
    await page.selectOption('#chart-exercise-select', 'ex-402');
    check('T20 chart pill uses km', await page.textContent('#strength-pb-pill'), 'Peak: 5.2 km');

    await page.click('#session-tabs-grid >> text=4. Cardio Day');
    await card(1).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${outPrefix}-cardio.png` });
    check('T errors', errors, []);

    checks.forEach(c => console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.actual)}${c.expected !== undefined ? ` want=${JSON.stringify(c.expected)}` : ''}`}`));
    console.log(`\n${checks.filter(c => c.ok).length}/${checks.length} passed`);
    if (checks.some(c => !c.ok)) process.exitCode = 1;
    await browser.close();
    server.close();
})();
