// License check (works offline).
//
// How it works: you keep a PRIVATE key. Each license is a short text ("token") that you sign with it
// (tools/make-license.js). This program only holds the PUBLIC key, which can check a signature but
// can not create one. So customers can not make their own licenses.
//
// Before you sell: run  node tools/make-keys.js  and keep tools/private.pem secret (never ship it).
// Put the public key below (or leave public.pem next to this file).
//
// Honest limit: JavaScript on the customer's PC can always be edited by a determined person.
// This stops casual sharing. Stronger protection comes from running the link through your own server.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_KEY_PEM = '';   // paste the contents of public.pem here when you release
const LICENSE_FILE = path.join(__dirname, 'license.json');
// The address of YOUR creator dashboard on Render, for example 'https://yosef-creator.onrender.com'.
// With it, a license you Disable or Delete stops working within about 10 minutes, and you can see who is online.
// Leave it empty and licenses work fully offline.
const CREATOR_URL = process.env.CREATOR_URL || 'https://yosef-controller.onrender.com';
const MUST_CHECK_IN_MS = 14 * 86400000;   // with a dashboard set, the program must reach it at least every 14 days

function publicKey() {
    if (PUBLIC_KEY_PEM.trim()) return PUBLIC_KEY_PEM;
    try { return fs.readFileSync(path.join(__dirname, 'public.pem'), 'utf8'); } catch (e) { return ''; }
}

const b64 = (s) => Buffer.from(s, 'base64url');

// token = base64url(JSON data) + "." + base64url(signature)
function verifyToken(token, key) {
    const parts = String(token || '').trim().split('.');
    if (parts.length !== 2) return { ok: false, reason: 'That is not a license key.' };
    let data;
    try {
        // The text in brackets helps while testing. Remove it before you release, if you do not want customers to see it.
        if (!crypto.verify(null, Buffer.from(parts[0]), key, b64(parts[1]))) {
            return { ok: false, reason: 'The license key is not valid. (signature does not match public.pem)' };
        }
        data = JSON.parse(b64(parts[0]).toString('utf8'));
    } catch (e) {
        return { ok: false, reason: 'The license key is not valid. (' + e.message + ')' };
    }
    if (data.expires && Date.now() > Date.parse(data.expires)) {
        return { ok: false, reason: 'This license expired on ' + String(data.expires).slice(0, 10) + '.', data };
    }
    return { ok: true, data };
}

// { valid, plan, name, expires, reason, dev }
function check() {
    const key = publicKey();
    if (!key) return { valid: true, dev: true, plan: 'developer', name: 'Developer copy (no license key is set up yet)' };
    const saved = readSaved();
    const token = saved.token || '';
    if (!token) return { valid: false, plan: 'free', reason: 'No license yet. Screen sharing and extra players are locked.' };
    const r = verifyToken(token, key);
    if (!r.ok) return { valid: false, plan: 'free', reason: r.reason };
    if (CREATOR_URL && saved.lastOk && Date.now() - saved.lastOk > MUST_CHECK_IN_MS) {
        return { valid: false, plan: 'free', reason: 'Connect to the internet once so the license can be confirmed.' };
    }
    return { valid: true, plan: r.data.plan || 'standard', name: r.data.name || '', expires: r.data.expires || '', id: r.data.id || '' };
}

function readSaved() {
    try { return JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8')) || {}; } catch (e) { return {}; }
}

// ask the dashboard: 'ok', 'revoked' (switched off or deleted), 'expired', 'invalid', or 'offline' (could not reach it)
async function online() {
    const saved = readSaved();
    if (!CREATOR_URL || !saved.token) return 'ok';
    try {
        const r = await fetch(CREATOR_URL + '/api/check', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: saved.token }),
            signal: AbortSignal.timeout(65000)   // a sleeping Render server needs about a minute to wake up
        });
        const st = (await r.json()).status || 'offline';
        if (st === 'ok') { try { fs.writeFileSync(LICENSE_FILE, JSON.stringify({ ...saved, lastOk: Date.now() })); } catch (e) {} }
        return st;
    } catch (e) { return 'offline'; }
}

// tell the dashboard this copy is running (how many players, how many viewers)
async function ping(info) {
    const saved = readSaved();
    if (!CREATOR_URL || !saved.token) return;
    try {
        await fetch(CREATOR_URL + '/api/ping', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: saved.token, info }),
            signal: AbortSignal.timeout(20000)
        });
    } catch (e) { /* the dashboard is asleep or unreachable: ignore */ }
}

function activate(token) {
    const key = publicKey();
    if (!key) return { valid: true, dev: true, plan: 'developer', name: 'Developer copy (no license key is set up yet)' };
    const r = verifyToken(token, key);
    if (!r.ok) return { valid: false, plan: 'free', reason: r.reason };
    try { fs.writeFileSync(LICENSE_FILE, JSON.stringify({ token: String(token).trim(), lastOk: Date.now() })); } catch (e) {}
    return check();
}

module.exports = { check, activate, verifyToken, online, ping };