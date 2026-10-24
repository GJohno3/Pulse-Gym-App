// Training-day push reminders: everything except the Netlify and web-push wiring, so it can be tested
// with an in-memory store and a fake sender.
//
// Stored in Netlify Blobs:
//   config/vapid   { publicKey, privateKey, subject }  generated on first use, never leaves the server
//   subs/<sha256>  { subscription, timezone, time, lead, reminders, sent, createdAt, updatedAt }
import { createHash } from 'node:crypto';

const VAPID_KEY = 'config/vapid';
const SUB_PREFIX = 'subs/';
const WEEK_MINUTES = 7 * 1440;
// The scheduled function runs every 5 minutes; a reminder stays due for 15 so a late or skipped run still sends it
export const DUE_WINDOW_MINUTES = 15;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_REMINDERS = 14;
const SENT_HISTORY_MINUTES = 8 * 1440;
const TEST_COOLDOWN_MS = 10 * 1000;

// Only real browser push services: the server POSTs to this address later, so anything else
// (localhost, internal addresses) would let a stranger make the function call arbitrary URLs.
export function isPushServiceUrl(value) {
    let url;
    try { url = new URL(value); } catch (e) { return false; }
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
    const host = url.hostname;
    return host === 'web.push.apple.com' || host.endsWith('.push.apple.com')
        || host === 'fcm.googleapis.com'
        || host === 'updates.push.services.mozilla.com'
        || host.endsWith('.notify.windows.com');
}

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export class RequestError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

export function validateSubscription(sub) {
    const endpoint = sub?.endpoint;
    const p256dh = sub?.keys?.p256dh;
    const auth = sub?.keys?.auth;
    if (typeof endpoint !== 'string' || endpoint.length > 1024 || !isPushServiceUrl(endpoint)) {
        throw new RequestError(400, 'Unsupported push subscription');
    }
    if (typeof p256dh !== 'string' || !BASE64URL.test(p256dh) || p256dh.length < 80 || p256dh.length > 100) {
        throw new RequestError(400, 'Invalid subscription key');
    }
    if (typeof auth !== 'string' || !BASE64URL.test(auth) || auth.length < 16 || auth.length > 32) {
        throw new RequestError(400, 'Invalid subscription key');
    }
    return { endpoint, keys: { p256dh, auth } };
}

function isTimeZone(value) {
    if (typeof value !== 'string' || !value || value.length > 64) return false;
    try {
        new Intl.DateTimeFormat('en-GB', { timeZone: value });
        return true;
    } catch (e) {
        return false;
    }
}

function cleanLabel(value) {
    return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
}

export function validateSchedule(body) {
    if (!isTimeZone(body?.timezone)) throw new RequestError(400, 'Invalid time zone');
    if (typeof body.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) throw new RequestError(400, 'Invalid time');
    if (!Number.isInteger(body.lead) || body.lead < 0 || body.lead > 240) throw new RequestError(400, 'Invalid alert time');
    if (!Array.isArray(body.reminders) || body.reminders.length > MAX_REMINDERS) throw new RequestError(400, 'Invalid training days');
    const reminders = body.reminders.map(r => {
        if (!Number.isInteger(r?.day) || r.day < 0 || r.day > 6) throw new RequestError(400, 'Invalid training day');
        const label = cleanLabel(r.label);
        if (!label) throw new RequestError(400, 'Missing workout name');
        return { day: r.day, label, hiit: !!r.hiit };
    });
    return { timezone: body.timezone, time: body.time, lead: body.lead, reminders };
}

export function subscriptionKey(endpoint) {
    return SUB_PREFIX + createHash('sha256').update(endpoint).digest('hex');
}

// Parse a JSON request body from this site only (a JSON content type makes other sites' requests
// need a CORS preflight, which this API never grants)
export async function readJsonBody(req) {
    if (!/^application\/json\b/i.test(req.headers.get('content-type') || '')) throw new RequestError(415, 'Expected JSON');
    const site = req.headers.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') throw new RequestError(403, 'Cross-site request refused');
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) throw new RequestError(413, 'Request too large');
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new RequestError(400, 'Invalid JSON');
    }
}

// VAPID keys sign every push. Made once, on first use, so there's no secret to set up by hand.
export async function getVapidKeys(store, { origin, generateKeys }) {
    const existing = await store.get(VAPID_KEY, { type: 'json' });
    if (existing?.publicKey && existing?.privateKey) return existing;
    if (!generateKeys) return null;
    const keys = generateKeys();
    // Apple requires the "subject" to be an https: or mailto: URL; the site's own address works
    await store.setJSON(VAPID_KEY, { ...keys, subject: origin }, { onlyIfNew: true });
    return store.get(VAPID_KEY, { type: 'json' }); // whichever request won a simultaneous first write
}

// Minutes since Sunday 00:00 in the given time zone (so British Summer Time etc. are handled)
export function localWeekMinute(date, timeZone) {
    const parts = {};
    new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(date)
        .forEach(p => { parts[p.type] = p.value; });
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
    return day * 1440 + Number(parts.hour) * 60 + Number(parts.minute);
}

// Reminders whose alert time (training time minus the lead) passed within the last DUE_WINDOW_MINUTES
// and haven't been sent yet. Each occurrence gets an id from its alert minute, so it's sent once.
export function dueReminders(record, now = Date.now()) {
    const nowMinute = Math.floor(now / 60000);
    const local = localWeekMinute(new Date(now), record.timezone);
    const [hours, minutes] = record.time.split(':').map(Number);
    return record.reminders.flatMap(reminder => {
        const alertAt = (((reminder.day * 1440 + hours * 60 + minutes - record.lead) % WEEK_MINUTES) + WEEK_MINUTES) % WEEK_MINUTES;
        const late = (((local - alertAt) % WEEK_MINUTES) + WEEK_MINUTES) % WEEK_MINUTES;
        if (late >= DUE_WINDOW_MINUTES) return [];
        const occurrence = `${reminder.day}|${reminder.label}@${nowMinute - late}`;
        return record.sent?.[occurrence] ? [] : [{ reminder, occurrence }];
    });
}

function formatLead(minutes) {
    if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
    return `${minutes} mins`;
}

export function reminderPayload(reminder, lead) {
    const hiit = reminder.hiit ? ' · Assault Bike HIIT first' : '';
    return {
        title: `💪 ${reminder.label}`,
        body: lead > 0 ? `Starts in ${formatLead(lead)}${hiit}` : `Time to train!${hiit}`,
        tag: `pulsegym-day-${reminder.day}`,
        url: '/'
    };
}

const isExpired = err => err?.statusCode === 404 || err?.statusCode === 410;

// ---------- API handlers (return { status, body }) ----------

export async function handleKey(store, { origin, generateKeys }) {
    const vapid = await getVapidKeys(store, { origin, generateKeys });
    return { status: 200, body: { publicKey: vapid.publicKey } };
}

export async function handleSubscribe(store, body, now = Date.now()) {
    const subscription = validateSubscription(body?.subscription);
    const schedule = validateSchedule(body);
    const key = subscriptionKey(subscription.endpoint);
    const existing = await store.get(key, { type: 'json' });
    await store.setJSON(key, {
        subscription,
        ...schedule,
        sent: existing?.sent || {}, // re-saving the schedule mustn't re-send a reminder already delivered
        createdAt: existing?.createdAt || now,
        updatedAt: now
    });
    return { status: 200, body: { ok: true, reminders: schedule.reminders.length } };
}

// Needs the subscription's own secret, not just its address
async function findOwnRecord(store, body) {
    const subscription = validateSubscription(body?.subscription);
    const key = subscriptionKey(subscription.endpoint);
    const record = await store.get(key, { type: 'json' });
    if (!record || record.subscription.keys.auth !== subscription.keys.auth) return { key, record: null };
    return { key, record };
}

export async function handleUnsubscribe(store, body) {
    const { key, record } = await findOwnRecord(store, body);
    if (record) await store.delete(key);
    return { status: 200, body: { ok: true } };
}

export async function handleTest(store, body, send, now = Date.now()) {
    const { key, record } = await findOwnRecord(store, body);
    if (!record) throw new RequestError(404, 'Notifications are not set up on this device');
    if (now - (record.lastTestAt || 0) < TEST_COOLDOWN_MS) throw new RequestError(429, 'Please wait a few seconds');
    const vapid = await getVapidKeys(store, {});
    if (!vapid) throw new RequestError(503, 'Push keys are missing');
    try {
        await send(record.subscription, {
            title: '💪 PulseGym notifications are on',
            body: 'Your training reminders will arrive like this.',
            tag: 'pulsegym-test',
            url: '/'
        }, vapid);
    } catch (err) {
        if (isExpired(err)) {
            await store.delete(key);
            throw new RequestError(410, 'This device is no longer subscribed. Turn notifications off and on again.');
        }
        throw new RequestError(502, 'The push service refused the notification');
    }
    await store.setJSON(key, { ...record, lastTestAt: now });
    return { status: 200, body: { ok: true } };
}

// ---------- Scheduled run ----------

export async function sendDueReminders(store, send, now = Date.now(), log = console) {
    const vapid = await getVapidKeys(store, {});
    if (!vapid) return { checked: 0, sent: 0, removed: 0 };
    const { blobs } = await store.list({ prefix: SUB_PREFIX });
    const result = { checked: 0, sent: 0, removed: 0 };
    for (const { key } of blobs) {
        const record = await store.get(key, { type: 'json' });
        if (!record) continue;
        result.checked++;
        let changed = false;
        let removed = false;
        for (const { reminder, occurrence } of dueReminders(record, now)) {
            try {
                await send(record.subscription, reminderPayload(reminder, record.lead), vapid);
            } catch (err) {
                if (isExpired(err)) { // the phone dropped the subscription (e.g. app removed from Home Screen)
                    await store.delete(key);
                    removed = true;
                    result.removed++;
                    break;
                }
                log.error(`Push failed (${err?.statusCode || err?.message}); will retry on the next run`);
                continue;
            }
            record.sent = { ...record.sent, [occurrence]: true };
            changed = true;
            result.sent++;
        }
        if (removed || !changed) continue;
        // Forget sends older than a week
        const oldest = Math.floor(now / 60000) - SENT_HISTORY_MINUTES;
        record.sent = Object.fromEntries(Object.entries(record.sent).filter(([id]) => Number(id.split('@').pop()) >= oldest));
        await store.setJSON(key, record);
    }
    return result;
}

// web-push options: drop a reminder that can't be delivered within an hour (it'd be stale)
export function createSender(webpush) {
    return (subscription, payload, vapid) => webpush.sendNotification(subscription, JSON.stringify(payload), {
        vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        TTL: 3600,
        urgency: 'high'
    });
}
