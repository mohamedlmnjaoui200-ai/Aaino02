'use strict';
const fs = require('fs');
const path = require('path');

// على Azure App Service (Linux) المجلد /home يبقى محفوظًا بين إعادة التشغيل
const DIR =
  process.env.DATA_DIR ||
  (process.env.WEBSITE_SITE_NAME ? '/home/data' : path.join(__dirname, '..', 'data'));
const FILE = path.join(DIR, 'db.json');

fs.mkdirSync(DIR, { recursive: true });

let db = { users: {}, bots: {} };
try {
  db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  db.users = db.users || {};
  db.bots = db.bots || {};
} catch (_) {
  /* قاعدة جديدة */
}

let timer = null;
function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE); // كتابة ذرّية
  }, 200);
}

function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}

function user(uid) {
  const k = String(uid);
  if (!db.users[k]) db.users[k] = { state: null, createdAt: Date.now() };
  return db.users[k];
}

module.exports = { db, save, flush, user, DIR };
