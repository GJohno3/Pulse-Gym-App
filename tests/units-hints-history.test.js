// Tests for kg/lbs conversion, legacy migration, last-time hints, and workout history.
// Run: node tests/units-hints-history.test.js  (or npm test)
const { chromium, devices, siteDir: defaultSiteDir, outDir } = require('./harness');
const http = require('http');
const fs = require('fs');
const path = require('path');

const siteDir = process.argv[2] || defaultSiteDir;
const outPrefix = process.argv[3] || path.join(outDir, 'units-hints-history');

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

async function newPage(browser) {
    const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'], viewport: { width: 402, height: 874 }, serviceWorkers: 'block', locale: 'en-GB' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.route(/fonts\./, r => r.abort());
    return { ctx, page, errors };
}

(async () => {
    const url = `http://localhost:${server.address().port}/`;
    const browser = await chromium.launch();

    // ---------- A. kg <-> lbs round trips ----------
    {
        const { ctx, page, errors } = await newPage(browser);
        await page.goto(url);
        const inputs = page.locator('#exercises-list-container input[inputmode]');
        await inputs.nth(0).fill('60'); await inputs.nth(0).blur();
        await inputs.nth(1).fill('10'); await inputs.nth(1).blur();
        await page.locator('button[aria-label="Log set 1"]').first().click();
        check('A1 volume kg', await page.textContent('#kpi-weekly-volume'), '600 kg');

        await page.click('#unit-toggle-btn');
        check('A2 weight shown in lbs', await inputs.nth(0).inputValue(), '132.3');
        check('A3 volume lbs', await page.textContent('#kpi-weekly-volume'), '1,323 lbs');
        check('A4 PB lbs', await page.textContent('#pb-ex-101'), 'PB: 132.3lbs × 10');

        await inputs.nth(2).fill('135'); await inputs.nth(2).blur(); // set 2 typed in lbs
        check('A5 stored as kg', await page.evaluate(() => state.logs[getWeekKey(0)]['session-1'].exercises['ex-101'][1].weight), '61.235');
        await page.click('#unit-toggle-btn'); // back to kg
        check('A6 set 2 in kg', await inputs.nth(2).inputValue(), '61.24');
        check('A7 set 1 still 60 kg', await inputs.nth(0).inputValue(), '60');
        await page.click('#unit-toggle-btn'); // lbs again
        check('A8 set 2 back to 135 lbs (no drift)', await inputs.nth(2).inputValue(), '135');
        check('A errors', errors, []);
        await ctx.close();
    }

    // ---------- B. legacy lbs data migrates once; cardio untouched ----------
    {
        const { ctx, page, errors } = await newPage(browser);
        await page.goto(url);
        await page.evaluate(() => {
            const wk = getWeekKey(-1);
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                dnaVersion: 1, unit: 'lbs', sessions: createDefaultGymDNA().sessions, isCustomized: true, updatedAt: Date.now() + 1000,
                logs: { [wk]: {
                    'session-1': { completed: true, exercises: { 'ex-101': [{ weight: '135', reps: '10', done: true }] } },
                    'session-4': { completed: true, exercises: { 'ex-401': [{ weight: '300', reps: '20', done: true }] } }
                } }
            }));
        });
        await page.reload();
        const migrated = await page.evaluate(() => {
            const wk = getWeekKey(-1);
            return [state.logs[wk]['session-1'].exercises['ex-101'][0].weight, state.logs[wk]['session-4'].exercises['ex-401'][0].weight];
        });
        check('B1 lbs weight migrated to kg', migrated[0], '61.235');
        check('B2 cardio value untouched', migrated[1], '300');
        check('B3 PB still reads 135 lbs', await page.textContent('#pb-ex-101'), 'PB: 135lbs × 10');
        check('B errors', errors, []);
        await ctx.close();
    }

    // ---------- C/D. last-time hints + history (seeded data) ----------
    {
        const { ctx, page, errors } = await newPage(browser);
        await page.goto(url);
        await page.evaluate(() => {
            const wk1 = getWeekKey(-1), wk2 = getWeekKey(-2);
            const mon1 = getWeekMonday(-1);
            const thu1 = new Date(mon1.getFullYear(), mon1.getMonth(), mon1.getDate() + 3);
            const mk = (w, r) => ({ weight: String(w), reps: String(r), done: true });
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                dnaVersion: 2, unit: 'kg', sessions: createDefaultGymDNA().sessions, isCustomized: true, updatedAt: Date.now() + 1000,
                logs: {
                    [wk2]: { 'session-1': { completed: true, hiitDone: true, hiitCals: '110', hiitWatts: '650', date: formatDateKey(getWeekMonday(-2)),
                        exercises: { 'ex-101': [mk(57.5, 10), mk(57.5, 9), mk(57.5, 8)] } } },
                    [wk1]: {
                        'session-1': { completed: true, hiitDone: true, hiitCals: '118', hiitWatts: '700', date: formatDateKey(mon1),
                            exercises: {
                                'ex-101': [mk(60, 10), mk(60, 10), mk(60, 10)],
                                'ex-102': [mk(20, 12), mk(20, 11), mk(20, 10)],
                                'ex-205': [mk(12, 12)]
                            } },
                        'session-2': { completed: false, hiitDone: true, exercises: { 'ex-201': [mk(55, 10), mk(55, 9)] } },
                        'session-3': { completed: true, date: formatDateKey(thu1), exercises: { 'ex-303': [mk(100, 8), mk(105, 6)] } }
                    }
                }
            }));
        });
        await page.reload();

        const card = i => page.locator('#exercises-list-container > div').nth(i);
        check('C1 last time ex-101', await card(0).locator('p.font-mono').first().textContent(), '60kg × 10, 10, 10');
        check('C2 up suggestion ex-101', (await card(0).locator('button', { hasText: 'Try' }).textContent()).trim(), '↑ Try 62.5kg');
        check('C3 hold hint ex-102', (await card(1).innerText()).replace(/\s+/g, ' ').includes('Same weight aim for 12 reps'), true);
        check('C4 last-time date label', await card(0).locator('p').first().textContent(), t => /Last time · Mon,? \d+ \w+/.test(t));

        await card(0).locator('button', { hasText: 'Try' }).click();
        const weights = await page.evaluate(() => state.logs[getWeekKey(0)]['session-1'].exercises['ex-101'].map(s => s.weight));
        check('C5 suggestion applied to open sets', weights, ['62.5', '62.5', '62.5']);
        check('C6 applied chip shown', (await card(0).textContent()).includes('↑ 62.5kg ✓'), true);
        await card(0).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${outPrefix}-hints.png` });

        // lbs view of the same hint
        await page.click('#unit-toggle-btn');
        check('C7 last time in lbs', await card(1).locator('p.font-mono').first().textContent(), t => t.includes('lbs'));
        await page.click('#unit-toggle-btn');

        // History
        check('D1 history count label', await page.textContent('#history-count-label'), '4 logged');
        await page.click('text=Workout History');
        check('D2 history open', await page.isVisible('#history-modal'), true);
        check('D3 entries listed', await page.locator('#history-list details').count(), 4);
        const firstSummary = (await page.locator('#history-list details').first().locator('summary').textContent()).replace(/\s+/g, ' ');
        check('D4 newest first (Day 3 on Thu)', firstSummary, t => t.includes('Day 3') && t.includes('Thu') && t.includes('Shoulders & Legs'));
        check('D5 undated session shows week', (await page.locator('#history-list details').nth(2).textContent()).replace(/\s+/g, ' '), t => t.includes('Day 2') && t.includes('Week of'));
        await page.locator('#history-list details').nth(1).locator('summary').click();
        await page.waitForTimeout(150);
        await page.screenshot({ path: `${outPrefix}-history.png` });
        check('D6 expanded details', (await page.locator('#history-list details').nth(1).textContent()).replace(/\s+/g, ' '),
            t => t.includes('Barbell / Dumbbell Bench Press') && t.includes('60kg × 10, 10, 10') && t.includes('🔥 118 kcal / 700W'));
        check('D7 removed/moved exercise still named', (await page.locator('#history-list details').nth(1).textContent()), t => t.includes('Incline Dumbbell Hammer Curls'));

        await page.click('#history-filters >> text=2. Back & Bis');
        check('D8 filter Day 2', await page.locator('#history-list details').count(), 1);
        await page.click('#history-filters >> text=All');
        await page.locator('#history-list details').nth(1).locator('summary').click();

        await page.locator('#history-list details').nth(1).locator('button', { hasText: 'Open' }).click();
        await page.waitForTimeout(400);
        check('D9 modal closed', await page.isVisible('#history-modal'), false);
        check('D10 jumped to that week', await page.textContent('#active-week-badge'), '1w Ago');
        check('D11 session selected', await page.textContent('#active-session-title'), '1. Chest & Triceps');
        check('D12 past sets editable & shown', await page.locator('#exercises-list-container input[inputmode]').nth(0).inputValue(), '60');
        check('D13 past week shows hint vs 2 weeks ago', (await card(0).textContent()).includes('57.5kg × 10, 9, 8'), true);
        check('C/D errors', errors, []);
        await ctx.close();
    }

    const failed = checks.filter(c => !c.ok);
    checks.forEach(c => console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.actual)}${c.expected !== undefined ? ` want=${JSON.stringify(c.expected)}` : ''}`}`));
    console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
    if (checks.some(c => !c.ok)) process.exitCode = 1;
    await browser.close();
    server.close();
})();
