// PulseGym service worker: lets the app open with no signal at the gym.
// Bump CACHE when changing this file's precache list.
const CACHE = 'pulsegym-v1';
const SHELL_URL = new URL('./', self.registration.scope).href;
const LOCAL_FILES = ['./', './manifest.webmanifest', './apple-touch-icon.png', './icon-192.png', './icon-512.png'];
const CDN_FILES = [
    'https://cdn.tailwindcss.com',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500;700;800&display=swap'
];
const CDN_HOSTS = ['cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        await cache.addAll(LOCAL_FILES);
        // CDN files come back opaque (no CORS), which addAll rejects, so cache them one by one
        await Promise.all(CDN_FILES.map(async (url) => {
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

// Page loads: try the network first (so new deploys show up), fall back to the cached app after 3s
async function handleNavigation(event) {
    const cache = await caches.open(CACHE);
    const fromNetwork = fetch(event.request).then(async (res) => {
        if (res.ok) await cache.put(SHELL_URL, await cleanResponse(res.clone()));
        return res;
    });
    event.waitUntil(fromNetwork.catch(() => {}));

    const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT_MS));
    try {
        const res = await Promise.race([fromNetwork, timeout]);
        if (res) return await cleanResponse(res);
    } catch (e) {}

    const cached = await cache.match(SHELL_URL);
    if (cached) return cached;
    return fromNetwork; // nothing cached yet: keep waiting on the network
}

// Icons, Tailwind and fonts: serve from cache instantly, refresh in the background
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

    if (req.mode === 'navigate' && url.origin === self.location.origin) {
        event.respondWith(handleNavigation(event));
    } else if (url.origin === self.location.origin || CDN_HOSTS.includes(url.hostname)) {
        event.respondWith(handleAsset(event));
    }
});
