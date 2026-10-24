// Tests: estimated 1RM, workout duration, plate calculator, per-day calendar events.
// Run: node tests/e1rm-plates-calendar.test.js  (or npm test)
const { chromium, devices, siteDir: defaultSiteDir, outDir } = require('./harness');
const http = require('http');
const fs = require('fs');
const path = require('path');

const siteDir = process.argv[2] || defaultSiteDir;
const outPrefix = process.argv[3] || path.join(outDir, 'e1rm-plates-calendar');

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

async function openApp(browser, seedLogs) {
    const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'], viewport: { width: 402, height: 874 }, serviceWorkers: 'block', locale: 'en-GB', acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.route(/fonts\./, r => r.abort());
    await page.goto(`http://localhost:${server.address().port}/`);
    await page.evaluate(logsExpr => {
        const mk = (w, r) => ({ weight: String(w), reps: String(r), done: true });
        const logs = eval(`(${logsExpr})`)(mk);
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ dnaVersion: 2, unit: 'kg', sessions: createDefaultGymDNA().sessions, logs, isCustomized: true, updatedAt: Date.now() + 1000 }));
        localStorage.setItem('pulsegym_last_backup_v1', String(Date.now())); // keep the backup banner out of the way
    }, seedLogs);
    await page.reload();
    // Controllable clock for duration tests (Date.now only)
    await page.evaluate(() => {
        const realNow = Date.now.bind(Date);
        window.__offset = 0;
        Date.now = () => realNow() + window.__offset;
    });
    return { ctx, page, errors };
}

const lastWeek = mk => `({ [getWeekKey(-1)]: { 'session-1': { completed: true, date: formatDateKey(getWeekMonday(-1)), exercises: {
    'ex-101': [${'mk(60, 10), mk(65, 5)'}], 'ex-303': [mk(100, 5)] } } } })`;

(async () => {
    const browser = await chromium.launch();
    const card = (page, i) => page.locator('#exercises-list-container > div').nth(i);
    const setInputs = (page, i) => card(page, i).locator('input[inputmode]');
    const seed = `mk => ({ [getWeekKey(-1)]: {
        'session-1': { completed: true, date: formatDateKey(getWeekMonday(-1)), exercises: { 'ex-101': [mk(60, 10), mk(65, 5)] } },
        'session-3': { completed: true, exercises: { 'ex-303': [mk(100, 5), mk(100, 5)] } } } })`;

    // ---------- E. estimated 1RM ----------
    {
        const { ctx, page, errors } = await openApp(browser, seed);
        const board = await page.locator('#pb-leaderboard > div').first().innerText();
        check('E1 PR board shows top set PB', board.replace(/\s+/g, ' '), t => t.includes('65kg × 5'));
        check('E2 PR board shows best e1RM (60×10 → 80)', board.replace(/\s+/g, ' '), t => t.includes('Est. 1RM ≈ 80kg'));
        await page.selectOption('#chart-exercise-select', 'ex-101');
        check('E3 toggle shown for a lift', await page.isVisible('#chart-mode-toggle'), true);
        check('E4 default is top set', await page.textContent('#strength-pb-pill'), 'Peak: 65 kg');
        await page.click('#chart-mode-toggle >> text=Est. 1RM');
        check('E5 e1RM view', await page.textContent('#strength-pb-pill'), 'Best e1RM: 80 kg');
        check('E6 subtitle explains', await page.textContent('#strength-chart-subtitle'), t => t.includes('Estimated 1-rep max'));
        await page.locator('#strength-chart-bars').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${outPrefix}-e1rm.png` });
        await page.selectOption('#chart-exercise-select', 'ASSAULT_BIKE_CALS');
        check('E7 toggle hidden for bike', await page.isVisible('#chart-mode-toggle'), false);
        await page.click('#unit-toggle-btn');
        check('E8 e1RM in lbs', (await page.locator('#pb-leaderboard > div').first().innerText()), t => t.includes('Est. 1RM ≈ 176lbs'));
        check('E errors', errors, []);
        await ctx.close();
    }

    // ---------- D. workout duration ----------
    {
        const { ctx, page, errors } = await openApp(browser, seed);
        const sub = () => page.textContent('#active-session-subtitle');
        check('D1 tip before starting', await sub(), t => t.startsWith('Tap ✓'));
        await card(page, 0).locator('button[aria-label="Log set 1"]').click();
        await page.evaluate(() => document.getElementById('pb-celebration')?.remove());
        check('D2 started', await sub(), t => /^Started \d{2}:\d{2} · 1 min so far$/.test(t));
        await page.evaluate(() => { window.__offset = 34 * 60000; renderSessionTiming(); });
        check('D3 live minutes', await sub(), t => t.endsWith('34 min so far'));
        await page.evaluate(() => { window.__offset = 40 * 60000; });
        await card(page, 0).locator('button[aria-label="Log set 2"]').click();
        await page.evaluate(() => { window.__offset = 45 * 60000; document.getElementById('pb-celebration')?.remove(); });
        await page.click('#finish-session-top-btn');
        check('D4 finished duration', await sub(), t => /^Finished in 45 min · \d{2}:\d{2}–\d{2}:\d{2}$/.test(t));
        check('D5 toast mentions time', await page.textContent('#toast-container'), t => t.includes('complete in 45 min'));
        await page.click('text=Workout History');
        check('D6 history shows duration', await page.locator('#history-list details').first().innerText(), t => t.includes('⏱ 45 min'));
        await page.click('#history-modal button[aria-label="Close history"]');
        await page.click('#finish-session-top-btn'); // undo
        check('D7 undo returns to live view', await sub(), t => t.includes('so far'));

        // Complete tapped long after the last set: ends at the last set
        await page.click('#session-tabs-grid >> text=2. Back & Bis');
        await page.evaluate(() => { window.__offset = 0; });
        await card(page, 0).locator('button[aria-label="Log set 1"]').click();
        await page.evaluate(() => { window.__offset = 30 * 60000; });
        await card(page, 0).locator('button[aria-label="Log set 2"]').click();
        await page.evaluate(() => { window.__offset = 150 * 60000; });
        await page.click('#finish-session-top-btn');
        check('D8 late "Complete" ends at last set', await sub(), t => t.startsWith('Finished in 30 min'));
        check('D errors', errors, []);
        await ctx.close();
    }

    // ---------- P. plate calculator ----------
    {
        const { ctx, page, errors } = await openApp(browser, seed);
        await page.click('#session-tabs-grid >> text=3. Shoulders & Legs');
        const squat = card(page, 2);
        await squat.locator('button:has-text("Plates")').click();
        check('P1 opens with next set weight', await page.inputValue('#plates-target'), '100');
        check('P2 100kg on Olympic bar', (await page.innerText('#plates-result')).replace(/\s+/g, ' '), t => t.includes('25 + 15') && t.includes('= 100 kg'));
        await page.screenshot({ path: `${outPrefix}-plates.png` });
        await page.fill('#plates-target', '61');
        check('P3 impossible weight explained', await page.innerText('#plates-result'), t => t.includes("Can't make 61 kg exactly") && t.includes('closest is 60 or 62.5'));
        await page.selectOption('#plates-bar', 'ez');
        await page.fill('#plates-target', '30');
        check('P4 EZ bar', (await page.innerText('#plates-result')).replace(/\s+/g, ' '), t => t.includes('EACH SIDE 10') || t.includes('Each side 10'));
        check('P5 bar remembered on exercise', await page.evaluate(() => findExercise('ex-303').ex.bar), 'ez');
        await page.fill('#plates-target', '8'); // EZ bar is 10 kg
        check('P6 below bar', await page.innerText('#plates-result'), t => t.includes('less than the bar'));
        await page.click('#plates-modal button[aria-label="Close plate calculator"]');
        await page.click('#unit-toggle-btn');
        await squat.locator('button:has-text("Plates")').click();
        check('P7 remembered EZ bar, lbs options', await page.inputValue('#plates-bar'), 'ez');
        await page.selectOption('#plates-bar', 'olympic');
        await page.fill('#plates-target', '225');
        check('P8 225 lbs = 45 + 45', (await page.innerText('#plates-result')).replace(/\s+/g, ' '), t => t.includes('45 + 45') && t.includes('= 225 lbs'));
        await page.click('#plates-modal button[aria-label="Close plate calculator"]');
        await page.click('#session-tabs-grid >> text=4. Cardio Day');
        check('P9 no Plates on cardio', await page.locator('#exercises-list-container button:has-text("Plates")').count(), 0);
        check('P errors', errors, []);
        await ctx.close();
    }

    // ---------- C. per-day calendar events ----------
    {
        const { ctx, page, errors } = await openApp(browser, seed);
        await page.click('button[title^="Gym Reminders"]');
        const selects = page.locator('#reminder-days-list select');
        check('C1 one picker per workout', await selects.count(), 4);
        check('C2 defaults Mon/Tue/Thu/Sat', await selects.evaluateAll(els => els.map(e => e.value)), ['1', '2', '4', '6']);
        await selects.nth(2).selectOption('-1'); // Day 3: no reminder
        await selects.nth(3).selectOption('0');  // Day 4: Sunday
        await page.fill('#gym-reminder-time', '06:45');
        await page.dispatchEvent('#gym-reminder-time', 'change');
        await page.screenshot({ path: `${outPrefix}-reminders.png` });
        const [download] = await Promise.all([page.waitForEvent('download'), page.click('#reminders-modal >> text=Add Training Days')]);
        const ics = fs.readFileSync(await download.path(), 'utf8');
        const unfolded = ics.replace(/\r\n /g, '');
        check('C3 file name', download.suggestedFilename(), 'pulsegym-training-days.ics');
        check('C4 three events', (ics.match(/BEGIN:VEVENT/g) || []).length, 3);
        check('C5 days', ['MO', 'TU', 'TH', 'SU'].map(d => unfolded.includes(`BYDAY=${d}`)), [true, true, false, true]);
        check('C6 named per workout', unfolded, t => t.includes('SUMMARY:💪 Day 1 · Chest & Triceps + 10m Bike HIIT') && t.includes('SUMMARY:💪 Day 4 · Cardio & Conditioning\r\n'));
        check('C7 exercises listed', unfolded, t => t.includes('• Barbell / Dumbbell Bench Press — 8-10 reps'));
        check('C8 time & alert', unfolded, t => /DTSTART:\d{8}T064500/.test(t) && t.includes('TRIGGER:-PT30M'));
        check('C9 lines ≤ 75 bytes', ics.split('\r\n').every(l => Buffer.byteLength(l, 'utf8') <= 75), true);
        const starts = [...unfolded.matchAll(/DTSTART:(\d{4})(\d{2})(\d{2})/g)].map(m => new Date(+m[1], +m[2] - 1, +m[3]).getDay());
        check('C10 each series starts on its own weekday', starts, [1, 2, 0]);
        await page.reload();
        await page.click('button[title^="Gym Reminders"]');
        check('C11 days & time remembered', [await page.locator('#reminder-days-list select').evaluateAll(els => els.map(e => e.value)), await page.inputValue('#gym-reminder-time')], [['1', '2', '-1', '0'], '06:45']);
        check('C errors', errors, []);
        await ctx.close();
    }

    checks.forEach(c => console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.actual)}${c.expected !== undefined ? ` want=${JSON.stringify(c.expected)}` : ''}`}`));
    console.log(`\n${checks.filter(c => c.ok).length}/${checks.length} passed`);
    if (checks.some(c => !c.ok)) process.exitCode = 1;
    await browser.close();
    server.close();
})();
