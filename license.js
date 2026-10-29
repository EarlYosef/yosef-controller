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
        if (!crypto.verify(null, Buffer.from(parts[0]), key, b64(parts[1]))) return { ok: false, reason: 'The license key is not valid.' };
        data = JSON.parse(b64(parts[0]).toString('utf8'));
    } catch (e) { return { ok: false, reason: 'The license key is not valid.' }; }
    if (data.expires && Date.now() > Date.parse(data.expires)) {
        return { ok: false, reason: 'This license expired on ' + String(data.expires).slice(0, 10) + '.', data };
    }
    return { ok: true, data };
}

// { valid, plan, name, expires, reason, dev }
function check() {
    const key = publicKey();
    if (!key) return { valid: true, dev: true, plan: 'developer', name: 'Developer copy (no license key is set up yet)' };
    let token = '';
    try { token = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8')).token; } catch (e) {}
    if (!token) return { valid: false, plan: 'trial', reason: 'No license yet. Trial: each session lasts 30 minutes.' };
    const r = verifyToken(token, key);
    if (!r.ok) return { valid: false, plan: 'trial', reason: r.reason };
    return { valid: true, plan: r.data.plan || 'standard', name: r.data.name || '', expires: r.data.expires || '' };
}

function activate(token) {
    const key = publicKey();
    if (!key) return { valid: true, dev: true, plan: 'developer', name: 'Developer copy (no license key is set up yet)' };
    const r = verifyToken(token, key);
    if (!r.ok) return { valid: false, plan: 'trial', reason: r.reason };
    try { fs.writeFileSync(LICENSE_FILE, JSON.stringify({ token: String(token).trim() })); } catch (e) {}
    return check();
}

module.exports = { check, activate, verifyToken };