// PulseGym service worker: lets the app open with no signal at the gym.
// Bump CACHE when changing this file's precache list.
const CACHE = 'pulsegym-v2';
const SHELL_URL = new URL('./', self.registration.scope).href;
const STYLES_URL = new URL('./styles.css', self.registration.scope).href;
const LOCAL_FILES = ['./', './styles.css', './manifest.webmanifest', './apple-touch-icon.png', './icon-192.png', './icon-512.png'];
const FONT_FILES = [
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500;700;800&display=swap'
];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const NETWORK_TIMEOUT_MS = 3000;

// Whether the page being opened came fresh from the network. Its stylesheet is taken from the same
// place, so a new page never meets old styles (or the reverse).
let pageFromNetwork = false;

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        await cache.addAll(LOCAL_FILES);
        // Font files come back opaque (no CORS), which addAll rejects, so cache them one by one
        await Promise.all(FONT_FILES.map(async (url) => {
            try {
                const res = await fetch(new Request(url, { mode: 'no-cors' }));
                await cache.put(url, res);
            } catch (e) {}
        }));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});

// Safari refuses redirected responses for navigations, so store a clean copy
async function cleanResponse(res) {
    if (!res.redirected) return res;
    const body = await res.blob();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

function networkTimeout() {
    return new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT_MS));
}

// The cached page and stylesheet are only ever replaced together, so an offline launch gets a matching pair
async function cacheAppPair(cache, page) {
    const styles = await fetch(STYLES_URL, { cache: 'no-cache' });
    if (!styles.ok) return;
    await cache.put(STYLES_URL, styles);
    await cache.put(SHELL_URL, await cleanResponse(page));
}

// Page loads: try the network first (so new deploys show up), fall back to the cached app after 3s
async function handleNavigation(event) {
    const cache = await caches.open(CACHE);
    let caching = Promise.resolve();
    const fromNetwork = fetch(event.request).then((res) => {
        if (res.ok) caching = cacheAppPair(cache, res.clone());
        return res;
    });
    event.waitUntil(fromNetwork.then(() => caching).catch(() => {}));

    try {
        const res = await Promise.race([fromNetwork, networkTimeout()]);
        if (res) {
            pageFromNetwork = true;
            return await cleanResponse(res);
        }
    } catch (e) {}

    const cached = await cache.match(SHELL_URL);
    pageFromNetwork = !cached;
    return cached || fromNetwork; // nothing cached yet: keep waiting on the network
}

// Stylesheet: fresh with a fresh page, otherwise the copy cached alongside the cached page
async function handleStyles(event) {
    let fromNetwork = null;
    if (pageFromNetwork) {
        fromNetwork = fetch(event.request);
        try {
            const res = await Promise.race([fromNetwork, networkTimeout()]);
            if (res) return res;
        } catch (e) {}
    }
    return (await caches.match(STYLES_URL)) || fromNetwork || fetch(event.request);
}

// Icons and fonts: serve from cache instantly, refresh in the background
async function handleAsset(event) {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(event.request);
    const fromNetwork = fetch(event.request).then(async (res) => {
        if (res.ok || res.type === 'opaque') await cache.put(event.request, res.clone());
        return res;
    });
    if (cached) {
        event.waitUntil(fromNetwork.catch(() => {}));
        return cached;
    }
    return fromNetwork;
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
        return; // the push API: always straight to the server, never cached
    } else if (req.mode === 'navigate' && url.origin === self.location.origin) {
        event.respondWith(handleNavigation(event));
    } else if (url.href === STYLES_URL) {
        event.respondWith(handleStyles(event));
    } else if (url.origin === self.location.origin || FONT_HOSTS.includes(url.hostname)) {
        event.respondWith(handleAsset(event));
    }
});

// Training reminders pushed by the server (netlify/functions/push-reminders.mjs). iPhone requires
// every push to show a notification, so one is always shown.
self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) {}
    event.waitUntil(self.registration.showNotification(data.title || 'PulseGym', {
        body: data.body || 'Time to train! 💪',
        tag: data.tag || 'pulsegym',
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        data: { url: data.url || './' }
    }));
});

// Tapping a notification brings PulseGym to the front (or opens it)
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const open = windows.find(w => new URL(w.url).origin === self.location.origin);
        if (open) return open.focus();
        return self.clients.openWindow(SHELL_URL);
    })());
});
