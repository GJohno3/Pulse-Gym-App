// Push notifications in the app: Reminders panel flows, with /api/push/* answered by the real server
// logic (netlify/lib/push-core.mjs) on an in-memory store. iPhone's permission prompt and push
// subscription are simulated. Usage: node push-ui-test.js <siteDir> <outPrefix>
const { chromium, devices, siteDir: defaultSiteDir, outDir } = require('./harness');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');

const siteDir = process.argv[2] || defaultSiteDir;
const outPrefix = process.argv[3] || path.join(outDir, 'push-ui');
const repo = path.join(siteDir, '..');
const webpush = createRequire(path.join(repo, 'package.json'))('web-push');

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

function memoryStore() {
    const data = new Map();
    return {
        data,
        async get(key) { return data.has(key) ? structuredClone(data.get(key)) : null; },
        async setJSON(key, value, opts = {}) { if (opts.onlyIfNew && data.has(key)) return { modified: false }; data.set(key, structuredClone(value)); return { modified: true }; },
        async delete(key) { data.delete(key); },
        async list({ prefix = '' } = {}) { return { blobs: [...data.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) }; }
    };
}

(async () => {
    const core = await import(path.join(repo, 'netlify/lib/push-core.mjs'));
    const store = memoryStore();
    const testPushes = [];
    const apiLog = [];
    let failSubscribe = false;

    // Phone-side keys for the simulated subscription (valid formats, so the server's checks apply)
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const phoneKeys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };

    const browser = await chromium.launch();

    async function newPage({ pushSupported = true, standalone = true } = {}) {
        const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'], viewport: { width: 402, height: 874 }, locale: 'en-GB', timezoneId: 'Europe/London' });
        await ctx.route(/fonts\./, r => r.abort());
        await ctx.route('**/api/push/**', async route => {
            const req = route.request();
            const action = new URL(req.url()).pathname.split('/').pop();
            apiLog.push(action);
            const body = req.postData() ? JSON.parse(req.postData()) : null;
            let result;
            try {
                if (action === 'key') result = await core.handleKey(store, { origin: 'https://pulse.example', generateKeys: () => webpush.generateVAPIDKeys() });
                else if (action === 'subscribe' && failSubscribe) throw new core.RequestError(503, 'Service unavailable');
                else if (action === 'subscribe') result = await core.handleSubscribe(store, body);
                else if (action === 'unsubscribe') result = await core.handleUnsubscribe(store, body);
                else if (action === 'test') result = await core.handleTest(store, body, async (sub, payload) => { testPushes.push(payload); });
                await route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.body) });
            } catch (e) {
                await route.fulfill({ status: e.status || 500, contentType: 'application/json', body: JSON.stringify({ error: e.message }) });
            }
        });
        // Simulated iPhone: Home Screen app, permission prompt and push subscription (kept in localStorage across reloads)
        await ctx.addInitScript(({ pushSupported, standalone, phoneKeys }) => {
            const stub = () => JSON.parse(localStorage.getItem('__pushstub') || '{"permission":"default","next":"granted","sub":null,"subscribes":0,"unsubscribes":0}');
            const save = s => localStorage.setItem('__pushstub', JSON.stringify(s));
            const realMatchMedia = window.matchMedia.bind(window);
            window.matchMedia = q => (q === '(display-mode: standalone)' ? { matches: standalone, media: q, addEventListener() {}, removeEventListener() {} } : realMatchMedia(q));
            if (!pushSupported) { delete window.PushManager; return; }
            Object.defineProperty(Notification, 'permission', { get: () => stub().permission, configurable: true });
            Notification.requestPermission = async () => { const s = stub(); s.permission = s.next; save(s); return s.permission; };
            const toSub = rec => rec && {
                endpoint: rec.endpoint,
                options: { applicationServerKey: new Uint8Array(rec.key).buffer },
                toJSON() { return { endpoint: rec.endpoint, keys: phoneKeys }; },
                async unsubscribe() { const s = stub(); s.sub = null; s.unsubscribes++; save(s); return true; }
            };
            PushManager.prototype.getSubscription = async function () { return toSub(stub().sub); };
            PushManager.prototype.subscribe = async function (opts) {
                const s = stub();
                s.sub = { endpoint: 'https://web.push.apple.com/QTEST-' + Math.random().toString(36).slice(2), key: Array.from(new Uint8Array(opts.applicationServerKey)) };
                s.subscribes++;
                save(s);
                return toSub(s.sub);
            };
        }, { pushSupported, standalone, phoneKeys });
        const page = await ctx.newPage();
        page.errors = [];
        page.csp = [];
        page.on('pageerror', e => page.errors.push(e.message));
        page.on('console', m => { if (/Content Security Policy/i.test(m.text())) page.csp.push(m.text()); });
        page.on('dialog', d => d.accept());
        await page.goto(`http://localhost:${server.address().port}/`);
        await page.evaluate(() => navigator.serviceWorker.ready);
        return page;
    }

    const stubState = page => page.evaluate(() => JSON.parse(localStorage.getItem('__pushstub') || 'null'));
    const setStub = (page, patch) => page.evaluate(p => localStorage.setItem('__pushstub', JSON.stringify({ ...JSON.parse(localStorage.getItem('__pushstub') || '{"permission":"default","next":"granted","sub":null,"subscribes":0,"unsubscribes":0}'), ...p })), patch);
    const panel = async page => ({
        badge: (await page.textContent('#push-status-badge')).trim(),
        text: (await page.textContent('#push-status-text')).trim(),
        buttons: await page.evaluate(() => ['push-enable-btn', 'push-test-btn', 'push-disable-btn'].filter(id => !document.getElementById(id).classList.contains('hidden')))
    });
    const records = async () => (await store.list({ prefix: 'subs/' })).blobs.length;
    const onlyRecord = async () => store.get((await store.list({ prefix: 'subs/' })).blobs[0]?.key);
    const openReminders = page => page.click('button[onclick="openRemindersModal()"]');
    const waitBadge = (page, text) => page.waitForFunction(t => document.getElementById('push-status-badge').textContent.trim() === t, text, { timeout: 5000 }).then(() => true, () => false);

    // ---------- Happy path ----------
    const page = await newPage();
    await openReminders(page);
    check('U1 off by default', await panel(page), { badge: 'Off', text: 'Get a notification before each training session, even when PulseGym is closed.', buttons: ['push-enable-btn'] });
    await page.waitForTimeout(300);
    check('U2 server key fetched when the screen opens', apiLog.includes('key'), true);

    await page.click('#push-enable-btn');
    check('U3 turns on', await waitBadge(page, 'On'), true);
    const serverKey = (await store.get('config/vapid')).publicKey;
    const st = await stubState(page);
    check('U4 subscribed with the server key', [st.subscribes, Buffer.from(st.sub.key).toString('base64url')], [1, serverKey]);
    let rec = await onlyRecord();
    check('U5 server has the schedule', { timezone: rec.timezone, time: rec.time, lead: rec.lead, reminders: rec.reminders }, {
        timezone: 'Europe/London', time: '17:30', lead: 30, reminders: [
            { day: 1, label: 'Day 1 · Chest & Triceps', hiit: true },
            { day: 2, label: 'Day 2 · Back & Biceps', hiit: true },
            { day: 4, label: 'Day 3 · Shoulders & Legs', hiit: true },
            { day: 6, label: 'Day 4 · Cardio & Conditioning', hiit: false }
        ]
    });
    check('U6 panel when on', await panel(page), { badge: 'On', text: 'A reminder 30 mins before 17:30 on Mon, Tue, Thu, Sat, even when PulseGym is closed.', buttons: ['push-test-btn', 'push-disable-btn'] });
    await page.locator('#push-panel').screenshot({ path: `${outPrefix}-on.png` });

    // Changes reach the server
    await page.selectOption('select[aria-label="Reminder day for Cardio & Conditioning"]', '0');
    await page.waitForTimeout(1300);
    rec = await onlyRecord();
    check('U7 changed day synced', rec.reminders.map(r => r.day), [1, 2, 4, 0]);
    check('U8 sync toast', await page.locator('#toast-container').innerText(), t => t.includes('Reminders updated'));
    await page.selectOption('#gym-reminder-lead', '60');
    await page.fill('#gym-reminder-time', '06:45');
    await page.dispatchEvent('#gym-reminder-time', 'change');
    await page.waitForTimeout(1300);
    rec = await onlyRecord();
    check('U9 time + alert synced', [rec.time, rec.lead], ['06:45', 60]);
    check('U10 panel text follows', (await panel(page)).text, 'A reminder 1 hour before 06:45 on Mon, Tue, Thu, Sun, even when PulseGym is closed.');
    await page.selectOption('select[aria-label="Reminder day for Chest & Triceps"]', '-1');
    await page.waitForTimeout(1300);
    check('U11 "No reminder" removes that day', (await onlyRecord()).reminders.map(r => r.label), ['Day 2 · Back & Biceps', 'Day 3 · Shoulders & Legs', 'Day 4 · Cardio & Conditioning']);

    // Test notification
    await page.click('#push-test-btn');
    await page.waitForTimeout(500);
    check('U12 test push sent', testPushes.map(p => p.title), ['💪 PulseGym notifications are on']);
    check('U13 test toast', await page.locator('#toast-container').innerText(), t => t.includes('Test sent'));

    // Survives a relaunch; daily re-sync
    await page.reload();
    await openReminders(page);
    check('U14 still on after relaunch', (await panel(page)).badge, 'On');
    const syncs = apiLog.filter(a => a === 'subscribe').length;
    await page.evaluate(() => localStorage.setItem('pulsegym_push_v1', JSON.stringify({ on: true, syncedAt: 0 })));
    await page.reload();
    await page.waitForTimeout(1000);
    check('U15 re-synced quietly on launch after a day', [apiLog.filter(a => a === 'subscribe').length - syncs, await page.locator('#toast-container').innerText()], [1, '']);

    // Turn off
    await openReminders(page);
    await page.click('#push-disable-btn');
    check('U16 turns off', await waitBadge(page, 'Off'), true);
    check('U17 server forgot the device + unsubscribed', [await records(), (await stubState(page)).unsubscribes, (await stubState(page)).sub], [0, 1, null]);

    // Old subscription made with a different server key is replaced
    await setStub(page, { sub: { endpoint: 'https://web.push.apple.com/QOLD', key: Array(65).fill(4) } });
    await page.click('#push-enable-btn');
    await waitBadge(page, 'On');
    const st2 = await stubState(page);
    check('U18 stale-key subscription replaced', [st2.unsubscribes, st2.subscribes, st2.sub.endpoint !== 'https://web.push.apple.com/QOLD'], [2, 2, true]);

    // iPhone dropped the subscription (e.g. notifications removed in Settings): app notices on launch
    await setStub(page, { sub: null });
    await page.evaluate(() => localStorage.setItem('pulsegym_push_v1', JSON.stringify({ on: true, syncedAt: 0 })));
    await page.reload();
    await page.waitForTimeout(1000);
    await openReminders(page);
    check('U19 dropped subscription shows as off', (await panel(page)).badge, 'Off');

    // Server error
    failSubscribe = true;
    await page.click('#push-enable-btn');
    await page.waitForTimeout(800);
    check('U20 server error reported, stays off', [(await page.locator('#toast-container').innerText()).includes("Couldn't turn on notifications (Service unavailable)"), (await panel(page)).badge], [true, 'Off']);
    failSubscribe = false;

    // Permission refused
    await page.evaluate(() => closeModal('reminders-modal'));
    await setStub(page, { permission: 'default', next: 'denied', sub: null });
    await page.reload();
    await openReminders(page);
    await page.click('#push-enable-btn');
    await page.waitForTimeout(300);
    check('U21 refused permission explained', await panel(page), p => p.badge === 'Off' && p.text.startsWith('Notifications are blocked') && p.buttons.length === 0);
    check('U22 no CSP violations / errors', [page.csp, page.errors], [[], []]);

    // ---------- Safari tab on iPhone (no Web Push until it's a Home Screen app) ----------
    const tab = await newPage({ pushSupported: false, standalone: false });
    await openReminders(tab);
    check('U23 Safari tab: explains Home Screen', await panel(tab), { badge: 'Home Screen only', text: 'Open PulseGym from its Home Screen icon to turn these on: iPhone only allows notifications for Home Screen apps.', buttons: [] });
    await tab.locator('#push-panel').screenshot({ path: `${outPrefix}-safari-tab.png` });
    check('U24 no errors', [tab.csp, tab.errors], [[], []]);

    checks.forEach(c => console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.actual)}${c.expected !== undefined ? ` want=${JSON.stringify(c.expected)}` : ''}`}`));
    console.log(`\n${checks.filter(c => c.ok).length}/${checks.length} passed`);
    if (checks.some(c => !c.ok)) process.exitCode = 1;
    await browser.close();
    server.close();
})();
