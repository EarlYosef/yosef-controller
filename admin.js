// Run with:  node admin.js   (use sudo on Linux if pad.py needs uinput permission)
// Then open http://127.0.0.1:4000 and press Connect.
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const { fork, spawn, execFile } = require('child_process');
const license = require('./license');

const ADMIN_PORT = 4000;     // admin panel (this computer only)
const VIEWER_PORT = 3000;    // must match server.js
const CLOUDFLARED = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
const VERSION = '1.0.0';
const TRIAL_MS = 30 * 60 * 1000;   // without a license, one session lasts 30 minutes

let status = 'offline';      // offline | starting | online | stopping
let message = 'Press Connect to open the controller.';
let link = '';
let serverProc = null, tunnelProc = null, serverState = null;
let settings = { locked: false, code: '', turnSeconds: 180, frozen: false, maxPlayers: 0, mode: 'vvw', spectate: true, lan: false };
let lic = license.check();
let trialTimer = null;

/* ---------- Log (kept in memory for "Copy diagnostics", and in logs/admin.log) ---------- */
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'admin.log');
const logLines = [];
try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1000000) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
} catch (e) {}
function log(...parts) {
    const text = parts.join(' ');
    logLines.push(new Date().toISOString().slice(11, 19) + ' ' + text);
    if (logLines.length > 300) logLines.shift();
    try { fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + text + '\n'); } catch (e) {}
}
log('admin.js started, version', VERSION, process.platform, 'node', process.version);

function lanAddress() {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list) if (a.family === 'IPv4' && !a.internal) return a.address;
    }
    return '';
}

function diagnostics() {
    const s = serverState || {};
    return [
        `Controller diagnostics (version ${VERSION})`,
        `Time: ${new Date().toISOString()}`,
        `System: ${process.platform} ${os.release()}, Node ${process.version}`,
        `Status: ${status} - ${message}`,
        `License: ${lic.valid ? 'valid' : 'trial'}${lic.name ? ' (' + lic.name + ')' : ''}${lic.reason ? ' - ' + lic.reason : ''}`,
        `Gamepad driver: ${driver.ok ? 'ok' : 'MISSING'} (${driver.platform})`,
        `Settings: mode=${settings.mode}, maxPlayers=${settings.maxPlayers}, turn=${settings.turnSeconds}s, locked=${settings.locked}, frozen=${settings.frozen}, spectate=${settings.spectate}, wifi=${settings.lan}, joinCode=${settings.code ? 'set' : 'none'}`,
        `Players: ${s.players || 0} joined, ${s.connected || 0} connected, ${(s.queue || []).length} waiting, gamepad ${s.padOk === false ? 'NOT RUNNING' : 'ok'}`,
        '',
        'Last log lines:',
        ...logLines.slice(-80)
    ].join('\n');
}

/* ---------- Driver check (Windows needs ViGEmBus; Linux needs uinput) ---------- */
const VIGEM_URL = 'https://github.com/nefarius/ViGEmBus/releases';
let driver = { platform: process.platform, ok: true, url: '', hint: '' };

function checkDriver() {
    return new Promise((resolve) => {
        const done = (next) => {
            const changed = JSON.stringify(next) !== JSON.stringify(driver);
            driver = next;
            if (changed) push();
            resolve();
        };
        if (process.platform === 'win32') {
            // The ViGEmBus driver installs a Windows service with this name
            execFile('sc.exe', ['query', 'ViGEmBus'], (err) =>
                done({ platform: 'win32', ok: !err, url: VIGEM_URL, hint: '' }));
        } else if (process.platform === 'linux') {
            const paths = ['/dev/uinput', '/dev/input/uinput'];
            const ok = paths.some(p => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch (e) { return false; } });
            done({ platform: 'linux', ok, url: '',
                hint: 'The virtual gamepad needs permission. Start with: sudo node admin.js  (if /dev/uinput is missing: sudo modprobe uinput)' });
        } else {
            done({ platform: process.platform, ok: true, url: '', hint: '' });
        }
    });
}

/* ---------- Panel (browser on this computer) ---------- */
const app = express();
app.use(express.static(path.join(__dirname, 'admin')));
const server = http.createServer(app);
const ORIGINS = new Set([`http://127.0.0.1:${ADMIN_PORT}`, `http://localhost:${ADMIN_PORT}`]);
// Only the panel page itself may control this (blocks other websites)
const wss = new WebSocket.Server({ server, verifyClient: ({ origin }) => ORIGINS.has(origin) });
wss.on('error', () => {});   // the clear "port already in use" message below handles this (without it Node prints a long crash instead)

function broadcast(obj) {
    const data = JSON.stringify(obj);
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); });
}
function push() {
    const lanUrl = settings.lan && status === 'online' && lanAddress() ? `http://${lanAddress()}:${VIEWER_PORT}` : '';
    broadcast({ type: 'panel', status, message, link, settings, state: serverState, driver, license: lic, lanUrl });
}
function setStatus(s, m) { status = s; message = m; push(); }

wss.on('connection', (ws) => {
    push();
    ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw); } catch (e) { return; }
        if (!m || typeof m !== 'object') return;
        if (m.cmd === 'connect') connect();
        else if (m.cmd === 'recheck') checkDriver();
        else if (m.cmd === 'diag') ws.send(JSON.stringify({ type: 'diag', text: diagnostics() }));
        else if (m.cmd === 'license') {
            lic = license.activate(String(m.token || ''));
            log('License:', lic.valid ? 'valid (' + (lic.name || lic.plan) + ')' : lic.reason);
            if (lic.valid) clearTimeout(trialTimer);
            push();
        }
        else if (m.cmd === 'disconnect') disconnect('Disconnected. The controller is closed.');
        else if (m.cmd === 'settings' && m.settings) {
            settings = {
                locked: !!m.settings.locked,
                code: String(m.settings.code || '').trim().slice(0, 20),
                turnSeconds: Number(m.settings.turnSeconds) || 0,
                frozen: !!m.settings.frozen,
                maxPlayers: Number(m.settings.maxPlayers) || 0,
                mode: m.settings.mode === 'svv' ? 'svv' : 'vvw',
                spectate: m.settings.spectate !== false,
                lan: !!m.settings.lan
            };
            if (serverProc) serverProc.send({ type: 'settings', settings });
            push();
        } else if (['skip', 'kick', 'unban'].includes(m.cmd) && serverProc) {
            serverProc.send({ type: 'admin', cmd: m.cmd, id: m.id, ban: !!m.ban, ip: m.ip });
        }
    });
});

/* ---------- Start / stop ---------- */
function startServer() {
    return new Promise((resolve, reject) => {
        const proc = fork(path.join(__dirname, 'server.js'), [], {
            cwd: __dirname, silent: true,
            env: { ...process.env, LAN: settings.lan ? '1' : '' }
        });
        serverProc = proc;
        const keep = (stream, out) => stream.on('data', (d) => {
            out.write(d);
            String(d).split(/\r?\n/).filter(Boolean).forEach((l) => log('[server]', l));
        });
        keep(proc.stdout, process.stdout);
        keep(proc.stderr, process.stderr);
        let ready = false;
        const timer = setTimeout(() => reject(new Error('server.js did not start in time.')), 10000);
        proc.on('message', (msg) => {
            if (!msg) return;
            if (msg.type === 'ready') {
                ready = true; clearTimeout(timer);
                proc.send({ type: 'settings', settings });
                resolve();
            } else if (msg.type === 'state') { serverState = msg; push(); }
            else if (msg.type === 'input') { broadcast(msg); }   // button presses for the OBS overlay
        });
        proc.on('exit', (code) => {
            clearTimeout(timer);
            if (serverProc === proc) serverProc = null;
            if (!ready) reject(new Error(`server.js stopped (code ${code}). Is port ${VIEWER_PORT} already in use?`));
            else if (status === 'online') disconnect('The server stopped unexpectedly.');
        });
    });
}

function startTunnel() {
    return new Promise((resolve, reject) => {
        const proc = spawn(CLOUDFLARED, ['tunnel', '--url', `http://127.0.0.1:${VIEWER_PORT}`, '--no-autoupdate'],
            { stdio: ['ignore', 'pipe', 'pipe'] });
        tunnelProc = proc;
        let found = false;
        const timer = setTimeout(() => reject(new Error('The tunnel took too long. Check your internet.')), 40000);
        const onData = (buf) => {
            if (found) return;
            const urls = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi) || [];
            const url = urls.find(u => !u.includes('//api.'));
            if (url) { found = true; clearTimeout(timer); resolve(url); }
        };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);
        proc.on('error', (err) => {
            clearTimeout(timer);
            reject(err.code === 'ENOENT' ? new Error('cloudflared is not installed (or not in PATH).') : err);
        });
        proc.on('exit', (code) => {
            clearTimeout(timer);
            if (tunnelProc === proc) tunnelProc = null;
            if (!found) reject(new Error(`cloudflared stopped (code ${code}).`));
            else if (status === 'online') disconnect('The tunnel stopped unexpectedly.');
        });
    });
}

// Ask the public link a real question (open a connection like a phone does) before giving it out.
// A new Cloudflare link can take several seconds before it works, and copying it too early shows "Connection lost".
function probeLink(url) {
    return new Promise((resolve) => {
        let done = false, sock = null;
        const finish = (ok) => {
            if (done) return;
            done = true;
            try { if (sock) sock.terminate(); } catch (e) {}
            resolve(ok);
        };
        try {
            sock = new WebSocket(url.replace(/^http/, 'ws'));
            sock.on('open', () => finish(true));
            sock.on('error', () => finish(false));
            sock.on('close', () => finish(false));
        } catch (e) { finish(false); }
        setTimeout(() => finish(false), 5000);
    });
}

function killProc(proc) {
    return new Promise((resolve) => {
        if (!proc || proc.exitCode !== null || proc.signalCode) return resolve();
        const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} resolve(); }, 3000);
        proc.once('exit', () => { clearTimeout(t); resolve(); });
        try { proc.kill('SIGTERM'); } catch (e) { clearTimeout(t); resolve(); }
    });
}

async function teardown() {
    link = '';
    clearTimeout(trialTimer);
    await killProc(tunnelProc);   // the public link dies first
    await killProc(serverProc);   // then the server (this also closes pad.py)
    tunnelProc = serverProc = null;
    serverState = null;
}

async function connect() {
    if (status !== 'offline') return;
    await checkDriver();
    if (driver.platform === 'win32' && !driver.ok) {
        setStatus('offline', 'Install the ViGEmBus driver first.');
        return;
    }
    log('Connect pressed');
    setStatus('starting', 'Starting server...');
    try {
        await startServer();
        setStatus('starting', 'Opening Cloudflare tunnel...');
        link = await startTunnel();
        if (!serverProc) throw new Error('server.js stopped unexpectedly.');
        setStatus('starting', 'Checking that the link works...');
        let reachable = false;
        for (let i = 0; i < 20 && !reachable && serverProc; i++) {   // up to about 50 seconds
            reachable = await probeLink(link);
            if (!reachable) await new Promise((r) => setTimeout(r, 2000));
        }
        log('Tunnel ready:', link, reachable ? '(answers)' : '(not answering yet)');
        if (!lic.valid) {   // no license: this session ends by itself after 30 minutes
            trialTimer = setTimeout(() => disconnect('Trial session ended (30 minutes). Add a license key to remove the limit.'), TRIAL_MS);
        }
        setStatus('online', (reachable
            ? 'Online. Copy the link and paste it in your stream.'
            : 'Online, but the link does not answer yet. Wait 10 seconds and try it again. If it still says connection lost, press Disconnect, then Connect.')
            + (lic.valid ? '' : ' (Trial: this session ends in 30 minutes.)'));
    } catch (err) {
        log('Connect failed:', err.message);
        await teardown();
        setStatus('offline', err.message);
    }
}

async function disconnect(note) {
    if (status !== 'online') return;
    log('Disconnect:', note);
    setStatus('stopping', 'Disconnecting...');
    await teardown();
    setStatus('offline', note);
}

/* ---------- Run / quit ---------- */
server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${ADMIN_PORT} is already in use.` : err.message);
    process.exit(1);
});
server.listen(ADMIN_PORT, '127.0.0.1', () => console.log(`Admin panel: http://127.0.0.1:${ADMIN_PORT}`));

checkDriver();
// While the driver is missing, keep checking so the setup box disappears right after installing
setInterval(() => { if (!driver.ok && status === 'offline') checkDriver(); }, 3000);

async function quit() { await teardown(); process.exit(0); }
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
process.on('exit', () => {   // last-resort cleanup
    try { if (tunnelProc) tunnelProc.kill(); } catch (e) {}
    try { if (serverProc) serverProc.kill(); } catch (e) {}
});