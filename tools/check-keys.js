// tools/check-keys.js
// Checks that the private key used by the dashboard matches public.pem.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const fromEnv = !!process.env.LICENSE_PRIVATE_KEY_B64;

// Same logic as creator/server.js: env variable first, then tools/private.pem
const privatePem = fromEnv
    ? Buffer.from(process.env.LICENSE_PRIVATE_KEY_B64, 'base64').toString('utf8')
    : fs.readFileSync(path.join(__dirname, 'private.pem'), 'utf8');

// The public key that SHOULD go with that private key
const derived = crypto
    .createPublicKey(crypto.createPrivateKey(privatePem))
    .export({ type: 'spki', format: 'pem' });

// The public key your app actually uses
const current = fs.readFileSync(path.join(__dirname, '..', 'public.pem'), 'utf8');

const clean = (s) => s.replace(/\r/g, '').trim();

console.log('Private key comes from:', fromEnv ? 'LICENSE_PRIVATE_KEY_B64 (env variable)' : 'tools/private.pem');
if (clean(derived) === clean(current)) {
    console.log('MATCH: public.pem is correct. The problem is somewhere else.');
} else {
    console.log('MISMATCH: put this into public.pem:\n');
    console.log(derived);
}