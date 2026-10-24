// Weekly summary card + supersets. Usage: node summary-superset-test.js <siteDir> <outPrefix>
const { chromium, devices, siteDir: defaultSiteDir, outDir } = require('./harness');
const http = require('http');
const fs = require('fs');
const path = require('path');

const siteDir = process.argv[2] || defaultSiteDir;
const outPrefix = process.argv[3] || path.join(outDir, 'summary-supersets');

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
    const errors = [], csp = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text()); });
    page.on('dialog', d => d.accept());
    await page.route(/fonts\./, r => r.abort());
    await page.goto(`http://localhost:${server.address().port}/`);

    const seed = async (build) => {
        await page.evaluate(build);
        await page.reload();
    };
    const tiles = () => page.$$eval('#weekly-summary-grid > div', els => els.map(el => [...el.querySelectorAll('p')].map(p => p.textContent.trim())));
    const verdict = () => page.textContent('#weekly-summary-verdict');

    // ---------- Weekly summary ----------
    await seed(() => {
        const t0 = Date.now() - 3 * 86400000;
        const wk = o => getWeekKey(o);
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            dnaVersion: 2, unit: 'kg', sessions: createDefaultGymDNA().sessions, isCustomized: true, updatedAt: Date.now() + 1000,
            logs: {
                [wk(-2)]: { 'session-1': { completed: false, exercises: {
                    'ex-101': [{ weight: '60', reps: '10', done: true }],
                    'ex-102': [{ weight: '40', reps: '10', done: true }] } } },
                [wk(-1)]: { 'session-1': { completed: true, hiitDone: true, hiitCals: '100', startedAt: t0, finishedAt: t0 + 50 * 60000, exercises: {
                    'ex-101': [{ weight: '62.5', reps: '10', done: true }, { weight: '62.5', reps: '8', done: true }],
                    'ex-102': [{ weight: '40', reps: '10', done: true }, { weight: '40', reps: '10', done: true }] } } },
                [wk(0)]: {
                    'session-1': { completed: true, hiitDone: true, hiitCals: '120', startedAt: t0, finishedAt: t0 + 70 * 60000, exercises: {
                        'ex-101': [{ weight: '65', reps: '10', done: true }],
                        'ex-102': [{ weight: '40', reps: '10', done: true }, { weight: '40', reps: '9', done: true }] } },
                    'session-2': { completed: false, exercises: { 'ex-201': [{ weight: '50', reps: '10', done: true }] } }
                }
            }
        }));
    });
    // This week: bench heavier (up), incline one rep short (not up), pulldowns first time (not counted)
    check('W1 subtitle', await page.textContent('#weekly-summary-subtitle'), 'This week vs last week');
    check('W2 tiles this week', await tiles(), [
        ['Sessions', '1/4', 'Same', 'was 1/4'],
        ['Lifts up', '1/2', '▼ 1', 'was 2/2'],
        ['Sets', '4', 'Same', 'was 4'],
        ['Time', '1h 10m', '▲ 40%', 'was 50m'],
        ['PBs', '1', 'Same', 'was 1'],
        ['HIIT kcal', '120', '▲ 20%', 'was 100']
    ]);
    check('W3 verdict', await verdict(), '1 of 2 lifts beat last time 💪 · 3 sessions to go');
    check('W4 progress bar shows the share', await page.evaluate(() => [document.getElementById('weekly-summary-progress').classList.contains('hidden'), document.getElementById('weekly-summary-bar').style.width]), [false, '50%']);
    check('W5 up tone is green', await page.$eval('#weekly-summary-grid > div:nth-child(4) p:nth-child(3)', el => el.className.includes('text-gym-600')), true);
    check('W5b down tone stays neutral', await page.$eval('#weekly-summary-grid > div:nth-child(2) p:nth-child(3)', el => el.className.includes('text-slate-400')), true);
    check('K1 lifts card', [await page.textContent('#kpi-lifts-up'), await page.textContent('#kpi-lift-pbs')], ['1 / 2', '1 PB']);
    await page.locator('#weekly-summary').scrollIntoViewIfNeeded();
    await page.locator('#weekly-summary').screenshot({ path: `${outPrefix}-summary.png` });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${outPrefix}-kpis.png` });

    // Past week: compared with the week before it
    await page.click('button[onclick="changeWeek(-1)"]');
    check('W6 past-week subtitle', await page.textContent('#weekly-summary-subtitle'), t => /^Week of \d+ \w+ vs the week before$/.test(t));
    check('W7 past-week tiles', (await tiles()).map(t => t[2]), ['▲ New', '▲ New', '▲ 2', '▲ New', '▲ New', '▲ New']);
    check('W8 past-week verdict', await verdict(), 'Both lifts beat last time 💪');
    check('K2 lifts card follows the week', await page.textContent('#kpi-lifts-up'), '2 / 2');
    await page.click('button[onclick="changeWeek(1)"]');

    // lbs: same comparison
    await page.click('#unit-toggle-btn');
    check('W9 lifts unchanged in lbs', [await page.textContent('#kpi-lifts-up'), (await tiles())[1][1]], ['1 / 2', '1/2']);
    await page.click('#unit-toggle-btn');

    // Mid-week with nothing comparable yet: falls back to sessions
    await seed(() => {
        const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
        delete s.logs[getWeekKey(0)]['session-1'];
        s.updatedAt = Date.now() + 2000;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    });
    check('W10 nothing to compare: sessions verdict', await verdict(), '0 of 4 sessions done (1 last week)');
    check('W11 no bar, card shows a dash', [await page.evaluate(() => document.getElementById('weekly-summary-progress').classList.contains('hidden')), await page.textContent('#kpi-lifts-up')], [true, '–']);
    check('W12 down tone stays neutral', await page.$eval('#weekly-summary-grid > div:nth-child(2) p:nth-child(3)', el => [el.textContent, el.className.includes('text-slate-400')]), ['▼ 2', true]);

    // Live update when a set is ticked
    await page.click('#session-tabs-grid button >> nth=1');
    const before = (await tiles())[2][1];
    await page.locator('button[aria-label="Log set 2"]').first().click();
    check('W13 ticking a set updates the card', [before, (await tiles())[2][1]], ['1', '2']);
    await page.click('#session-tabs-grid button >> nth=0');
    const benchInputs = page.locator('#exercises-list-container > div').first().locator('input[inputmode]');
    await benchInputs.nth(0).fill('65'); await benchInputs.nth(0).blur();
    await benchInputs.nth(1).fill('8'); await benchInputs.nth(1).blur();
    await page.locator('button[aria-label="Log set 1"]').first().click();
    check('W13b beating last time updates both cards', [await page.textContent('#kpi-lifts-up'), await verdict()], ['1 / 1', '1 of 1 lift beat last time 💪 · 4 sessions to go']);

    // The rule itself (state swapped in-page, nothing saved)
    const rules = await page.evaluate(() => {
        const saved = state.logs;
        const s = (weight, reps, done = true) => ({ weight: String(weight), reps: String(reps), done });
        const run = (before, now, beforeWeek = -1) => {
            state.logs = {
                ...(before ? { [getWeekKey(beforeWeek)]: { 'session-1': { exercises: { 'ex-101': before } } } } : {}),
                [getWeekKey(0)]: { 'session-1': { exercises: { 'ex-101': now } } }
            };
            const r = getLiftProgress(getWeekKey(0));
            return `${r.up}/${r.total}`;
        };
        const out = {
            heavierFewerReps: run([s(60, 10)], [s(62.5, 6)]),
            heavierTopSetOnly: run([s(62.5, 8), s(62.5, 8)], [s(65, 3), s(60, 10)]),
            sameWeightMoreReps: run([s(60, 10), s(60, 8)], [s(60, 10), s(60, 9)]),
            sameWeightExtraSet: run([s(60, 10), s(60, 10)], [s(60, 10), s(60, 10), s(60, 5)]),
            sameWeightFewerReps: run([s(60, 10), s(60, 8)], [s(60, 10), s(60, 7)]),
            identical: run([s(60, 10)], [s(60, 10)]),
            lighterMoreReps: run([s(60, 8)], [s(55, 15)]),
            bodyweightMoreReps: run([s('', 8)], [s('', 10)]),
            untickedIgnored: run([s(60, 10)], [s(70, 10, false)]),
            lastTimeWeeksAgo: run([s(60, 10)], [s(62.5, 10)], -3),
            firstEver: run(null, [s(60, 10)])
        };
        state.logs = saved;
        return out;
    });
    check('L1 lifts-up rule', rules, {
        heavierFewerReps: '1/1', heavierTopSetOnly: '1/1', sameWeightMoreReps: '1/1', sameWeightExtraSet: '1/1',
        sameWeightFewerReps: '0/1', identical: '0/1', lighterMoreReps: '0/1', bodyweightMoreReps: '1/1',
        untickedIgnored: '0/0', lastTimeWeeksAgo: '1/1', firstEver: '0/0'
    });

    // Empty
    await seed(() => { localStorage.clear(); sessionStorage.clear(); });
    check('W14 empty verdict', await verdict(), 'Log a workout to start comparing weeks.');
    check('W15 empty: no bar, dashes', [await page.evaluate(() => document.getElementById('weekly-summary-progress').classList.contains('hidden')), (await tiles()).map(t => t[2]).join('')], [true, '––––––']);
    check('K3 empty lifts card', [await page.textContent('#kpi-lifts-up'), await page.textContent('#kpi-lift-pbs')], ['–', '0 PBs']);

    // ---------- Supersets ----------
    const card = i => page.locator('#exercises-list-container > div').nth(i);
    const chip = i => card(i).locator('button[onclick^="toggleSupersetLink"]');
    const badge = i => card(i).locator('span', { hasText: 'Superset' }).first();
    const ids = () => page.evaluate(() => state.sessions[0].exercises.map(e => e.supersetId || null));
    const sameGroup = (list, a, b) => !!list[a] && list[a] === list[b];

    await page.click('#session-tabs-grid button >> nth=0');
    check('S1 one card per exercise (chips inside cards)', await page.locator('#exercises-list-container > div').count(), 5);
    check('S2 chips between exercises', await page.locator('#exercises-list-container button[onclick^="toggleSupersetLink"]').count(), 4);
    check('S3 unlinked chip', [await chip(3).textContent(), await chip(3).getAttribute('aria-pressed')], ['+ Superset', 'false']);

    await chip(3).click(); // Tricep Pushdowns + Overhead Extensions
    let g = await ids();
    check('S4 linked in data', sameGroup(g, 3, 4) && !g[2], true);
    check('S5 badges', [await badge(3).textContent(), await badge(4).textContent()], ['Superset A · 1/2', 'Superset A · 2/2']);
    check('S6 linked chip', [await chip(3).textContent(), await chip(3).getAttribute('aria-pressed')], ['🔗 Superset', 'true']);
    await page.evaluate(() => { findExercise('ex-104').ex.rest = 120; saveState(); renderDashboard(); });
    const restLabels = await page.evaluate(() => [3, 4].map(i => [...document.querySelectorAll('#exercises-list-container > div')[i].querySelectorAll('span')].map(s => s.textContent).find(t => t.startsWith('Rest')) || null));
    check('S7 rest shown once, longest, after round', restLabels, [null, 'Rest 2:00 after round']);
    await card(3).screenshot({ path: `${outPrefix}-superset-a.png` });

    // Round logic
    const rest = () => page.evaluate(() => ({ endsAt: restEndsAt, duration: restDuration }));
    await page.evaluate(() => { if (restTimerInterval) clearInterval(restTimerInterval); restTimerInterval = null; restEndsAt = 0; });
    await card(3).locator('button[aria-label="Log set 1"]').click();
    check('S8 first exercise of round: no rest yet', (await rest()).endsAt, 0);
    check('S9 cue toast', await page.locator('#toast-container').innerText(), t => t.includes('Superset → Overhead Tricep Extensions / Skullcrushers · set 1'));
    check('S10 next set highlighted', await page.evaluate(() => document.getElementById('set-row-ex-105-0').classList.contains('ring-2')), true);
    await page.screenshot({ path: `${outPrefix}-cue.png` });
    await card(4).locator('button[aria-label="Log set 1"]').click();
    let r = await rest();
    check('S11 round done: rest starts, longest rest', [r.endsAt > Date.now(), r.duration], [true, 120]);

    // Any order: B2 first, then A2
    const endsBefore = r.endsAt;
    await card(4).locator('button[aria-label="Log set 2"]').click();
    check('S12 B before A: no new rest', (await rest()).endsAt, endsBefore);
    await page.waitForTimeout(50);
    await card(3).locator('button[aria-label="Log set 2"]').click();
    check('S13 then A: rest restarts', (await rest()).endsAt > endsBefore, true);

    // Unequal set counts: a 4th set on A only completes its round alone
    await card(3).locator('button', { hasText: '+ Add Set' }).click();
    await page.evaluate(() => { restEndsAt = 0; });
    await card(3).locator('button[aria-label="Log set 4"]').click();
    check('S14 extra set with no partner: rest starts', (await rest()).endsAt > Date.now(), true);

    // Unticking never starts a timer
    await page.evaluate(() => { restEndsAt = 0; });
    await card(3).locator('button[aria-label="Log set 4"]').click();
    check('S15 untick: no rest', (await rest()).endsAt, 0);

    // Tri-set and a second superset
    await chip(2).click();
    g = await ids();
    check('S16 tri-set', sameGroup(g, 2, 3) && sameGroup(g, 3, 4), true);
    check('S17 tri-set badges', [await badge(2).textContent(), await badge(4).textContent()], ['Superset A · 1/3', 'Superset A · 3/3']);
    await chip(0).click();
    check('S18 lettered top to bottom', [await badge(0).textContent(), await badge(1).textContent(), await badge(2).textContent()], ['Superset A · 1/2', 'Superset A · 2/2', 'Superset B · 1/3']);
    g = await ids();
    check('S19 groups stay separate', g[1] !== g[2], true);

    // Unlink in the middle of the tri-set: top one leaves, other two stay together
    await chip(2).click();
    g = await ids();
    check('S20 split tri-set', [g[2], sameGroup(g, 3, 4)], [null, true]);

    // Moving an exercise out breaks its superset
    await card(3).locator('button[title="Move Up"]').click();
    g = await ids();
    check('S21 moved out: superset dissolved', [g[2], g[3], g[4]], [null, null, null]);
    check('S22 other superset intact', sameGroup(g, 0, 1), true);

    // Deleting the middle of a tri-set keeps the rest linked
    await page.evaluate(() => { state.sessions[0].exercises = createDefaultGymDNA().sessions[0].exercises; saveState(); renderDashboard(); });
    await chip(2).click();
    await chip(3).click();
    await card(3).locator('button[title="Remove Exercise"]').click();
    g = await ids();
    check('S23 delete middle: ends still linked', [g.length, sameGroup(g, 2, 3)], [4, true]);

    // Persists across reload
    await page.reload();
    check('S24 persists after reload', await badge(2).textContent(), 'Superset A · 1/2');

    // Moving to another day leaves the superset behind
    await card(2).locator('button[title="Edit Exercise"]').click();
    await page.selectOption('#exercise-session-input', 'session-2');
    await page.click('#exercise-modal button[type=submit]');
    const moved = await page.evaluate(() => ({
        day1: state.sessions[0].exercises.map(e => e.supersetId || null),
        movedHasId: 'supersetId' in state.sessions[1].exercises[state.sessions[1].exercises.length - 1]
    }));
    check('S25 moved to another day: both sides cleaned', [moved.day1.every(x => x === null), moved.movedHasId], [true, false]);

    // Imported data: bad ids removed, singletons dropped, repeated ids split
    await page.evaluate(() => {
        const d = createDefaultGymDNA();
        const ex = d.sessions[0].exercises;
        ex[0].supersetId = '"><img src=x>'; ex[1].supersetId = '"><img src=x>';
        ex[2].supersetId = 'lonely';
        ex[3].supersetId = 'dup'; ex[4].supersetId = 'dup';
        d.sessions[1].exercises[0].supersetId = 'dup'; d.sessions[1].exercises[1].supersetId = 'dup';
        applyImportedState(d);
    });
    const imp = await page.evaluate(() => state.sessions.slice(0, 2).map(s => s.exercises.map(e => e.supersetId || null)));
    check('S26 import: bad + lonely ids removed', imp[0].slice(0, 3), [null, null, null]);
    check('S27 import: valid pairs kept', [imp[0][3] === imp[0][4], imp[1][0] === imp[1][1], !!imp[0][3]], [true, true, true]);

    check('X no CSP violations', csp, []);
    check('X errors', errors, []);
    checks.forEach(c => console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.actual)}${c.expected !== undefined ? ` want=${JSON.stringify(c.expected)}` : ''}`}`));
    console.log(`\n${checks.filter(c => c.ok).length}/${checks.length} passed`);
    if (checks.some(c => !c.ok)) process.exitCode = 1;
    await browser.close();
    server.close();
})();
