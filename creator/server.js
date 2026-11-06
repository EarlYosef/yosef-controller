// Creator dashboard: only for you. Makes licenses, watches who is online, can switch a license off.
//
// Run on your computer:   CREATOR_PASSWORD=pick-a-long-password node creator/server.js
// On Render (Start Command: node creator/server.js) set these Environment variables:
//   CREATOR_PASSWORD         the password for this dashboard
//   LICENSE_PRIVATE_KEY_B64  your private key, as one line of base64 (see the steps)
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   free database, so licenses are kept
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const PORT = process.env.PORT || 5000;
const PASSWORD = process.env.CREATOR_PASSWORD || '';
if (PASSWORD.length < 8) {
    console.error('Set CREATOR_PASSWORD (at least 8 characters) before starting the dashboard.');
    process.exit(1);
}

// your private key: Render variable (one line of base64) or tools/private.pem on your own computer
let privateKey = null, publicKey = null;
try {
    const pem = process.env.LICENSE_PRIVATE_KEY_B64
        ? Buffer.from(process.env.LICENSE_PRIVATE_KEY_B64, 'base64').toString('utf8')
        : fs.readFileSync(path.join(__dirname, '..', 'tools', 'private.pem'), 'utf8');
    privateKey = crypto.createPrivateKey(pem);
    publicKey = crypto.createPublicKey(privateKey);
} catch (e) { console.warn('No private key found: licenses cannot be made until you add one.'); }

const DAYS = { '1m': 30, '3m': 90, '1y': 365, unlimited: 0 };
const PURGE_AFTER_MS = 7 * 86400000;     // an expired license disappears from the list after 7 days
const ONLINE_MS = 3 * 60000;             // "online now" = a sign of life in the last 3 minutes

const sessions = new Map();              // cookie -> time it stops working
const failedLogins = new Map();          // address -> times of wrong passwords
const live = new Map();                  // license id -> { at, info }  (only in memory)

/* ---------- small helpers ---------- */
const same = (a, b) => {
    const x = crypto.createHash('sha256').update(String(a)).digest();
    const y = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
};
const address = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

function send(res, code, body, type = 'application/json', extra = {}) {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    // web pages arrive as bytes (a Buffer): send them as they are. Only objects become JSON.
    res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => { data += c; if (data.length > 20000) { req.destroy(); resolve({}); } });
        req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
        req.on('error', () => resolve({}));
    });
}

function cookieOf(req, name) {
    const m = String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
    return m ? m.slice(name.length + 1) : '';
}
const signedIn = (req) => {
    const exp = sessions.get(cookieOf(req, 'sid'));
    return !!exp && exp > Date.now();
};

/* ---------- licenses ---------- */
function makeToken(data) {
    const part = Buffer.from(JSON.stringify(data)).toString('base64url');
    const sig = crypto.sign(null, Buffer.from(part), privateKey).toString('base64url');
    return part + '.' + sig;
}

function readToken(token) {   // -> license data, or null when the key is fake
    const [part, sig] = String(token || '').trim().split('.');
    if (!part || !sig || !publicKey) return null;
    try {
        if (!crypto.verify(null, Buffer.from(part), publicKey, Buffer.from(sig, 'base64url'))) return null;
        return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    } catch (e) { return null; }
}

const isExpired = (r) => !!r.expires && Date.now() > Date.parse(r.expires);
const statusOf = (r) => (r.disabled ? 'disabled' : isExpired(r) ? 'expired' : 'active');

async function loadClean() {   // licenses that ended more than 7 days ago disappear on their own
    let list = await store.load();
    const keep = list.filter((r) => r.deleted || !r.expires || Date.now() - Date.parse(r.expires) < PURGE_AFTER_MS);
    if (keep.length !== list.length) { list = keep; await store.save(list); }
    return list;
}

/* ---------- the dashboard's own API (needs the password) ---------- */
async function handleApi(req, res, url) {
    if (url.pathname === '/api/licenses' && req.method === 'GET') {
        const list = await loadClean();
        const rows = list.filter((r) => !r.deleted).map((r) => {
            const l = live.get(r.id);
            const online = !!l && Date.now() - l.at < ONLINE_MS;
            return { id: r.id, email: r.email, expires: r.expires, issued: r.issued, status: statusOf(r), token: r.token,
                online, lastSeen: l ? l.at : 0, info: online ? l.info : null };
        });
        const onlineRows = rows.filter((r) => r.online);
        return send(res, 200, {
            licenses: rows,
            summary: {
                active: rows.filter((r) => r.status === 'active').length,
                online: onlineRows.length,
                players: onlineRows.reduce((n, r) => n + ((r.info && r.info.players) || 0), 0),
                connected: onlineRows.reduce((n, r) => n + ((r.info && r.info.connected) || 0), 0)
            },
            permanent: store.permanent, canSign: !!privateKey
        });
    }

    if (url.pathname === '/api/licenses' && req.method === 'POST') {
        if (!privateKey) return send(res, 400, { error: 'No private key on this server yet.' });
        const b = await readBody(req);
        const email = String(b.email || '').trim().toLowerCase().slice(0, 120);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'Type a valid email, for example name@gmail.com.' });
        if (!(b.duration in DAYS)) return send(res, 400, { error: 'Pick how long the license lasts.' });
        const days = DAYS[b.duration];
        const record = {
            id: crypto.randomBytes(6).toString('hex'), email, plan: 'standard',
            issued: new Date().toISOString(),
            expires: days ? new Date(Date.now() + days * 86400000).toISOString() : ''
        };
        record.token = makeToken({ id: record.id, name: email, email, plan: record.plan, issued: record.issued, expires: record.expires });
        await store.locked(async () => { const list = await loadClean(); list.push(record); await store.save(list); });
        return send(res, 200, { ok: true, license: record });
    }

    const m = url.pathname.match(/^\/api\/licenses\/([a-f0-9]{12})(\/toggle)?$/);
    if (m && (req.method === 'POST' || req.method === 'DELETE')) {
        let found = false;
        await store.locked(async () => {
            const list = await loadClean();
            const r = list.find((x) => x.id === m[1] && !x.deleted);
            if (!r) return;
            found = true;
            if (req.method === 'DELETE') { r.deleted = true; r.token = ''; }   // kept as a tombstone so the key stops working at once
            else if (m[2]) r.disabled = !r.disabled;
            await store.save(list);
        });
        return send(res, found ? 200 : 404, { ok: found });
    }
    return send(res, 404, { error: 'Not found' });
}

/* ---------- what the customers' programs ask (no password: they prove themselves with the key) ---------- */
async function handleClient(req, res, url) {
    const b = await readBody(req);
    const data = readToken(b.token);
    if (!data) return send(res, 200, { status: 'invalid' });
    if (data.expires && Date.now() > Date.parse(data.expires)) return send(res, 200, { status: 'expired' });
    let status = 'ok';
    if (data.id) {   // keys made by hand (tools/make-license.js, no id) are simply accepted
        const r = (await store.load()).find((x) => x.id === data.id);
        if (r && (r.deleted || r.disabled)) status = 'revoked';
        else if (url.pathname === '/api/ping' && r) {
            const i = b.info || {};
            live.set(data.id, { at: Date.now(), info: {
                status: String(i.status || '').slice(0, 20), players: Math.max(0, Number(i.players) || 0) | 0,
                connected: Math.max(0, Number(i.connected) || 0) | 0, version: String(i.version || '').slice(0, 20) } });
        }
    }
    return send(res, 200, { status });
}

/* ---------- server ---------- */
const FILES = { '/': ['index.html', 'text/html; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://x');
        if (FILES[url.pathname] && req.method === 'GET') {
            return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', FILES[url.pathname][0])), FILES[url.pathname][1]);
        }
        if (url.pathname === '/api/check' || url.pathname === '/api/ping') {
            return req.method === 'POST' ? await handleClient(req, res, url) : send(res, 405, { error: 'POST only' });
        }
        if (url.pathname === '/api/me') return send(res, 200, { signedIn: signedIn(req) });
        if (url.pathname === '/login' && req.method === 'POST') {
            const ip = address(req);
            const recent = (failedLogins.get(ip) || []).filter((t) => Date.now() - t < 600000);
            if (recent.length >= 5) return send(res, 429, { error: 'Too many wrong passwords. Wait 10 minutes.' });
            const b = await readBody(req);
            if (!same(b.password || '', PASSWORD)) {
                recent.push(Date.now()); failedLogins.set(ip, recent);
                return send(res, 401, { error: 'Wrong password.' });
            }
            const sid = crypto.randomBytes(24).toString('hex');
            sessions.set(sid, Date.now() + 12 * 3600000);
            const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
            return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}` });
        }
        if (url.pathname === '/logout' && req.method === 'POST') {
            sessions.delete(cookieOf(req, 'sid'));
            return send(res, 200, { ok: true });
        }
        if (url.pathname.startsWith('/api/')) {
            if (!signedIn(req)) return send(res, 401, { error: 'Sign in first.' });
            return await handleApi(req, res, url);
        }
        send(res, 404, 'Not found', 'text/plain');
    } catch (e) {
        console.error('Dashboard error:', e.message);
        send(res, 500, { error: 'Something went wrong. Try again.' });
    }
});

server.listen(PORT, () => console.log(`Creator dashboard on port ${PORT}` + (store.permanent ? ' (licenses are kept in the database).' : ' (licenses are kept in a file: not permanent on Render).')));