// Service worker: a delivered push shows the notification; /api/ calls bypass the offline cache.
// Run: node tests/push-sw.test.js  (or npm test)
const { chromium, siteDir: defaultSiteDir, outDir } = require('./harness');
const http = require('http');
const fs = require('fs');
const path = require('path');

const siteDir = process.argv[2] || defaultSiteDir;
let keyCounter = 0;
const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/push/key')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ publicKey: `key-${++keyCounter}` }));
    }
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
    const origin = `http://localhost:${server.address().port}`;
    // Full Chromium: the slimmed-down headless shell has no notifications
    const browser = await chromium.launch({ channel: 'chromium' });
    const ctx = await browser.newContext();
    await ctx.grantPermissions(['notifications'], { origin });
    await ctx.route(/fonts\./, r => r.abort());
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    const registrations = [];
    cdp.on('ServiceWorker.workerRegistrationUpdated', e => registrations.push(...e.registrations));
    await cdp.send('ServiceWorker.enable');
    await page.goto(`${origin}/`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForTimeout(500);
    const reg = registrations.find(r => r.scopeURL === `${origin}/` && !r.isDeleted);
    check('S1 service worker registered', !!reg, true);

    const notifications = () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications())
        .map(n => ({ title: n.title, body: n.body, tag: n.tag, url: n.data?.url })));

    await cdp.send('ServiceWorker.deliverPushMessage', {
        origin, registrationId: reg.registrationId,
        data: JSON.stringify({ title: '💪 Day 2 · Back & Biceps', body: 'Starts in 30 mins · Assault Bike HIIT first', tag: 'pulsegym-day-2', url: '/' })
    });
    await page.waitForTimeout(800);
    check('S2 push shows the reminder', await notifications(), [{ title: '💪 Day 2 · Back & Biceps', body: 'Starts in 30 mins · Assault Bike HIIT first', tag: 'pulsegym-day-2', url: '/' }]);

    await cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: reg.registrationId, data: 'not json' });
    await page.waitForTimeout(800);
    check('S3 unreadable push still shows something (iPhone requires it)', (await notifications()).find(n => n.tag === 'pulsegym'), { title: 'PulseGym', body: 'Time to train! 💪', tag: 'pulsegym', url: './' });

    // /api/ is never cached by the service worker
    const keys = await page.evaluate(async () => [await (await fetch('/api/push/key')).json(), await (await fetch('/api/push/key')).json()]);
    check('S4 /api/ requests go to the server every time', keys.map(k => k.publicKey), ['key-1', 'key-2']);
    check('S5 /api/ not stored in the offline cache', await page.evaluate(async () => (await (await caches.open('pulsegym-v2')).keys()).some(r => r.url.includes('/api/'))), false);

    checks.forEach(c => console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.actual)}${c.expected !== undefined ? ` want=${JSON.stringify(c.expected)}` : ''}`}`));
    console.log(`\n${checks.filter(c => c.ok).length}/${checks.length} passed`);
    if (checks.some(c => !c.ok)) process.exitCode = 1;
    await browser.close();
    server.close();
})();
