// PulseGym push API, used by the Reminders screen:
//   GET  /api/push/key          public key the phone subscribes with
//   POST /api/push/subscribe    save this device's subscription + training schedule
//   POST /api/push/unsubscribe  forget this device
//   POST /api/push/test         send this device a test notification
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import {
    RequestError, createSender, handleKey, handleSubscribe, handleTest, handleUnsubscribe, readJsonBody
} from '../lib/push-core.mjs';

const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

export default async (req) => {
    const store = getStore({ name: 'pulsegym-push', consistency: 'strong' });
    const url = new URL(req.url);
    const action = url.pathname.split('/').pop();
    try {
        let result;
        if (action === 'key' && req.method === 'GET') {
            result = await handleKey(store, { origin: url.origin, generateKeys: () => webpush.generateVAPIDKeys() });
        } else if (req.method !== 'POST') {
            throw new RequestError(405, 'Method not allowed');
        } else if (action === 'subscribe') {
            result = await handleSubscribe(store, await readJsonBody(req));
        } else if (action === 'unsubscribe') {
            result = await handleUnsubscribe(store, await readJsonBody(req));
        } else if (action === 'test') {
            result = await handleTest(store, await readJsonBody(req), createSender(webpush));
        } else {
            throw new RequestError(404, 'Not found');
        }
        return json(result.status, result.body);
    } catch (err) {
        if (err instanceof RequestError) return json(err.status, { error: err.message });
        console.error(err);
        return json(500, { error: 'Something went wrong' });
    }
};

export const config = { path: '/api/push/*' };
