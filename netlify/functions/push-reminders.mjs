// Runs every 5 minutes on Netlify and sends any training reminders that are due
// (times are worked out in each device's own time zone).
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import { createSender, sendDueReminders } from '../lib/push-core.mjs';

export default async () => {
    const store = getStore({ name: 'pulsegym-push', consistency: 'strong' });
    const result = await sendDueReminders(store, createSender(webpush));
    console.log(`Checked ${result.checked} device(s), sent ${result.sent} reminder(s), removed ${result.removed}`);
};

export const config = { schedule: '*/5 * * * *' };
