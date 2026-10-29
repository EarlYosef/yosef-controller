const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const { spawn } = require('child_process');

const VIEWER_PORT = 3000;
const SCREEN_PORT = 3001;   // only this computer can reach it: the admin page sends the shared screen here

/* ================= Virtual controller (Linux, via pad.py + uinput) ================= */

let padOk = true;
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const pad = spawn(PYTHON, [path.join(__dirname, 'pad.py')], { stdio: ['pipe', 'inherit', 'inherit'] });

// Don't crash the server if pad.py stops (for example, missing uinput permission)
pad.stdin.on('error', (err) => { padOk = false; console.error('pad.py is not accepting input:', err.code); });
pad.on('error', (err) => { padOk = false; console.error('Could not start pad.py:', err.message); });
pad.on('exit', (code) => {
    padOk = false;
    console.error(`pad.py exited (code ${code}). On Linux check uinput permission / run with sudo. On Windows check that vgamepad is installed.`);
    sendState();
});

const VALID_BUTTONS = new Set([
    'UP', 'DOWN', 'LEFT', 'RIGHT',
    '1', '2', '3', '4',
    'L1', 'L2', 'R1', 'R2',
    'SELECT', 'START'
]);

function padSend(action, button) {
    if (pad.stdin.writable) pad.stdin.write(`${action} ${button}\n`);
    // let the admin panel / OBS overlay see which buttons are pressed
    if (process.send && process.connected) {
        try { process.send({ type: 'input', action, button }); } catch (e) {}
    }
}

function handleInput(ws, { button, action }) {
    const who = clients.get(ws);
    if (who) who.lastInput = Date.now();   // shown in the admin page
    if (settings.frozen) return; // Block all inputs when paused
    if (!VALID_BUTTONS.has(button)) return;
    if (action !== 'press' && action !== 'release') return;
    
    // Route inputs depending on whether it's Player 2 or Player 3
    let padPrefix = '';
    if (ws === currentP3) {
        padPrefix = 'P3_'; 
    }
    padSend(action === 'press' ? 'PRESS' : 'RELEASE', padPrefix + button);
}

function releaseAll() {
    VALID_BUTTONS.forEach(b => {
        padSend('RELEASE', b);
        padSend('RELEASE', 'P3_' + b);
    });
}

/* ================= Who can play (P2 & P3 support + Match Mode) ================= */

// The streamer panel (admin.js) sends these. Without it, these defaults are used.
const settings = {
    locked: false,      // true = nobody new can join
    code: '',           // not empty = viewers must type this code to join
    turnSeconds: 180,   // 0 = no time limit; otherwise the player rotates when others are waiting
    frozen: false,      // true = all inputs are ignored (emergency stop / pause)
    maxPlayers: 0,      // 0 = unlimited; otherwise the game locks itself when this many have joined
    mode: 'vvw',        // 'vvw' = Viewer vs Viewer (2 players), 'svv' = Streamer vs Viewer (1 player)
    spectate: true      // viewers waiting in line can watch the match (a small, light picture)
};

const clients = new Map();   // ws -> { id, name, joined, ip, msgs }
const waiting = [];          // ws objects waiting for a turn, in order
// Blocked viewers (address -> name). Saved to bans.json so blocks survive a restart.
const BAN_FILE = path.join(__dirname, 'bans.json');
const bannedIPs = new Map();
try {
    for (const [ip, name] of Object.entries(JSON.parse(fs.readFileSync(BAN_FILE, 'utf8')))) bannedIPs.set(ip, String(name));
} catch (e) { /* no saved blocks yet */ }
function saveBans() {
    try { fs.writeFileSync(BAN_FILE, JSON.stringify(Object.fromEntries(bannedIPs))); } catch (e) {}
}
// People who lost connection: they keep their place in line for 30 seconds (token -> place)
const recent = new Map();
let currentP2 = null;        // Active Player 2 slot
let currentP3 = null;        // Active Player 3 slot
let currentSince = 0;
let nextId = 1;
let lastClosed = false;      // was the game closed to new players at the last check?
let shareWs = null;          // the admin page while it is sharing the screen
const MAX_INFLIGHT = 3;      // pictures allowed on their way to the player at once
let signalWs = null;
let audioWs = null;          // the admin page while it is sending game sound         // the admin page's line for setting up the fast video link
let latest = null;           // the newest picture from the admin page
let latestSeq = 0;
let latestSpec = null;       // the newest SMALL picture, for the people watching from the waiting line
let latestSpecSeq = 0;
const MAX_SPECTATORS = 5;    // how many waiting viewers receive the picture (each one costs your upload)
let delivered = 0, dropped = 0;

function joinedCount() {
    let n = 0;
    for (const c of clients.values()) if (c.joined) n++;
    return n;
}
function isFull() {
    return settings.maxPlayers > 0 && joinedCount() >= settings.maxPlayers;
}

function wsSend(ws, obj) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// Words you do not want on your stream: put them in blocked-words.txt (one per line). Names show on the OBS overlay.
let blockedWords = [];
try {
    blockedWords = fs.readFileSync(path.join(__dirname, 'blocked-words.txt'), 'utf8')
        .split(/\r?\n/).map((w) => w.trim().toLowerCase()).filter((w) => w && !w.startsWith('#'));
} catch (e) { /* no list yet */ }

function cleanName(s) {
    const n = String(s || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 20);
    const flat = n.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!n || /https?|www|\.(com|net|org|ph|io|gg|tv|me|co|ly)\b/i.test(String(s || '')) || blockedWords.some((w) => flat.includes(w.replace(/[^a-z0-9]/g, '')))) {
        return 'Viewer';   // links, advertising and blocked words never reach your stream
    }
    return n;
}

// Behind the public link, the real address of a viewer is in these headers
function clientIP(req) {
    const cf = req.headers['cf-connecting-ip'];
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return cf || xff || req.socket.remoteAddress;
}

function secondsLeft() {
    const activeCount = settings.mode === 'svv' ? !!currentP2 : (!!currentP2 || !!currentP3);
    if (!activeCount || !settings.turnSeconds || waiting.length === 0) return null;
    return Math.max(0, settings.turnSeconds - Math.floor((Date.now() - currentSince) / 1000));
}

function fillSlot() {
    if (!settings.frozen) {
        if (!currentP2 && waiting.length) {
            currentP2 = waiting.shift();
            currentSince = Date.now();
        }
        // Only fill P3 slot if mode is Viewer vs Viewer ('vvw')
        if (settings.mode === 'vvw' && !currentP3 && waiting.length) {
            currentP3 = waiting.shift();
        }
    }
}

// Rotate active players to the back of the line, next ones play
function rotate() {
    if (waiting.length === 0) return;
    releaseAll();
    if (currentP2) waiting.push(currentP2);
    if (settings.mode === 'vvw' && currentP3) waiting.push(currentP3);
    
    currentP2 = waiting.shift();
    if (settings.mode === 'vvw') {
        currentP3 = waiting.shift();
    } else {
        currentP3 = null; 
    }
    currentSince = Date.now();
}

function handleRtcFromPlayer(ws, c, msg) {
    if (ws !== currentP2) return;   // the fast video link is for Player 2 only; Player 3 gets pictures
    if (msg.rtc === 'connected') { c.rtcOk = true; return; }          
    if (msg.rtc === 'failed') { c.rtcOk = false; pumpFrame(); return; }  
    if ((msg.rtc === 'answer' || msg.rtc === 'ice') && signalWs && signalWs.readyState === WebSocket.OPEN) {
        signalWs.send(JSON.stringify({
            rtc: msg.rtc,
            sdp: String(msg.sdp || '').slice(0, 12000),
            candidate: msg.candidate && typeof msg.candidate === 'object' ? msg.candidate : undefined
        }));
    }
}

// The first few viewers waiting in line can watch the match (a small, light picture)
function spectators() {
    return settings.spectate && shareWs ? waiting.slice(0, MAX_SPECTATORS) : [];
}

function updateScreenState() {
    let newPlayer = false;
    const watching = new Set(spectators());
    for (const [ws, c] of clients) {
        const on = !!shareWs && (ws === currentP2 || ws === currentP3);
        const spec = !on && watching.has(ws);
        const mode = on ? 'p' : spec ? 's' : '';
        if (c.screenMode !== mode) {
            c.screenMode = mode;
            if (on || spec) { c.inflight = 0; c.sentSeq = -1; c.rtcOk = false; c.sentAt = []; c.rtt = 0; }
            if (on && ws === currentP2) newPlayer = true;
            wsSend(ws, { role: 'screen', live: on || spec, spectate: spec });
        }
        const hearing = !!audioWs && on;   // only the players get the game sound
        if (c.audioLive !== hearing) { c.audioLive = hearing; wsSend(ws, { role: 'audio', live: hearing }); }
    }
    if (newPlayer && signalWs && signalWs.readyState === WebSocket.OPEN) signalWs.send(JSON.stringify({ rtc: 'newplayer' }));
    pumpFrame();
    pumpSpectators();
}

// A slow link gets fewer pictures on the way at once, so the delay cannot pile up
function maxInflightFor(c) {
    return c.rtt > 400 ? 1 : c.rtt > 200 ? 2 : MAX_INFLIGHT;
}

function pumpFrameToClient(targetWs, spec) {
    const buf = spec ? latestSpec : latest;
    const seq = spec ? latestSpecSeq : latestSeq;
    if (!shareWs || !buf || !targetWs || targetWs.readyState !== WebSocket.OPEN) return;
    const c = clients.get(targetWs);
    if (!c) return;
    if (!spec && c.rtcOk) return;   
    const limit = maxInflightFor(c);
    if (c.inflight >= limit && Date.now() - c.lastAck > 2000) { c.inflight = 0; c.sentAt = []; }
    if (c.inflight >= limit || c.sentSeq === seq) return;
    if (c.inflight === 0) { c.lastAck = Date.now(); c.sentAt = []; }
    c.inflight++;
    c.sentAt.push(Date.now());
    c.sentSeq = seq;
    if (!spec) delivered++;
    targetWs.send(buf, { binary: true });
}

function pumpSpectators() {
    spectators().forEach((w) => pumpFrameToClient(w, true));
}

function pumpFrame() {
    if (currentP2) pumpFrameToClient(currentP2);
    if (currentP3) pumpFrameToClient(currentP3);
}

function notifyClients() {
    updateScreenState();
    const closed = settings.locked || isFull();
    if (closed !== lastClosed) { lastClosed = closed; sendHelloToUnjoined(); }

    const left = secondsLeft();
    for (const [ws, c] of clients) {
        if (!c.joined) continue;
        if (ws === currentP2) {
            wsSend(ws, { role: 'player', playerNum: 2, secondsLeft: left });
        } else if (ws === currentP3) {
            wsSend(ws, { role: 'player', playerNum: 3, secondsLeft: left });
        } else {
            const i = waiting.indexOf(ws);
            if (i >= 0) wsSend(ws, { role: 'queued', position: i + 1, total: waiting.length });
        }
    }
    sendState();
}

function sendHelloToUnjoined() {
    for (const [ws, c] of clients) {
        if (!c.joined) wsSend(ws, { role: 'hello', needCode: !!settings.code, locked: settings.locked || isFull() });
    }
}

function removeClient(ws, keep = true) {
    const c = clients.get(ws);
    if (keep && c && c.joined && c.token) {
        recent.set(c.token, { wasCurrent: ws === currentP2 || ws === currentP3, pos: waiting.indexOf(ws), at: Date.now() });
    }
    clients.delete(ws);
    const i = waiting.indexOf(ws);
    if (i >= 0) waiting.splice(i, 1);
    if (ws === currentP2 || ws === currentP3) {
        if (ws === currentP2) currentP2 = null;
        if (ws === currentP3) currentP3 = null;
        releaseAll();   
        fillSlot();
    }
    notifyClients();
}

function handleJoin(ws, c, msg) {
    if (c.joined) return;
    const token = String(msg.token || '').slice(0, 40);
    const r = token ? recent.get(token) : null;
    const back = !!(r && Date.now() - r.at < 30000);   
    if (settings.locked) { wsSend(ws, { role: 'locked' }); return; }
    if (!back && isFull()) { wsSend(ws, { role: 'locked', full: true }); return; }
    if (settings.code && String(msg.code || '').trim() !== settings.code) {
        wsSend(ws, { role: 'denied', reason: 'Wrong join code.' });
        return;
    }
    c.name = cleanName(msg.name);
    c.joined = true;
    c.token = token;
    if (back) {
        recent.delete(token);
        if (r.wasCurrent && (!currentP2 || (settings.mode === 'vvw' && !currentP3))) {
            if (!currentP2) currentP2 = ws;
            else if (settings.mode === 'vvw' && !currentP3) currentP3 = ws;
            currentSince = Date.now();
        } else {
            waiting.splice(Math.min(Math.max(r.pos, 0), waiting.length), 0, ws);
        }
    } else {
        waiting.push(ws);
    }
    fillSlot();
    notifyClients();
    console.log(`${c.name} joined.`);
}

/* ================= Viewer server ================= */

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 16384 });   
wss.on('error', () => {});   // the clear "port already in use" message below handles this

wss.on('connection', (ws, req) => {
    const reqUrl = String(req.url || '');
    if (reqUrl.includes('audio=1')) {
        // a viewer's own line for game sound, so a big picture can never hold the sound up (that made it crackle)
        const t = (reqUrl.match(/[?&]t=([A-Za-z0-9]+)/) || [])[1] || '';
        let owner = null;
        for (const c of clients.values()) if (t && c.token === t) owner = c;
        if (!owner) { ws.close(); return; }
        owner.audioSock = ws;
        ws.on('close', () => { if (owner.audioSock === ws) owner.audioSock = null; });
        ws.on('error', () => {});
        return;
    }
    const ip = clientIP(req);
    if (bannedIPs.has(ip) || clients.size >= 300) {
        wsSend(ws, { role: 'banned' });
        ws.close();
        return;
    }
    let sameAddress = 0;
    for (const o of clients.values()) if (o.ip === ip) sameAddress++;
    if (sameAddress >= 10) {   // protects against one person opening hundreds of tabs
        wsSend(ws, { role: 'denied', reason: 'Too many connections from your network.' });
        ws.close();
        return;
    }

    const c = { id: nextId++, name: 'Viewer', joined: false, ip, msgs: 0, inflight: 0, sentSeq: -1, lastAck: 0, rtcOk: false, sentAt: [], rtt: 0 };
    clients.set(ws, c);
    wsSend(ws, { role: 'hello', needCode: !!settings.code, locked: settings.locked || isFull() });
    sendState();

    ws.on('message', (raw) => {
        const me = clients.get(ws);
        if (!me) return;
        if (String(raw) === 'a') {   // picture received: not counted as a button press
            me.inflight = Math.max(0, me.inflight - 1);
            me.lastAck = Date.now();
            const sentTime = me.sentAt.shift();   // how long that picture took to arrive (the link's delay)
            if (sentTime) { const r = Date.now() - sentTime; me.rtt = me.rtt ? me.rtt * 0.7 + r * 0.3 : r; }
            if (ws === currentP2 || ws === currentP3) pumpFrameToClient(ws);
            else if (me.screenMode === 's') pumpFrameToClient(ws, true);
            return;
        }
        if (++me.msgs > 300) return;   // flood protection (per second)
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }
        if (!msg || typeof msg !== 'object') return;

        if (msg.rtc) { handleRtcFromPlayer(ws, me, msg); return; }
        if (msg.type === 'join') { handleJoin(ws, me, msg); return; }
        if ((ws === currentP2 || ws === currentP3)) handleInput(ws, msg);
    });

    ws.on('close', () => removeClient(ws));
    ws.on('error', () => {});
});

/* ================= Shared screen ================= */

const feed = new WebSocket.Server({
    host: '127.0.0.1',
    port: SCREEN_PORT,
    maxPayload: 1024 * 1024,
    verifyClient: ({ origin }) => origin === 'http://127.0.0.1:4000' || origin === 'http://localhost:4000'
});

feed.on('connection', (ws, req) => {
    if (String(req && req.url).includes('audio')) {   // game sound from the admin page
        if (audioWs) { try { audioWs.close(); } catch (e) {} }
        audioWs = ws;
        updateScreenState();
        ws.on('message', (data) => {
            if (ws !== audioWs) return;
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (buf[0] !== 2 && buf[0] !== 3) return;   // sound packets start with 2 (8-bit) or 3 (16-bit)
            for (const p of [currentP2, currentP3]) {
                if (!p) continue;
                const pc = clients.get(p);
                const line = pc && pc.audioSock && pc.audioSock.readyState === WebSocket.OPEN ? pc.audioSock : p;
                // a player whose connection is badly behind skips sound instead of hearing it late
                if (line.readyState === WebSocket.OPEN && line.bufferedAmount < 200000) line.send(buf, { binary: true });
            }
        });
        ws.on('close', () => { if (ws === audioWs) { audioWs = null; updateScreenState(); } });
        ws.on('error', () => {});
        return;
    }
    if (String(req && req.url).includes('signal')) {   
        if (signalWs) { try { signalWs.close(); } catch (e) {} }
        signalWs = ws;
        if (shareWs && currentP2) ws.send(JSON.stringify({ rtc: 'newplayer' }));
        ws.on('message', (data) => {
            let m; try { m = JSON.parse(data); } catch (e) { return; }
            if (!m || !currentP2 || (m.rtc !== 'offer' && m.rtc !== 'ice')) return;
            wsSend(currentP2, { role: 'rtc', type: m.rtc, sdp: String(m.sdp || '').slice(0, 12000), candidate: m.candidate });
        });
        ws.on('close', () => { if (ws === signalWs) signalWs = null; });
        ws.on('error', () => {});
        return;
    }
    if (shareWs) { try { shareWs.close(); } catch (e) {} }   
    shareWs = ws;
    updateScreenState();

    ws.on('message', (data, isBinary) => {
        if (ws !== shareWs) return;
        const binary = isBinary === true || (isBinary === undefined && typeof data !== 'string');
        if (!binary) return;
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf[0] === 1) {   // a small picture for the people watching from the waiting line
            latestSpec = buf.subarray(1);
            latestSpecSeq++;
            pumpSpectators();
            return;
        }
        const cur2 = currentP2 && clients.get(currentP2);
        const cur3 = currentP3 && clients.get(currentP3);
        if (latest && ((cur2 && !cur2.rtcOk && cur2.sentSeq !== latestSeq) || (cur3 && !cur3.rtcOk && cur3.sentSeq !== latestSeq))) dropped++;
        latest = buf;
        latestSeq++;
        pumpFrame();
    });
    ws.on('close', () => {
        if (ws === shareWs) { shareWs = null; latest = null; latestSpec = null; updateScreenState(); }
    });
    ws.on('error', () => {});
});
feed.on('error', (err) => console.error('Screen feed could not start:', err.message));

/* ================= Admin operations ================= */

function findClient(id) {
    for (const [ws, c] of clients) if (c.id === id) return ws;
    return null;
}

function applySettings(s) {
    if (!s || typeof s !== 'object') return;
    settings.locked = !!s.locked;
    settings.code = String(s.code || '').trim().slice(0, 20);
    const t = Number(s.turnSeconds);
    settings.turnSeconds = isFinite(t) ? Math.min(Math.max(Math.round(t), 0), 3600) : 180;
    settings.frozen = !!s.frozen;
    const mp = Number(s.maxPlayers);
    settings.maxPlayers = isFinite(mp) ? Math.min(Math.max(Math.round(mp), 0), 100) : 0;
    settings.mode = s.mode === 'svv' ? 'svv' : 'vvw';
    settings.spectate = s.spectate !== false;
    
    if (settings.mode === 'svv' && currentP3) {
        waiting.unshift(currentP3);
        currentP3 = null;
    }
    if (settings.frozen) releaseAll();
    fillSlot();   // switching back to two players: the next waiting viewer takes the free Player 3 slot
    sendHelloToUnjoined();
}

function handleAdmin(msg) {
    switch (msg.cmd) {
        case 'skip':
            rotate();
            break;
        case 'promote': {
            const ws = findClient(msg.id);
            const i = waiting.indexOf(ws);
            if (i >= 0) {
                waiting.splice(i, 1);
                if (currentP2) { releaseAll(); waiting.unshift(currentP2); }
                currentP2 = ws;
                currentSince = Date.now();
            }
            break;
        }
        case 'kick': {
            const ws = findClient(msg.id);
            if (ws) {
                console.log((msg.ban ? 'Banned ' : 'Kicked ') + (clients.get(ws) || {}).name);
                if (msg.ban) { const k = clients.get(ws); bannedIPs.set(k.ip, k.name); saveBans(); }
                wsSend(ws, { role: msg.ban ? 'banned' : 'kicked' });
                removeClient(ws, false);
                setTimeout(() => ws.terminate(), 300);
            }
            break;
        }
        case 'unban':
            if (msg.ip) bannedIPs.delete(String(msg.ip)); else bannedIPs.clear();
            saveBans();
            break;
    }
}

function snapshot() {
    const cur2 = currentP2 ? clients.get(currentP2) : null;
    const cur3 = currentP3 ? clients.get(currentP3) : null;
    
    let currentDesc = 'Nobody playing';
    if (settings.mode === 'svv') {
        currentDesc = cur2 ? `Streamer vs ${cur2.name}` : 'Waiting for Player';
    } else {
        currentDesc = `${cur2 ? cur2.name : 'None (P2)'} vs ${cur3 ? cur3.name : 'None (P3)'}`;
    }

    return {
        type: 'state',
        padOk,
        p2: cur2 ? { id: cur2.id, name: cur2.name, idle: cur2.lastInput ? Math.round((Date.now() - cur2.lastInput) / 1000) : null } : null,
        p3: cur3 ? { id: cur3.id, name: cur3.name, idle: cur3.lastInput ? Math.round((Date.now() - cur3.lastInput) / 1000) : null } : null,
        current: (cur2 || (settings.mode === 'vvw' && cur3)) ? { 
            name: currentDesc, 
            secondsLeft: secondsLeft() 
        } : null,
        queue: waiting.map(ws => ({ id: clients.get(ws).id, name: clients.get(ws).name })),
        connected: clients.size,
        players: joinedCount(),
        full: isFull(),
        spectating: spectators().length,
        sharing: !!shareWs,
        banned: [...bannedIPs].map(([ip, name]) => ({ ip, name }))
    };
}

function sendState() {
    if (process.send && process.connected) {
        try { process.send(snapshot()); } catch (e) {}
    }
}

process.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'settings') applySettings(msg.settings);
    else if (msg.type === 'admin') handleAdmin(msg);
    notifyClients();
});

/* ================= Timer, start-up, shutdown ================= */

setInterval(() => {
    for (const c of clients.values()) c.msgs = 0;
    if (shareWs && shareWs.readyState === WebSocket.OPEN) {
        const active = [currentP2, currentP3].filter(Boolean).map((w) => clients.get(w)).filter(Boolean);
        shareWs.send(JSON.stringify({ stats: { sent: delivered, dropped, spec: spectators().length, rtc: active.length > 0 && active.every((c) => c.rtcOk), rtt: Math.round(Math.max(0, ...active.map((c) => c.rtt || 0))) } }));
    }
    delivered = 0; dropped = 0;
    for (const [t, r] of recent) if (Date.now() - r.at > 30000) recent.delete(t);
    
    const requiredWaiting = settings.mode === 'vvw' ? 2 : 1;
    if ((currentP2 || currentP3) && settings.turnSeconds && waiting.length >= requiredWaiting &&
        Date.now() - currentSince >= settings.turnSeconds * 1000) {
        rotate();
    }
    notifyClients();
}, 1000);

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${VIEWER_PORT} is already in use.`);
    } else {
        console.error('Server error:', err.message);
    }
    process.exit(1);
});

// Private by default: only this computer (where the tunnel runs) can reach the server, so nobody on your
// Wi-Fi can walk around the tunnel. For testing from a phone on your Wi-Fi, tick "open on my Wi-Fi" in the admin page.
const HOST = process.env.LAN === '1' ? '0.0.0.0' : '127.0.0.1';
server.listen(VIEWER_PORT, HOST, () => {
    console.log(`Controller server running on port ${VIEWER_PORT}` + (HOST === '0.0.0.0' ? ' (open on your Wi-Fi).' : '.'));
    if (process.send) process.send({ type: 'ready' });
});

process.on('uncaughtException', (err) => { console.error('Server crashed:', err && err.stack || err); process.exit(1); });

function shutdown() { process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('disconnect', shutdown);