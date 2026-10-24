// Push server tests: core logic, real web-push encryption to a local push service (decrypted and
// VAPID-checked like Apple would), and the actual Netlify function files against a local Blobs server.
// Run: node tests/push-server.test.mjs  (or npm test). Needs openssl for the local push service's certificate.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2] || path.join(here, '..');
const work = process.argv[3] || path.join(here, 'output', 'push-server');
fs.mkdirSync(work, { recursive: true });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the local push service uses a self-signed certificate
process.env.NO_PROXY = 'localhost,127.0.0.1';
const require = createRequire(path.join(repo, 'package.json'));
const webpush = require('web-push');
const ece = require('http_ece');
const { BlobsServer } = require('@netlify/blobs/server');
const { getStore } = require('@netlify/blobs');
const core = await import(path.join(repo, 'netlify/lib/push-core.mjs'));

const checks = [];
const check = (name, actual, expected) => {
    const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
    checks.push({ ok, name, actual: ok ? undefined : actual, expected: ok || typeof expected === 'function' ? undefined : expected });
};
const rejects = async (fn) => { try { await fn(); return 'resolved'; } catch (e) { return e.status ?? e.message; } };
const b64u = buf => Buffer.from(buf).toString('base64url');

function memoryStore() {
    const data = new Map();
    return {
        data,
        async get(key) { return data.has(key) ? structuredClone(data.get(key)) : null; },
        async setJSON(key, value, opts = {}) {
            if (opts.onlyIfNew && data.has(key)) return { modified: false };
            data.set(key, structuredClone(value));
            return { modified: true };
        },
        async delete(key) { data.delete(key); },
        async list({ prefix = '' } = {}) { return { blobs: [...data.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) }; }
    };
}

// A browser-side subscription: real P-256 key pair + auth secret, so encrypted pushes can be decrypted
function makeClient(endpoint) {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const auth = crypto.randomBytes(16);
    return { ecdh, auth, subscription: { endpoint, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } } };
}

const APPLE = 'https://web.push.apple.com/QGvbb2Q0Xf1kD8jK5Hn0WlYb_ExampleToken';
const req = (url, { method = 'GET', body, headers = {} } = {}) => new Request(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
});

// ---------- Validation ----------
const urls = {
    apple: APPLE, appleRegional: 'https://api.push.apple.com/x', fcm: 'https://fcm.googleapis.com/fcm/send/abc',
    mozilla: 'https://updates.push.services.mozilla.com/wpush/v2/abc', windows: 'https://wns2-db5p.notify.windows.com/w/?token=abc',
    localhost: 'https://localhost/push', metadata: 'https://169.254.169.254/latest', http: 'http://web.push.apple.com/x',
    lookalike: 'https://web.push.apple.com.evil.example/x', suffix: 'https://evilpush.apple.com.example/x', port: 'https://web.push.apple.com:8443/x',
    creds: 'https://user:pw@web.push.apple.com/x', junk: 'not a url'
};
check('V1 push hosts allowed', ['apple', 'appleRegional', 'fcm', 'mozilla', 'windows'].map(k => core.isPushServiceUrl(urls[k])), [true, true, true, true, true]);
check('V2 everything else refused (SSRF)', ['localhost', 'metadata', 'http', 'lookalike', 'suffix', 'port', 'creds', 'junk'].map(k => core.isPushServiceUrl(urls[k])), Array(8).fill(false));
const client = makeClient(APPLE);
check('V3 valid subscription', core.validateSubscription(client.subscription).endpoint, APPLE);
check('V4 bad keys refused', await rejects(() => core.validateSubscription({ endpoint: APPLE, keys: { p256dh: 'x', auth: client.subscription.keys.auth } })), 400);
const goodSchedule = { timezone: 'Europe/London', time: '17:30', lead: 30, reminders: [{ day: 1, label: 'Day 1 · Chest & Triceps', hiit: true }] };
check('V5 valid schedule', core.validateSchedule(goodSchedule).reminders[0], { day: 1, label: 'Day 1 · Chest & Triceps', hiit: true });
check('V6 bad schedules refused', await Promise.all([
    { ...goodSchedule, timezone: 'Mars/Olympus' }, { ...goodSchedule, time: '25:00' }, { ...goodSchedule, lead: 999 },
    { ...goodSchedule, reminders: [{ day: 7, label: 'x' }] }, { ...goodSchedule, reminders: [{ day: 1, label: '   ' }] },
    { ...goodSchedule, reminders: Array(15).fill({ day: 1, label: 'x' }) }
].map(s => rejects(() => core.validateSchedule(s)))), Array(6).fill(400));
check('V7 labels cleaned and capped', core.validateSchedule({ ...goodSchedule, reminders: [{ day: 2, label: 'A\nB\u0000C' + 'x'.repeat(100) }] }).reminders[0].label, l => l.startsWith('A B C') && l.length === 80);

// readJsonBody
check('V8 non-JSON refused', await rejects(() => core.readJsonBody(new Request('https://a/x', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }))), 415);
check('V9 cross-site refused', await rejects(() => core.readJsonBody(req('https://a/x', { method: 'POST', body: {}, headers: { 'sec-fetch-site': 'cross-site' } }))), 403);
check('V10 huge body refused', await rejects(() => core.readJsonBody(req('https://a/x', { method: 'POST', body: 'x'.repeat(9000) }))), 413);
check('V11 bad JSON refused', await rejects(() => core.readJsonBody(req('https://a/x', { method: 'POST', body: '{nope' }))), 400);

// ---------- Due-time maths ----------
check('T1 London winter', core.localWeekMinute(new Date('2026-01-05T17:00:00Z'), 'Europe/London'), 1 * 1440 + 17 * 60);
check('T2 London summer (BST)', core.localWeekMinute(new Date('2026-07-06T16:00:00Z'), 'Europe/London'), 1 * 1440 + 17 * 60);
check('T3 midnight is 00:00 not 24:00', core.localWeekMinute(new Date('2026-07-06T23:00:00Z'), 'Europe/London'), 2 * 1440);
const rec = (extra = {}) => ({ timezone: 'Europe/London', time: '17:30', lead: 30, reminders: [{ day: 1, label: 'Day 1 · Chest & Triceps', hiit: true }], sent: {}, ...extra });
const at = iso => new Date(iso).getTime();
check('T4 due at alert time (BST)', core.dueReminders(rec(), at('2026-07-06T16:00:00Z')).length, 1);
check('T5 still due 14 min late', core.dueReminders(rec(), at('2026-07-06T16:14:00Z')).length, 1);
check('T6 not due 15 min late', core.dueReminders(rec(), at('2026-07-06T16:15:00Z')).length, 0);
check('T7 not due a minute early', core.dueReminders(rec(), at('2026-07-06T15:59:00Z')).length, 0);
check('T8 winter: same local time, different UTC', [core.dueReminders(rec(), at('2026-01-05T17:00:00Z')).length, core.dueReminders(rec(), at('2026-01-05T16:00:00Z')).length], [1, 0]);
const first = core.dueReminders(rec(), at('2026-07-06T16:00:00Z'))[0];
const later = core.dueReminders(rec(), at('2026-07-06T16:05:00Z'))[0];
check('T9 same occurrence id across runs', first.occurrence === later.occurrence, true);
check('T10 sent occurrence not resent', core.dueReminders(rec({ sent: { [first.occurrence]: true } }), at('2026-07-06T16:05:00Z')).length, 0);
check('T11 next week is a new occurrence', core.dueReminders(rec({ sent: { [first.occurrence]: true } }), at('2026-07-13T16:00:00Z')).length, 1);
check('T12 alert crosses midnight', core.dueReminders(rec({ time: '00:15', reminders: [{ day: 2, label: 'Tue', hiit: false }] }), at('2026-07-06T22:45:00Z')).length, 1);
check('T13 Sunday wraps to Saturday', core.dueReminders(rec({ time: '00:10', reminders: [{ day: 0, label: 'Sun', hiit: false }] }), at('2026-07-11T22:40:00Z')).length, 1);
check('T14 other time zones', core.dueReminders(rec({ timezone: 'America/New_York' }), at('2026-07-06T21:00:00Z')).length, 1);
check('T15 two workouts same day', core.dueReminders(rec({ reminders: [{ day: 1, label: 'A' }, { day: 1, label: 'B' }] }), at('2026-07-06T16:00:00Z')).length, 2);
check('T16 payload', core.reminderPayload({ day: 1, label: 'Day 1 · Chest & Triceps', hiit: true }, 30), { title: '💪 Day 1 · Chest & Triceps', body: 'Starts in 30 mins · Assault Bike HIIT first', tag: 'pulsegym-day-1', url: '/' });
check('T17 payload wording', [core.reminderPayload({ day: 4, label: 'X', hiit: false }, 60).body, core.reminderPayload({ day: 4, label: 'X', hiit: false }, 0).body], ['Starts in 1 hour', 'Time to train!']);

// ---------- Handlers with a memory store ----------
{
    const store = memoryStore();
    let generated = 0;
    const generateKeys = () => { generated++; return webpush.generateVAPIDKeys(); };
    const [k1, k2] = await Promise.all([core.handleKey(store, { origin: 'https://pulse.example', generateKeys }), core.handleKey(store, { origin: 'https://pulse.example', generateKeys })]);
    check('H1 simultaneous first calls agree on one key', k1.body.publicKey === k2.body.publicKey, true);
    check('H2 key kept', (await core.handleKey(store, { origin: 'https://pulse.example', generateKeys })).body.publicKey, k1.body.publicKey);
    check('H3 subject is the site', (await store.get('config/vapid')).subject, 'https://pulse.example');
    check('H4 private key never returned', JSON.stringify(k1.body).includes('private'), false);

    const res = await core.handleSubscribe(store, { subscription: client.subscription, ...goodSchedule }, 1000);
    const key = core.subscriptionKey(APPLE);
    check('H5 subscribe stores record', [res.status, (await store.get(key)).reminders.length, (await store.get(key)).createdAt], [200, 1, 1000]);
    const stored = await store.get(key);
    await store.setJSON(key, { ...stored, sent: { 'x@1': true } });
    await core.handleSubscribe(store, { subscription: client.subscription, ...goodSchedule, time: '18:00' }, 2000);
    check('H6 re-saving keeps sent + createdAt', (({ time, sent, createdAt, updatedAt }) => ({ time, sent, createdAt, updatedAt }))(await store.get(key)), { time: '18:00', sent: { 'x@1': true }, createdAt: 1000, updatedAt: 2000 });
    check('H7 SSRF subscription refused', await rejects(() => core.handleSubscribe(store, { subscription: { ...client.subscription, endpoint: 'https://localhost/x' }, ...goodSchedule })), 400);

    const sent = [];
    const okSender = async (sub, payload) => { sent.push(payload); };
    check('H8 test needs a stored subscription', await rejects(() => core.handleTest(store, { subscription: makeClient(APPLE + 'other').subscription }, okSender)), 404);
    check('H9 test needs the right secret', await rejects(() => core.handleTest(store, { subscription: { ...client.subscription, keys: { ...client.subscription.keys, auth: b64u(crypto.randomBytes(16)) } } }, okSender)), 404);
    check('H10 test sends', [(await core.handleTest(store, { subscription: client.subscription }, okSender, 50000)).status, sent[0]?.title], [200, '💪 PulseGym notifications are on']);
    check('H11 test cooldown', await rejects(() => core.handleTest(store, { subscription: client.subscription }, okSender, 52000)), 429);
    const expired = async () => { const e = new Error('gone'); e.statusCode = 410; throw e; };
    check('H12 expired subscription removed on test', [await rejects(() => core.handleTest(store, { subscription: client.subscription }, expired, 90000)), await store.get(key)], [410, null]);

    await core.handleSubscribe(store, { subscription: client.subscription, ...goodSchedule });
    await core.handleUnsubscribe(store, { subscription: { ...client.subscription, keys: { ...client.subscription.keys, auth: b64u(crypto.randomBytes(16)) } } });
    check('H13 unsubscribe with wrong secret ignored', !!(await store.get(key)), true);
    await core.handleUnsubscribe(store, { subscription: client.subscription });
    check('H14 unsubscribe removes', await store.get(key), null);
}

// ---------- Scheduled run with a memory store ----------
{
    const store = memoryStore();
    await core.handleKey(store, { origin: 'https://pulse.example', generateKeys: () => webpush.generateVAPIDKeys() });
    const a = makeClient(APPLE + 'a');
    const b = makeClient(APPLE + 'b');
    await core.handleSubscribe(store, { subscription: a.subscription, ...goodSchedule, time: '17:30' });
    await core.handleSubscribe(store, { subscription: b.subscription, ...goodSchedule, time: '20:00' });
    const now = at('2026-07-06T16:02:00Z'); // 17:02 BST: a's 17:00 alert is due, b's 19:30 isn't
    const sends = [];
    const sender = async (sub, payload) => { sends.push([sub.endpoint, payload.title]); };
    const r1 = await core.sendDueReminders(store, sender, now, { error() {} });
    check('R1 only the due device notified', [r1, sends], [{ checked: 2, sent: 1, removed: 0 }, [[APPLE + 'a', '💪 Day 1 · Chest & Triceps']]]);
    const r2 = await core.sendDueReminders(store, sender, now + 5 * 60000, { error() {} });
    check('R2 next run does not repeat it', r2.sent, 0);

    const store2 = memoryStore();
    await core.handleKey(store2, { origin: 'https://pulse.example', generateKeys: () => webpush.generateVAPIDKeys() });
    await core.handleSubscribe(store2, { subscription: a.subscription, ...goodSchedule });
    let calls = 0;
    const flaky = async () => { calls++; const e = new Error('busy'); e.statusCode = 503; throw e; };
    await core.sendDueReminders(store2, flaky, now, { error() {} });
    const r3 = await core.sendDueReminders(store2, sender, now + 5 * 60000, { error() {} });
    check('R3 failed send retried on the next run', [calls, r3.sent], [1, 1]);
    const r4 = await core.sendDueReminders(store2, async () => { const e = new Error('gone'); e.statusCode = 410; throw e; }, now + 7 * 86400000, { error() {} });
    check('R4 expired device removed', [r4.removed, (await store2.list({ prefix: 'subs/' })).blobs.length], [1, 0]);

    // Old "sent" ids are pruned after a week
    const store3 = memoryStore();
    await core.handleKey(store3, { origin: 'https://pulse.example', generateKeys: () => webpush.generateVAPIDKeys() });
    await core.handleSubscribe(store3, { subscription: a.subscription, ...goodSchedule });
    const k3 = core.subscriptionKey(a.subscription.endpoint);
    await store3.setJSON(k3, { ...(await store3.get(k3)), sent: { 'old@1000': true } });
    await core.sendDueReminders(store3, sender, now, { error() {} });
    check('R5 old sent ids pruned', Object.keys((await store3.get(k3)).sent).some(id => id === 'old@1000'), false);
    check('R6 no keys yet: nothing to do', await core.sendDueReminders(memoryStore(), sender, now), { checked: 0, sent: 0, removed: 0 });
}

// ---------- Real encryption to a local push service ----------
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${work}/key.pem -out ${work}/cert.pem -days 1 -subj /CN=localhost 2>/dev/null`);
const received = [];
const pushService = https.createServer({ key: fs.readFileSync(`${work}/key.pem`), cert: fs.readFileSync(`${work}/cert.pem`) }, (r, s) => {
    const chunks = [];
    r.on('data', c => chunks.push(c));
    r.on('end', () => {
        received.push({ url: r.url, headers: r.headers, body: Buffer.concat(chunks) });
        const status = r.url.includes('gone') ? 410 : 201;
        s.writeHead(status);
        s.end();
    });
}).listen(0);
await new Promise(res => pushService.once('listening', res));
const pushOrigin = `https://localhost:${pushService.address().port}`;

function openPush(entry, receiver) {
    return JSON.parse(ece.decrypt(entry.body, { version: 'aes128gcm', privateKey: receiver.ecdh, authSecret: b64u(receiver.auth) }).toString('utf8'));
}

function checkVapid(entry, vapid) {
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(entry.headers.authorization || '');
    if (!m) return 'no vapid header';
    const [h, p, sig] = m[1].split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url'));
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    const raw = Buffer.from(m[2], 'base64url');
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) }, format: 'jwk' });
    const valid = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    return {
        alg: header.alg, valid, keyMatches: m[2] === vapid.publicKey, aud: claims.aud, sub: claims.sub,
        expOk: claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600
    };
}

{
    const vapid = { ...webpush.generateVAPIDKeys(), subject: 'https://pulse.example' };
    const phone = makeClient(`${pushOrigin}/push/phone1`);
    await core.createSender(webpush)(phone.subscription, core.reminderPayload({ day: 2, label: 'Day 2 · Back & Biceps', hiit: true }, 30), vapid);
    const entry = received.at(-1);
    check('E1 push service got the request', entry?.url, '/push/phone1');
    check('E2 push headers', [entry.headers['content-encoding'], entry.headers.ttl, entry.headers.urgency], ['aes128gcm', '3600', 'high']);
    check('E3 payload decrypts on the phone', openPush(entry, phone), { title: '💪 Day 2 · Back & Biceps', body: 'Starts in 30 mins · Assault Bike HIIT first', tag: 'pulsegym-day-2', url: '/' });
    check('E4 VAPID signature valid (what Apple checks)', checkVapid(entry, vapid), { alg: 'ES256', valid: true, keyMatches: true, aud: pushOrigin, sub: 'https://pulse.example', expOk: true });
    const other = makeClient(`${pushOrigin}/push/phone2`);
    check('E5 another phone cannot read it', await rejects(() => openPush(entry, other)), m => typeof m === 'string');
    const gone = makeClient(`${pushOrigin}/push/gone`);
    check('E6 410 surfaces as expiry', await rejects(() => core.createSender(webpush)(gone.subscription, { title: 'x' }, vapid).catch(e => { throw Object.assign(new Error('x'), { status: e.statusCode }); })), 410);
}

// ---------- The actual Netlify function files, on a local Blobs server ----------
{
    const blobsDir = path.join(work, 'blobs');
    fs.rmSync(blobsDir, { recursive: true, force: true });
    const blobs = new BlobsServer({ directory: blobsDir, token: 'test-token' });
    const { port } = await blobs.start();
    const edge = `http://localhost:${port}`;
    process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ edgeURL: edge, uncachedEdgeURL: edge, token: 'test-token', siteID: 'pulsegym-test' })).toString('base64');
    const api = (await import(path.join(repo, 'netlify/functions/push.mjs'))).default;
    const scheduled = (await import(path.join(repo, 'netlify/functions/push-reminders.mjs'))).default;
    const site = 'https://pulse.example';

    const k = await api(req(`${site}/api/push/key`));
    const keyBody = await k.json();
    check('F1 GET key', [k.status, k.headers.get('cache-control'), typeof keyBody.publicKey], [200, 'no-store', 'string']);
    check('F2 key stable', (await (await api(req(`${site}/api/push/key`))).json()).publicKey, keyBody.publicKey);
    const phone = makeClient(APPLE + 'f');
    const sub = await api(req(`${site}/api/push/subscribe`, { method: 'POST', body: { subscription: phone.subscription, ...goodSchedule } }));
    check('F3 subscribe', [sub.status, await sub.json()], [200, { ok: true, reminders: 1 }]);
    const store = getStore({ name: 'pulsegym-push', consistency: 'strong' });
    check('F4 stored in Netlify Blobs', (await store.get(core.subscriptionKey(phone.subscription.endpoint), { type: 'json' }))?.time, '17:30');
    const statuses = await Promise.all([
        api(req(`${site}/api/push/subscribe`, { method: 'POST', body: { subscription: { ...phone.subscription, endpoint: 'https://127.0.0.1/x' }, ...goodSchedule } })),
        api(new Request(`${site}/api/push/subscribe`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })),
        api(req(`${site}/api/push/subscribe`, { method: 'POST', body: {}, headers: { 'sec-fetch-site': 'cross-site' } })),
        api(req(`${site}/api/push/subscribe`)),
        api(req(`${site}/api/push/nope`, { method: 'POST', body: {} }))
    ]).then(rs => rs.map(r => r.status));
    check('F5 bad requests refused', statuses, [400, 415, 403, 405, 404]);
    const errBody = await (await api(req(`${site}/api/push/subscribe`, { method: 'POST', body: { subscription: phone.subscription, ...goodSchedule, time: 'x' } }))).json();
    check('F6 errors are JSON', errBody, { error: 'Invalid time' });
    const un = await api(req(`${site}/api/push/unsubscribe`, { method: 'POST', body: { subscription: phone.subscription } }));
    check('F7 unsubscribe', [un.status, await store.get(core.subscriptionKey(phone.subscription.endpoint), { type: 'json' })], [200, null]);

    // Scheduled job end to end: a due reminder goes out through web-push to the local push service
    const due = makeClient(`${pushOrigin}/push/scheduled`);
    const now = new Date();
    const hhmm = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
    const dueKey = core.subscriptionKey(due.subscription.endpoint);
    await store.setJSON(dueKey, {
        subscription: due.subscription, timezone: 'UTC', time: hhmm, lead: 0,
        reminders: [{ day: now.getUTCDay(), label: 'Day 3 · Shoulders & Legs', hiit: true }], sent: {}, createdAt: 1, updatedAt: 1
    });
    const before = received.length;
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    await scheduled(new Request('https://pulse.example/.netlify/functions/push-reminders', { method: 'POST', body: JSON.stringify({ next_run: '' }) }));
    await scheduled(new Request('https://pulse.example/.netlify/functions/push-reminders', { method: 'POST', body: '{}' }));
    console.log = origLog;
    const got = received.slice(before);
    check('F8 scheduled job sent exactly one push', got.map(g => g.url), ['/push/scheduled']);
    check('F9 phone decrypts the reminder', got[0] && openPush(got[0], due).title, '💪 Day 3 · Shoulders & Legs');
    check('F10 signed with the stored keys', got[0] && checkVapid(got[0], keyBody).keyMatches, true);
    check('F11 marked as sent in Blobs', Object.keys((await store.get(dueKey, { type: 'json' })).sent).length, 1);
    check('F12 job logs a summary', logs, l => l[0]?.startsWith('Checked 1 device(s), sent 1 reminder(s)'));
    await blobs.stop();
}

pushService.close();
checks.forEach(c => console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.actual)}${c.expected !== undefined ? ` want=${JSON.stringify(c.expected)}` : ''}`}`));
console.log(`\n${checks.filter(c => c.ok).length}/${checks.length} passed`);
if (checks.some(c => !c.ok)) process.exitCode = 1;
