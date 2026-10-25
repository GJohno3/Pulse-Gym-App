// Expected session time: the estimate in the session header and on the day tabs, time left during
// a workout, and the "usually" figure from finished workouts.
// Run: node tests/session-time.test.js  (or npm test)
const path = require('path');
const { launch, serveDir, siteDir, outDir, createChecks, phonePage } = require('./harness');

const { check, report } = createChecks();

(async () => {
    const server = serveDir(siteDir);
    const browser = await launch();
    const { page } = await phonePage(browser);
    await page.goto(server.url());

    const estimate = () => page.textContent('#active-session-estimate');
    const card = i => page.locator('#exercises-list-container > div').nth(i);

    // ---------- The rule ----------
    const rule = await page.evaluate(() => {
        const sessions = createDefaultGymDNA().sessions;
        const pick = e => ({ hiit: e.hiitMin, work: e.workMin, rest: e.restMin, total: e.totalMin, sets: e.sets });
        const day1 = sessions[0];
        const linked = structuredClone(day1);
        linked.exercises[3].supersetId = 'ss-a';
        linked.exercises[4].supersetId = 'ss-a';
        linked.exercises[4].rest = 60;
        const halfDone = {
            hiitDone: true,
            exercises: Object.fromEntries(day1.exercises.map((ex, i) => [ex.id, [0, 1, 2].map(() => ({ weight: '', reps: '', done: i === 0 }))]))
        };
        return {
            perSet: ['8-10 reps', '12 reps', '60 secs', '30-45s', '15-20 mins (Log Cals & Watts)', '3 sets of 10', '']
                .map(target => workSecondsPerSet({ target }, 3)),
            day1: pick(estimateSessionTime(day1, null, '')),
            cardio: pick(estimateSessionTime(sessions[3], null, '')),
            superset: pick(estimateSessionTime(linked, null, '')),
            leftAfterOneExercise: estimateSessionTime(day1, halfDone, '').leftSec
        };
    });
    check('R1 work per set (timed targets use the top of the range)', rule.perSet, [45, 45, 60, 45, 400, 45, 45]);
    check('R2 Day 1: 10m HIIT + 15 sets + 14 rests of 90s', rule.day1, { hiit: 10, work: 11, rest: 21, total: 42, sets: 15 });
    check('R3 cardio: minute targets are the whole exercise', rule.cardio, { hiit: 0, work: 42, rest: 9, total: 51, sets: 7 });
    check('R4 superset rests once per round, for the longest rest', rule.superset.rest, 17);
    check('R5 time left: open sets and their rests only', rule.leftAfterOneExercise, 12 * 45 + 11 * 90);

    // ---------- Header and day tabs ----------
    check('E1 planned time before starting', await estimate(), '⏱ About 42 min: 10m HIIT + 15 sets (11m) + 21m rest');
    check('E2 tip still shown', await page.textContent('#active-session-subtitle'), t => t.startsWith('Tap ✓'));
    check('E3 day tabs show the expected time', await page.$$eval('#session-tabs-grid button p:last-child', ps => ps.map(p => p.textContent.trim())),
        ['5 exercises · ~42m', '5 exercises · ~42m', '5 exercises · ~42m', '3 exercises · ~51m']);
    await page.screenshot({ path: path.join(outDir, 'session-time-planned.png') });

    // Adding a set and linking a superset update it straight away
    await card(0).locator('button', { hasText: '+ Add Set' }).click();
    check('E4 extra set counted', await estimate(), '⏱ About 45 min: 10m HIIT + 16 sets (12m) + 23m rest');
    await card(0).locator('button', { hasText: '− Remove Last Set' }).click();
    await page.locator('#exercises-list-container button[onclick="toggleSupersetLink(3)"]').click();
    check('E5 superset rest counted per round', await estimate(), '⏱ About 38 min: 10m HIIT + 15 sets (11m) + 17m rest');
    await page.locator('#exercises-list-container button[onclick="toggleSupersetLink(3)"]').click();

    // HIIT plan length follows the chosen plan
    await page.selectOption('#hiit-plan-select', 'tabata');
    check('E6 Tabata warm-up', await estimate(), '⏱ About 36 min: 4m HIIT + 15 sets (11m) + 21m rest');
    await page.selectOption('#hiit-plan-select', '30-30');

    // ---------- During the workout ----------
    await card(0).locator('button[aria-label="Log set 1"]').click();
    await page.evaluate(() => document.getElementById('pb-celebration')?.remove());
    // 10m HIIT + 14 sets × 45s + 13 rests × 90s = 40 min
    check('L1 time left once started', await estimate(), t => /^⏱ About 40 min to go · done ≈ \d{2}:\d{2}$/.test(t));
    check('L2 finish time is now + time left', await page.evaluate(() => {
        const shown = document.getElementById('active-session-estimate').textContent.slice(-5);
        return [39, 40, 41].map(mins => formatClock(Date.now() + mins * 60000)).includes(shown);
    }), true);
    await page.click('#hiit-complete-btn');
    check('L3 HIIT done: 10 min less', await estimate(), t => t.startsWith('⏱ About 30 min to go'));
    await page.screenshot({ path: path.join(outDir, 'session-time-left.png') });
    await page.evaluate(() => {
        const sLog = state.logs[getWeekKey(0)]['session-1'];
        Object.values(sLog.exercises).forEach(sets => sets.forEach(st => { st.done = true; }));
        saveState();
        renderDashboard();
    });
    check('L4 everything ticked', await estimate(), '⏱ All sets done 💪');
    await page.click('#finish-session-top-btn');
    check('L5 completed: shows the plan', await estimate(), '⏱ Planned about 42 min');

    // ---------- "Usually" from finished workouts ----------
    await page.evaluate(() => {
        const sessions = createDefaultGymDNA().sessions;
        const finished = (mins, weeksAgo) => {
            const start = Date.now() - weeksAgo * 7 * 86400000;
            return { completed: true, startedAt: start, finishedAt: start + mins * 60000, exercises: {} };
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            dnaVersion: 2, unit: 'kg', sessions, isCustomized: true, updatedAt: Date.now() + 1000,
            logs: {
                [getWeekKey(-3)]: { 'session-1': finished(70, 3) },
                [getWeekKey(-2)]: { 'session-1': finished(50, 2), 'session-2': finished(60, 2) },
                [getWeekKey(-1)]: { 'session-1': finished(54, 1) }
            }
        }));
    });
    await page.reload();
    check('U1 usual time from finished workouts', await estimate(), '⏱ About 42 min: 10m HIIT + 15 sets (11m) + 21m rest · usually 58 min');
    await page.click('#session-tabs-grid button >> nth=1');
    check('U2 needs two finished workouts', await estimate(), t => !t.includes('usually'));
    await page.click('button[onclick="changeWeek(-1)"]');
    await page.click('#session-tabs-grid button >> nth=0');
    check('U3 past finished week shows its plan', await estimate(), '⏱ Planned about 42 min');

    // ---------- Edge cases ----------
    await page.evaluate(() => {
        state.weekOffset = 0;
        state.sessions[3].exercises = [];
        renderDashboard();
        selectSession('session-4');
    });
    check('X1 empty day: no estimate', await page.evaluate(() => document.getElementById('active-session-estimate').classList.contains('hidden')), true);
    check('X2 no errors / CSP violations', [page.errors, page.csp], [[], []]);

    report();
    await browser.close();
    server.close();
})();
