// Tests: stale pre-fill fix, notes, per-exercise rest, backup reminder, PB celebration.
// Run: node tests/logging-extras.test.js  (or npm test)
const { chromium, devices, siteDir: defaultSiteDir, outDir } = require('./harness');
const http = require('http');
const fs = require('fs');
const path = require('path');

const siteDir = process.argv[2] || defaultSiteDir;
const outPrefix = process.argv[3] || path.join(outDir, 'logging-extras');

const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(siteDir, p);
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, require('./harness').responseHeaders(f, siteDir));
    fs.createReadStream(f).pipe(res);
}).listen(0);
const url = () => `http://localhost:${server.address().port}/`;

const checks = [];
const check = (name, actual, expected) => {
    const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
    checks.push({ ok, name, actual: ok ? undefined : actual, expected: ok || typeof expected === 'function' ? undefined : expected });
};

async function openApp(browser, seed) {
    const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'], viewport: { width: 402, height: 874 }, serviceWorkers: 'block', locale: 'en-GB', acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.route(/fonts\./, r => r.abort());
    await page.goto(url());
    if (seed) {
        await page.evaluate(seed);
        await page.reload();
    }
    return { ctx, page, errors };
}

// Last week: bench 60×10 ×3, incline 20×12 ×3. Optional extra logs merged in.
const seedHistory = (extra = '{}') => `(() => {
    const mk = (w, r) => ({ weight: String(w), reps: String(r), done: true });
    const logs = { [getWeekKey(-1)]: { 'session-1': { completed: true, date: formatDateKey(getWeekMonday(-1)), exercises: {
        'ex-101': [mk(60, 10), mk(60, 10), mk(60, 10)], 'ex-102': [mk(20, 12), mk(20, 12), mk(20, 12)] } } } };
    Object.assign(logs, ${extra});
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ dnaVersion: 2, unit: 'kg', sessions: createDefaultGymDNA().sessions, logs, isCustomized: true, updatedAt: Date.now() + 1000 }));
})()`;

(async () => {
    const browser = await chromium.launch();
    const card = (page, i) => page.locator('#exercises-list-container > div').nth(i);
    const setInputs = (page, i) => card(page, i).locator('input[inputmode]');

    // ---------- P. stale pre-fill fix + N. notes ----------
    {
        // A stale row saved by an older version in next week's log (no `auto` flag), from before last week's 60kg
        const staleNextWeek = `{ [getWeekKey(1)]: { 'session-1': { completed: false, exercises: { 'ex-101': [{ weight: '50', reps: '8', done: false }] } } } }`;
        const { ctx, page, errors } = await openApp(browser, null);
        await page.evaluate(seedHistory(staleNextWeek));
        await page.reload();

        await page.click('button[title="Next Week"]');
        check('P1 old stale future rows rebuilt from latest', await setInputs(page, 0).nth(0).inputValue(), '60');
        await page.click('#week-range-label'); // back to this week
        check('P2 this week pre-filled from last week', await setInputs(page, 0).nth(0).inputValue(), '60');

        await setInputs(page, 0).nth(0).fill('65'); await setInputs(page, 0).nth(0).blur();
        await card(page, 0).locator('button[aria-label="Log set 1"]').click();
        await page.evaluate(() => document.getElementById('pb-celebration')?.remove());
        await page.click('button[title="Next Week"]');
        const nextRows = await setInputs(page, 0).evaluateAll(els => els.filter((_, i) => i % 2 === 0).map(e => e.value));
        check('P3 peeked week follows this week\'s 65kg (extra rows repeat last set)', nextRows, ['65', '65', '65']);

        await setInputs(page, 0).nth(0).fill('70'); await setInputs(page, 0).nth(0).blur();
        await page.click('#week-range-label');
        await page.click('button[title="Next Week"]');
        check('P4 rows you edited are kept', await setInputs(page, 0).nth(0).inputValue(), '70');
        await page.click('#week-range-label');

        // Notes
        const note = card(page, 0).locator('input[aria-label^="Notes for"]');
        await note.fill('Seat 5, close grip');
        await setInputs(page, 0).nth(2).tap(); // tap set 2 weight right after typing the note
        await page.waitForTimeout(150);
        check('N1 focus moves to the tapped field (no re-render)', await setInputs(page, 0).nth(2).evaluate(el => el === document.activeElement), true);
        check('N2 note saved', await page.evaluate(() => state.sessions[0].exercises[0].notes), 'Seat 5, close grip');
        await page.reload();
        check('N3 note persists after reload', await card(page, 0).locator('input[aria-label^="Notes for"]').inputValue(), 'Seat 5, close grip');
        await card(page, 0).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${outPrefix}-card.png` });
        check('P/N errors', errors, []);
        await ctx.close();
    }

    // ---------- R. per-exercise rest ----------
    {
        const { ctx, page, errors } = await openApp(browser, null);
        await page.evaluate(seedHistory());
        await page.reload();

        await card(page, 0).locator('button[title="Edit Exercise"]').click();
        check('R1 existing exercise defaults to 1:30', await page.inputValue('#exercise-rest-input'), '90');
        await page.selectOption('#exercise-rest-input', '180');
        await page.click('#exercise-modal button[type=submit]');
        check('R2 card shows rest', (await card(page, 0).innerText()).includes('Rest 3:00'), true);
        await card(page, 0).locator('button[aria-label="Log set 1"]').click();
        await page.evaluate(() => document.getElementById('pb-celebration')?.remove());
        check('R3 ticking starts that exercise\'s rest', await page.textContent('#rest-timer-display'), '03:00');

        await card(page, 1).locator('button[title="Edit Exercise"]').click();
        await page.selectOption('#exercise-rest-input', '0');
        await page.click('#exercise-modal button[type=submit]');
        check('R4 no rest chip when off', (await card(page, 1).innerText()).includes('Rest '), false);
        await page.click('#rest-toggle-btn'); // pause the running 3:00 rest
        const pausedAt = await page.textContent('#rest-timer-display');
        await card(page, 1).locator('button[aria-label="Log set 1"]').click();
        check('R5 "No timer" leaves the rest timer alone', [await page.textContent('#rest-timer-display'), (await page.textContent('#rest-toggle-btn')).trim()], [pausedAt, 'Resume']);

        await page.click('#rest-toggle-btn'); // resume
        await page.evaluate(() => {
            const realNow = Date.now.bind(Date);
            Date.now = () => realNow() + 400000; // let it finish
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await page.waitForTimeout(300);
        check('R6 finished', (await page.textContent('#rest-toggle-btn')).trim(), 'Start');
        await page.click('#rest-toggle-btn');
        check('R7 Start restarts the last rest length', await page.textContent('#rest-timer-display'), '03:00');
        check('R errors', errors, []);
        await ctx.close();
    }

    // ---------- B. backup reminder ----------
    {
        const { ctx, page, errors } = await openApp(browser, null);
        await page.evaluate(seedHistory());
        await page.reload();
        check('B1 shows when never backed up', await page.isVisible('#backup-reminder'), true);
        await page.screenshot({ path: `${outPrefix}-backup.png`, clip: { x: 0, y: 0, width: 402, height: 330 } });
        await page.click('#backup-reminder >> text=Later');
        check('B2 Later hides it', await page.isVisible('#backup-reminder'), false);
        await page.reload();
        check('B3 stays snoozed after reload', await page.isVisible('#backup-reminder'), false);

        await page.evaluate(() => {
            localStorage.setItem('pulsegym_backup_snooze_v1', '0');
            localStorage.setItem('pulsegym_last_backup_v1', String(Date.now() - 2 * 86400000));
        });
        await page.reload();
        check('B4 recent backup: no reminder', await page.isVisible('#backup-reminder'), false);

        await page.evaluate(() => localStorage.setItem('pulsegym_last_backup_v1', String(Date.now() - 10 * 86400000)));
        await page.reload();
        check('B5 10 days + new data: reminder', await page.isVisible('#backup-reminder'), true);
        check('B6 says when', await page.textContent('#backup-reminder-text'), t => t.includes('10 days ago'));

        await page.evaluate(() => { navigator.canShare = undefined; }); // headless has no share sheet: use the download path
        const [download] = await Promise.all([page.waitForEvent('download'), page.click('#backup-reminder >> text=Save backup')]);
        check('B7 backup file saved', download.suggestedFilename(), n => /^pulsegym-backup-\d{4}-\d{2}-\d{2}\.json$/.test(n));
        check('B8 reminder cleared', await page.isVisible('#backup-reminder'), false);
        await page.click('button[title^="Install iPhone App"]');
        check('B9 last backup label', await page.textContent('#last-backup-label'), 'Last backup: today');
        check('B errors', errors, []);
        await ctx.close();
    }

    // ---------- C. PB celebration ----------
    {
        const { ctx, page, errors } = await openApp(browser, null);
        await page.evaluate(seedHistory());
        await page.reload();
        const celebrating = () => page.isVisible('#pb-celebration');
        const clear = () => page.evaluate(() => document.getElementById('pb-celebration')?.remove());
        const logSet = async (exIdx, setIdx, w, r) => {
            const inputs = setInputs(page, exIdx);
            await inputs.nth(setIdx * 2).fill(String(w)); await inputs.nth(setIdx * 2).blur();
            await inputs.nth(setIdx * 2 + 1).fill(String(r)); await inputs.nth(setIdx * 2 + 1).blur();
            await card(page, exIdx).locator(`button[aria-label="Log set ${setIdx + 1}"]`).click();
        };

        await logSet(0, 0, '62.5', 8);
        check('C1 heavier set celebrates', await celebrating(), true);
        check('C2 shows the set', (await page.innerText('#pb-celebration')).replace(/\s+/g, ' '), t => /new pb!/i.test(t) && t.includes('62.5kg × 8') && t.includes('Bench Press'));
        await page.screenshot({ path: `${outPrefix}-pb.png` });
        await clear();

        await logSet(0, 1, 60, 10);
        check('C3 matching an old best: no celebration', await celebrating(), false);

        await logSet(1, 0, 20, 13);
        check('C4 rep PB at same weight celebrates', await celebrating(), true);
        await clear();

        await logSet(4, 0, 25, 12); // ex-105: never logged before
        check('C5 first-ever set: no celebration', await celebrating(), false);
        check('C errors', errors, []);
        await ctx.close();
    }

    checks.forEach(c => console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.actual)}${c.expected !== undefined ? ` want=${JSON.stringify(c.expected)}` : ''}`}`));
    console.log(`\n${checks.filter(c => c.ok).length}/${checks.length} passed`);
    if (checks.some(c => !c.ok)) process.exitCode = 1;
    await browser.close();
    server.close();
})();
