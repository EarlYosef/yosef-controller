// Run once:  node tools/make-keys.js
// Makes your private key (secret, only you) and the public key (goes inside the program).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const priv = path.join(__dirname, 'private.pem');
const pub = path.join(__dirname, '..', 'public.pem');
if (fs.existsSync(priv)) {
    console.log('tools/private.pem already exists. Not replacing it (that would make every old license stop working).');
    process.exit(1);
}
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
console.log('Done.');
console.log('  tools/private.pem  -> SECRET. Back it up. NEVER give it to customers or put it in the download.');
console.log('  public.pem         -> ships with the program (it can only check licenses, not make them).');
console.log('Next: node tools/make-license.js "Customer Name" customer@email.com 365');