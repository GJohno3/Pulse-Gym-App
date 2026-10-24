// HIIT interval plans, warm-up sets (Plates & Warm-up) and the plateau alert.
// Run: node tests/gym-tools.test.js  (or npm test)
const path = require('path');
const { launch, serveDir, siteDir, outDir, createChecks, phonePage } = require('./harness');

const { check, report } = createChecks();

(async () => {
    const server = serveDir(siteDir);
    const browser = await launch();
    const { page } = await phonePage(browser);
    await page.goto(server.url());

    // Seed saved data (sessions from the defaults) and reload
    const seed = async (logsFn, extra = {}) => {
        await page.evaluate(([logsSrc, extra]) => {
            const mk = (w, r) => ({ weight: String(w), reps: String(r), done: true });
            const logs = new Function('mk', 'getWeekKey', `return (${logsSrc})(mk, getWeekKey);`)(mk, getWeekKey);
            const sessions = createDefaultGymDNA().sessions;
            Object.assign(sessions[0].exercises[0], extra);
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ dnaVersion: 2, unit: 'kg', sessions, logs, isCustomized: true, updatedAt: Date.now() + 1000 }));
        }, [logsFn.toString(), extra]);
        await page.reload();
    };
    const toast = () => page.locator('#toast-container').innerText();

    // ---------- HIIT intervals ----------
    const hiitFace = () => page.evaluate(() => ({
        plan: document.getElementById('hiit-plan-select').value,
        title: document.getElementById('hiit-title').textContent,
        kpi: document.getElementById('kpi-hiit-subtitle').textContent,
        round: document.getElementById('hiit-round-label').textContent,
        time: document.getElementById('hiit-timer-display').textContent,
        phase: document.getElementById('hiit-phase-pill').textContent
    }));
    check('H1 default plan unchanged', await hiitFace(), { plan: '30-30', title: '10 Min Assault Bike HIIT Warmup', kpi: '10m Pre-Weights Warmups', round: '10m HIIT', time: '10:00', phase: 'READY' });
    check('H2 presets offered', await page.$$eval('#hiit-plan-select option', os => os.map(o => o.textContent)), [
        '30s sprint / 30s easy × 10 · 10 min', '20s sprint / 40s easy × 10 · 10 min', '40s sprint / 20s easy × 10 · 10 min', 'Tabata: 20s sprint / 10s easy × 8 · 4 min', 'Custom…'
    ]);

    await page.selectOption('#hiit-plan-select', 'tabata');
    check('H3 Tabata applied', await hiitFace(), { plan: 'tabata', title: '4 Min Assault Bike HIIT Warmup', kpi: '4m Pre-Weights Warmups', round: '4m HIIT', time: '04:00', phase: 'READY' });
    check('H4 day tabs show the length', await page.locator('#session-tabs-grid button').nth(1).innerText(), t => t.includes('+4m HIIT'));
    check('H5 toast describes the plan', await toast(), t => t.includes('HIIT: 20s sprint / 10s easy × 8 (4m)'));
    await page.reload();
    check('H6 plan remembered', (await hiitFace()).time, '04:00');

    // Phases and beeps on a short custom plan: 3s easy + 5s sprint, 2 rounds = 16s
    await page.selectOption('#hiit-plan-select', 'custom');
    check('H7 custom row shown with current values', await page.evaluate(() => [
        !document.getElementById('hiit-custom-row').classList.contains('hidden'),
        ...['work', 'rest', 'rounds'].map(k => document.getElementById(`hiit-custom-${k}`).value)
    ]), [true, '20', '10', '8']);
    for (const [key, value] of [['work', '5'], ['rest', '3'], ['rounds', '2']]) {
        await page.fill(`#hiit-custom-${key}`, value);
        await page.dispatchEvent(`#hiit-custom-${key}`, 'change');
    }
    check('H8 custom plan applied', [(await hiitFace()).time, (await hiitFace()).round], ['00:16', '0:16 HIIT']);
    await page.fill('#hiit-custom-work', '2');
    await page.dispatchEvent('#hiit-custom-work', 'change');
    check('H9 invalid custom values refused', [(await toast()).includes('Sprint 5–300s'), await page.inputValue('#hiit-custom-work'), (await hiitFace()).time], [true, '5', '00:16']);

    // Drive the countdown with a fake clock, one second at a time
    await page.evaluate(() => {
        window.__beeps = [];
        window.playBeep = freq => window.__beeps.push(freq);
        const realNow = Date.now.bind(Date);
        window.__offset = 0;
        Date.now = () => realNow() + window.__offset;
    });
    await page.click('#hiit-start-btn');
    await page.evaluate(() => clearInterval(hiitTimerInterval) || (hiitTimerInterval = 1)); // tick by hand below
    const at = async seconds => {
        await page.evaluate(s => { window.__offset = s * 1000 + 50; tickHiitTimer(); }, seconds);
        return hiitFace();
    };
    const timeline = [];
    for (const s of [1, 2, 3, 4, 8, 11, 12]) {
        for (let t = timeline.length ? timeline[timeline.length - 1].s + 1 : 1; t < s; t++) await at(t);
        const face = await at(s);
        timeline.push({ s, phase: face.phase, round: face.round });
    }
    check('H10 easy first, then sprint, round by round', timeline.map(t => `${t.s}:${t.phase}:${t.round}`), [
        '1:3s CRUISE:Round 1/2', '2:3s CRUISE:Round 1/2', '3:5s SPRINT 🔥:Round 1/2', '4:5s SPRINT 🔥:Round 1/2',
        '8:3s CRUISE:Round 2/2', '11:5s SPRINT 🔥:Round 2/2', '12:5s SPRINT 🔥:Round 2/2'
    ]);
    for (let t = 13; t <= 16; t++) await at(t);
    check('H11 beeps: start, high for sprint, low for easy, long at the end', await page.evaluate(() => window.__beeps), [660, 980, 620, 980, 1040]);
    check('H12 finishing logs the warmup', [await page.evaluate(() => !!state.logs[getWeekKey(0)][state.activeSessionId].hiitDone), (await toast()).includes('0:16 Assault Bike HIIT complete!')], [true, true]);

    // Changing the plan mid-run restarts the timer (after a confirm)
    await page.evaluate(() => { window.__offset = 0; resetHiitTimer(); toggleHiitTimer(); });
    await page.selectOption('#hiit-plan-select', '30-30');
    check('H13 switching plans resets the timer', [(await hiitFace()).time, await page.evaluate(() => hiitTimerInterval)], ['10:00', null]);
    await page.reload();

    // ---------- Warm-up sets ----------
    const warmup = () => page.$$eval('#warmup-result .divide-y > div', rows => rows.map(r => [...r.querySelectorAll('span')].map(s => s.textContent.trim())));
    check('W1 button renamed', await page.locator('#exercises-list-container button', { hasText: 'Plates & warm-up' }).count(), 5);
    await page.evaluate(() => openPlatesModal('ex-101'));
    check('W2 modal title', await page.textContent('#plates-modal h3'), '🏋️ Plates & Warm-up');
    await page.fill('#plates-target', '100');
    check('W3 ramp to 100 kg on an Olympic bar', await warmup(), [
        ['W1', '20 kg × 10', 'Empty bar'], ['W2', '50 kg × 5', '15 each side'], ['W3', '70 kg × 3', '25 each side'], ['W4', '85 kg × 2', '25 + 5 + 2.5 each side']
    ]);
    check('W4 plates for the working weight still shown', await page.textContent('#plates-result'), t => t.includes('25 + 15'));
    await page.selectOption('#plates-bar', 'none');
    check('W5 no bar: 3-step ramp, no plates', await warmup(), [['W1', '50 kg × 8', ''], ['W2', '70 kg × 5', ''], ['W3', '85 kg × 2', '']]);
    await page.selectOption('#plates-bar', 'olympic');
    await page.fill('#plates-target', '20');
    check('W6 empty bar needs no warm-up', await page.textContent('#warmup-result'), t => t.includes('Light enough to start'));
    await page.fill('#plates-target', '');
    check('W7 nothing entered: no ramp', (await page.textContent('#warmup-result')).trim(), '');
    await page.evaluate(() => closeModal('plates-modal'));
    await page.click('#unit-toggle-btn');
    await page.evaluate(() => openPlatesModal('ex-101'));
    await page.fill('#plates-target', '225');
    check('W8 lbs ramp with lb plates', await warmup(), [
        ['W1', '45 lbs × 10', 'Empty bar'], ['W2', '115 lbs × 5', '35 each side'], ['W3', '160 lbs × 3', '45 + 10 + 2.5 each side'], ['W4', '190 lbs × 2', '45 + 25 + 2.5 each side']
    ]);
    await page.locator('#plates-modal .modal-sheet').screenshot({ path: path.join(outDir, 'gym-tools-warmup.png') });
    await page.evaluate(() => closeModal('plates-modal'));
    await page.click('#unit-toggle-btn');

    // ---------- Plateau alert ----------
    const plateauStrip = () => page.locator('[data-plateau="ex-101"]');
    const hasPlateau = async () => (await page.locator('[data-plateau]').count()) > 0;

    // Best 70×8 four weeks ago, then three sessions that don't beat it
    const stalled = (mk, wk) => ({
        [wk(-4)]: { 'session-1': { completed: true, exercises: { 'ex-101': [mk(70, 8), mk(70, 8)] } } },
        [wk(-3)]: { 'session-1': { completed: true, exercises: { 'ex-101': [mk(70, 6), mk(70, 6)] } } },
        [wk(-2)]: { 'session-1': { completed: true, exercises: { 'ex-101': [mk(67.5, 8), mk(67.5, 8)] } } },
        [wk(-1)]: { 'session-1': { completed: true, exercises: { 'ex-101': [mk(70, 7), mk(70, 7)] } } }
    });
    await seed(stalled);
    check('P1 stalled lift flagged', await hasPlateau(), true);
    check('P2 suggests a lighter week (90%, to 2.5 kg)', await plateauStrip().locator('button', { hasText: 'Try' }).textContent(), 'Try 62.5kg');
    check('P3 only on that lift', await page.locator('#exercises-list-container > div', { hasText: '⚠️ Plateau' }).count(), 1);
    await page.locator('#exercises-list-container > div').first().screenshot({ path: path.join(outDir, 'gym-tools-plateau.png') });
    await plateauStrip().locator('button', { hasText: 'Try' }).click();
    check('P4 lighter week applied to open sets', await page.evaluate(() => state.logs[getWeekKey(0)]['session-1'].exercises['ex-101'].filter(s => !s.done).map(s => s.weight)), w => w.length > 0 && w.every(x => x === '62.5'));
    check('P5 toast + tick', [(await toast()).includes('Lighter week: remaining sets at 62.5kg'), (await plateauStrip().innerText()).includes('62.5kg ✓')], [true, true]);
    await plateauStrip().locator('button', { hasText: 'Hide' }).click();
    check('P6 hidden for 3 weeks', [await hasPlateau(), await page.evaluate(() => state.sessions[0].exercises[0].plateauHiddenUntil === getWeekKey(3))], [false, true]);
    await page.reload();
    check('P7 stays hidden after reload', await hasPlateau(), false);

    await seed((mk, wk) => ({
        [wk(-4)]: { 'session-1': { completed: true, exercises: { 'ex-101': [mk(70, 8)] } } },
        [wk(-3)]: { 'session-1': { completed: true, exercises: { 'ex-101': [mk(70, 6)] } } },
        [wk(-2)]: { 'session-1': { completed: true, exercises: { 'ex-101': [mk(67.5, 8)] } } },
        [wk(-1)]: { 'session-1': { completed: true, exercises: { 'ex-101': [mk(72.5, 8)] } } }
    }));
    check('P8 new best last time: no alert', await hasPlateau(), false);
    await seed((mk, wk) => ({
        [wk(-3)]: { 'session-1': { completed: true, exercises: { 'ex-101': [mk(70, 8)] } } },
        [wk(-2)]: { 'session-1': { completed: true, exercises: { 'ex-101': [mk(70, 6)] } } },
        [wk(-1)]: { 'session-1': { completed: true, exercises: { 'ex-101': [mk(67.5, 8)] } } }
    }));
    check('P9 too few sessions: no alert', await hasPlateau(), false);
    await seed((mk, wk) => ({
        [wk(-8)]: { 'session-1': { completed: true, exercises: { 'ex-101': [mk(70, 8)] } } },
        [wk(-7)]: { 'session-1': { completed: true, exercises: { 'ex-101': [mk(70, 6)] } } },
        [wk(-6)]: { 'session-1': { completed: true, exercises: { 'ex-101': [mk(67.5, 8)] } } },
        [wk(-5)]: { 'session-1': { completed: true, exercises: { 'ex-101': [mk(70, 7)] } } }
    }));
    check('P10 not trained lately: no alert', await hasPlateau(), false);
    await seed((mk, wk) => ({
        [wk(-4)]: { 'session-1': { completed: true, exercises: { 'ex-101': [mk(80, 8)] } } },
        [wk(-3)]: { 'session-1': { completed: true, exercises: { 'ex-101': [mk(70, 9)] } } },
        [wk(-2)]: { 'session-1': { completed: true, exercises: { 'ex-101': [mk(70, 9)] } } },
        [wk(-1)]: { 'session-1': { completed: true, exercises: { 'ex-101': [mk(70, 10), mk(70, 10)] } } }
    }));
    check('P11 "add weight" hint wins over the alert', [await hasPlateau(), await page.locator('#exercises-list-container > div').first().locator('button', { hasText: '↑ Try' }).count()], [false, 1]);
    await seed(stalled, { plateauHiddenUntil: '"><img src=x>' });
    check('P12 bad hide date from a backup ignored', [await hasPlateau(), await page.evaluate(() => 'plateauHiddenUntil' in state.sessions[0].exercises[0])], [true, false]);

    check('X no errors / CSP violations', [page.errors, page.csp], [[], []]);
    report();
    await browser.close();
    server.close();
})();
