// Everyday flows: typing keeps focus, ticking a set logs it and starts the rest timer, timers tick and
// catch up after the screen was locked, the app opens offline, and the HTML export round-trips.
// Run: node tests/core-flows.test.js  (or npm test)
const fs = require('fs');
const path = require('path');
const { launch, serveDir, siteDir, outDir, createChecks, phonePage } = require('./harness');

const { check, report } = createChecks();

(async () => {
    const server = serveDir(siteDir);
    const browser = await launch();

    // ---------- Logging a set ----------
    {
        const { ctx, page } = await phonePage(browser);
        await page.goto(server.url());
        const weight = page.locator('#exercises-list-container input[inputmode]').nth(0);
        const reps = page.locator('#exercises-list-container input[inputmode]').nth(1);
        await weight.tap();
        await weight.fill('60');
        await reps.tap();
        await page.waitForTimeout(150);
        check('C1 focus stays on reps after typing a weight', await reps.evaluate(el => el === document.activeElement), true);
        await reps.fill('10');
        await reps.blur();
        await page.locator('button[aria-label="Log set 1"]').first().tap();
        await page.waitForTimeout(200);
        check('C2 ticked set counts towards volume', await page.textContent('#kpi-weekly-volume'), '600 kg');
        check('C3 rest timer started', await page.evaluate(() => restEndsAt > Date.now()), true);
        check('C4 no section nested inside another', await page.evaluate(() => document.querySelectorAll('section section').length), 0);
        check('C5 no errors / CSP violations', [page.errors, page.csp], [[], []]);
        await page.screenshot({ path: path.join(outDir, 'core-flows-top.png') });
        await ctx.close();
    }

    // ---------- Timers ----------
    {
        const { ctx, page } = await phonePage(browser);
        await page.goto(server.url());
        await page.click('#hiit-start-btn');
        await page.waitForTimeout(2300);
        check('T1 HIIT timer counts down', await page.textContent('#hiit-timer-display'), t => ['09:58', '09:57'].includes(t));
        await page.click('#rest-bar-90');
        await page.waitForTimeout(1200);
        check('T2 rest timer counts down', await page.textContent('#rest-timer-display'), t => ['01:29', '01:28'].includes(t));
        await ctx.close();
    }
    {
        // Phone locked for 65 s straight after starting: the countdown catches up from the clock
        const { ctx, page } = await phonePage(browser);
        await page.goto(server.url());
        await page.click('#hiit-start-btn');
        await page.evaluate(() => {
            const realNow = Date.now.bind(Date);
            Date.now = () => realNow() + 65000;
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await page.waitForTimeout(300);
        check('T3 HIIT catches up after the screen was locked', await page.textContent('#hiit-timer-display'), t => ['08:55', '08:54'].includes(t));
        check('T4 right phase after catching up', await page.textContent('#hiit-phase-pill'), '30s CRUISE');
        await ctx.close();
    }

    // ---------- Offline ----------
    {
        const ctx = await browser.newContext({ serviceWorkers: 'allow' });
        await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
        const page = await ctx.newPage();
        await page.goto(server.url());
        await page.evaluate(() => navigator.serviceWorker.ready);
        await page.reload();
        await page.waitForTimeout(500);
        check('O1 service worker in control', await page.evaluate(() => !!navigator.serviceWorker.controller), true);
        check('O2 app files cached', await page.evaluate(async () => (await (await caches.open('pulsegym-v2')).keys()).map(r => new URL(r.url).pathname).sort()),
            k => ['/', '/styles.css', '/manifest.webmanifest', '/apple-touch-icon.png'].every(p => k.includes(p)));
        await ctx.setOffline(true);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(500);
        check('O3 opens with no signal', [await page.title(), await page.textContent('#kpi-sessions-done'), await page.locator('#session-tabs-grid button').count()],
            ['PulseGym — 4-Day Split & Assault Bike HIIT Tracker', '0 / 4', 4]);
        check('O4 styled offline', await page.evaluate(() => getComputedStyle(document.getElementById('backup-modal')).display), 'none');
        await ctx.close();
    }

    // ---------- Export round trip ----------
    {
        const { ctx, page } = await phonePage(browser, { acceptDownloads: true });
        await page.goto(server.url());
        await page.evaluate(() => {
            state.sessions[0].exercises[0].name = 'Bench $& </script> test';
            saveState();
            renderDashboard();
        });
        const weight = page.locator('#exercises-list-container input[inputmode]').nth(0);
        await weight.fill('82,5');
        await weight.blur();
        await page.locator('button[aria-label="Log set 1"]').first().click();
        // Move an exercise to another day via the edit screen
        await page.evaluate(() => openEditExerciseModal('ex-102'));
        await page.selectOption('#exercise-session-input', 'session-3');
        await page.click('#exercise-modal button[type=submit]');
        check('E1 exercise moved to Day 3', await page.evaluate(() => [state.sessions[0].exercises.some(e => e.id === 'ex-102'), state.sessions[2].exercises.some(e => e.id === 'ex-102')]), [false, true]);
        await page.evaluate(() => openBackupModal());
        const [download] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => downloadEmbeddedHtmlApp())]);
        const exportDir = path.join(outDir, 'core-flows-export');
        fs.mkdirSync(exportDir, { recursive: true });
        await download.saveAs(path.join(exportDir, 'index.html'));
        await ctx.close();

        // A fresh browser (empty storage) opens the exported file on its own
        const exportServer = serveDir(exportDir);
        const fresh = await phonePage(browser);
        await fresh.page.goto(exportServer.url());
        const exported = await fresh.page.evaluate(() => {
            const wk = Object.keys(state.logs)[0];
            return {
                firstName: state.sessions[0].exercises[0].name,
                set: state.logs[wk]?.['session-1']?.exercises?.['ex-101']?.[0],
                backupModalHidden: document.getElementById('backup-modal').classList.contains('hidden'),
                movedKept: state.sessions[2].exercises.some(e => e.id === 'ex-102')
            };
        });
        check('E2 exported data intact (tricky name, comma decimal)', exported, {
            firstName: 'Bench $& </script> test', set: { weight: '82.5', reps: '', done: true, auto: false }, backupModalHidden: true, movedKept: true
        });
        check('E3 exported file has no errors', fresh.page.errors, []);
        await fresh.ctx.close();
        exportServer.close();
    }

    report();
    await browser.close();
    server.close();
})();
