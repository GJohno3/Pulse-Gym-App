// Shared setup for the test suites: serves site/ with the same headers Netlify sends (so every suite
// runs under the live Content Security Policy), launches Chromium and collects pass/fail checks.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');

const repoDir = path.join(__dirname, '..');
const siteDir = path.join(repoDir, 'site');
const outDir = path.join(__dirname, 'output');
fs.mkdirSync(outDir, { recursive: true });

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
    '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};

// [headers.values] from the netlify.toml next to `rootDir` (none for folders outside a site)
function netlifyHeaders(rootDir) {
    const toml = path.join(rootDir, '..', 'netlify.toml');
    if (!fs.existsSync(toml)) return {};
    const out = {};
    let inValues = false;
    for (const line of fs.readFileSync(toml, 'utf8').split('\n')) {
        if (/^\s*\[/.test(line)) inValues = /^\s*\[headers\.values\]/.test(line);
        const m = inValues && line.match(/^\s*([A-Za-z-]+)\s*=\s*"(.*)"\s*$/);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

function responseHeaders(file, rootDir) {
    return { ...netlifyHeaders(rootDir), 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' };
}

// Static server for `dir`. `before(req, res)` can answer a request itself by returning true.
function serveDir(dir = siteDir, { before } = {}) {
    const server = http.createServer((req, res) => {
        if (before && before(req, res)) return;
        let p = decodeURIComponent(req.url.split('?')[0]);
        if (p.endsWith('/')) p += 'index.html';
        const f = path.join(dir, p);
        if (!f.startsWith(dir) || !fs.existsSync(f)) {
            res.writeHead(404);
            return res.end('not found');
        }
        res.writeHead(200, responseHeaders(f, dir));
        fs.createReadStream(f).pipe(res);
    }).listen(0);
    server.url = () => `http://localhost:${server.address().port}/`;
    return server;
}

function createChecks() {
    const checks = [];
    const check = (name, actual, expected) => {
        const ok = typeof expected === 'function' ? !!expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
        checks.push({ ok, name, actual: ok ? undefined : actual, expected: ok || typeof expected === 'function' ? undefined : expected });
    };
    const report = () => {
        checks.forEach(c => console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.actual)}${c.expected !== undefined ? ` want=${JSON.stringify(c.expected)}` : ''}`}`));
        const passed = checks.filter(c => c.ok).length;
        console.log(`\n${passed}/${checks.length} passed`);
        if (passed !== checks.length || !checks.length) process.exitCode = 1;
    };
    return { checks, check, report };
}

// iPhone-sized page with fonts blocked (they're from Google), page errors and CSP violations recorded
async function phonePage(browser, options = {}) {
    const ctx = await browser.newContext({
        ...devices['iPhone 15 Pro'], viewport: { width: 402, height: 874 }, serviceWorkers: 'block', locale: 'en-GB', ...options
    });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    const page = await ctx.newPage();
    page.errors = [];
    page.csp = [];
    page.on('pageerror', e => page.errors.push(e.message));
    page.on('console', m => { if (/Content Security Policy/i.test(m.text())) page.csp.push(m.text()); });
    page.on('dialog', d => d.accept());
    return { ctx, page, errors: page.errors };
}

// The parts of the Netlify Blobs store API the push code uses
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

module.exports = {
    chromium, devices, repoDir, siteDir, outDir, responseHeaders, serveDir, createChecks, phonePage, memoryStore,
    launch: () => chromium.launch()
};
