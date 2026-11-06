// Where the licenses are saved.
//  - On your own computer: a file (licenses.json).
//  - On Render: Render's disk is erased on every restart, so use a free Upstash Redis database instead.
//    Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN and the licenses are kept for good.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'licenses.json');
const URL_ = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'yosef:licenses';
const permanent = !!(URL_ && TOKEN);

async function redis(cmd) {
    const r = await fetch(URL_, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(cmd)
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.result;
}

async function load() {
    if (permanent) {
        const v = await redis(['GET', KEY]);
        return v ? JSON.parse(v) : [];
    }
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return []; }
}

async function save(list) {
    const text = JSON.stringify(list);
    if (permanent) await redis(['SET', KEY, text]);
    else fs.writeFileSync(FILE, text);
}

// One change at a time, so two requests can never overwrite each other
let chain = Promise.resolve();
function locked(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
}

module.exports = { load, save, locked, permanent };