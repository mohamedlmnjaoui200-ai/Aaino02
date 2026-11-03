'use strict';
// طبقة التخزين الدائم عبر MongoDB (Atlas)
// المجموعات: users | bots | subs | refs | settings
const { MongoClient } = require('mongodb');

let clientPromise = global._mongoClientPromise;

function db() {
  if (!clientPromise) {
    const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 5 });
    clientPromise = global._mongoClientPromise = client.connect();
  }
  return clientPromise.then((c) => {
    const d = c.db(process.env.MONGODB_DB || 'botmaker');
    ensureIndexes(d);
    return d;
  });
}
const col = async (name) => (await db()).collection(name);

// فهارس تُنشأ مرة واحدة لكل نسخة تشغيل
function ensureIndexes(d) {
  if (global._botmakerIdx) return;
  global._botmakerIdx = true;
  Promise.all([
    d.collection('bots').createIndex({ owner: 1 }),
    d.collection('subs').createIndex({ bot: 1, blocked: 1 }),
    d.collection('subs').createIndex({ bot: 1, joined: 1 }),
    d.collection('refs').createIndex({ by: 1 }),
  ]).catch(() => {
    global._botmakerIdx = false;
  });
}

/* ------------------------------------------------------------------ */
/*  نموذج البيانات                                                      */
/* ------------------------------------------------------------------ */
const rid = (p = 'x') => p + Math.random().toString(36).slice(2, 8);

function newPage(id, title) {
  return { id, title: title || 'صفحة', message: null, buttons: [] };
}

// ترقية البوتات القديمة (message + buttons) إلى النموذج الجديد (pages + commands)
function normalizeBot(b) {
  if (!b) return b;
  if (!b.pages) {
    const main = newPage('main', 'الرئيسية');
    main.message = b.message || null;
    main.buttons = (b.buttons || []).map((x) => ({
      id: rid('b'),
      text: x.text,
      type: 'url',
      url: x.url,
      style: x.style || 'default',
      newRow: true,
    }));
    b.pages = { main };
    delete b.message;
    delete b.buttons;
  }
  if (!b.pages.main) b.pages.main = newPage('main', 'الرئيسية');
  b.commands = Object.assign({ start: 'main', ms: 'main' }, b.commands);
  b.settings = Object.assign(
    { forceSub: [], feedback: false, welcomeOnce: false, protect: false },
    b.settings
  );
  b.v = 2;
  return b;
}

/* ------------------------------------------------------------------ */
/*  المستخدمون (حالة الحوار مع بوت الصانع)                              */
/* ------------------------------------------------------------------ */
async function getUser(uid) {
  const d = await (await col('users')).findOne({ _id: String(uid) });
  return d ? d.data : { state: null, createdAt: Date.now() };
}
async function saveUser(uid, u) {
  await (await col('users')).updateOne({ _id: String(uid) }, { $set: { data: u } }, { upsert: true });
}
// صفحات للمستخدمين (للبث الإداري): يعيد المعرّفات بعد المؤشر
async function usersPage(after, limit) {
  const q = after ? { _id: { $gt: String(after) } } : {};
  const docs = await (await col('users'))
    .find(q, { projection: { _id: 1, 'data.banned': 1 } })
    .sort({ _id: 1 })
    .limit(limit)
    .toArray();
  return docs.map((d) => ({ id: d._id, banned: !!(d.data && d.data.banned) }));
}

/* ------------------------------------------------------------------ */
/*  البوتات                                                            */
/* ------------------------------------------------------------------ */
async function getBot(id) {
  const d = await (await col('bots')).findOne({ _id: String(id) });
  return d ? normalizeBot(d.data) : null;
}
async function saveBot(bot) {
  await (await col('bots')).updateOne(
    { _id: String(bot.id) },
    { $set: { data: bot, owner: String(bot.owner) } },
    { upsert: true }
  );
}
async function delBot(bot) {
  await (await col('bots')).deleteOne({ _id: String(bot.id) });
  await (await col('subs')).deleteMany({ bot: String(bot.id) });
}
async function botsOf(uid) {
  const docs = await (await col('bots')).find({ owner: String(uid) }).toArray();
  return docs.map((d) => normalizeBot(d.data)).filter(Boolean);
}
async function allBotIds() {
  const docs = await (await col('bots')).find({}, { projection: { _id: 1 } }).toArray();
  return docs.map((d) => d._id);
}

/* ------------------------------------------------------------------ */
/*  مشتركو البوتات (لكل بوت قائمة مشتركيه)                              */
/* ------------------------------------------------------------------ */
// يسجّل/يحدّث المشترك. يعيد true إن كان جديدًا
async function touchSub(botId, u) {
  const r = await (await col('subs')).updateOne(
    { _id: `${botId}:${u.id}` },
    {
      $set: {
        bot: String(botId),
        uid: String(u.id),
        name: [u.first_name, u.last_name].filter(Boolean).join(' ').slice(0, 64),
        username: u.username || null,
        last: Date.now(),
        blocked: false,
      },
      $setOnInsert: { joined: Date.now() },
    },
    { upsert: true }
  );
  return r.upsertedCount > 0;
}
async function setSubBlocked(botId, uid, blocked) {
  await (await col('subs')).updateOne(
    { _id: `${botId}:${uid}` },
    { $set: { blocked: !!blocked } }
  );
}
async function getSub(botId, uid) {
  return (await col('subs')).findOne({ _id: `${botId}:${uid}` });
}
async function subsPage(botId, after, limit) {
  const q = { bot: String(botId), blocked: { $ne: true } };
  if (after) q._id = { $gt: after };
  const docs = await (await col('subs')).find(q).sort({ _id: 1 }).limit(limit).toArray();
  return docs.map((d) => ({ cursor: d._id, uid: d.uid }));
}
async function subStats(botId) {
  const c = await col('subs');
  const b = String(botId);
  const day = Date.now() - 24 * 3600 * 1000;
  const week = Date.now() - 7 * 24 * 3600 * 1000;
  const [total, blocked, today, thisWeek] = await Promise.all([
    c.countDocuments({ bot: b }),
    c.countDocuments({ bot: b, blocked: true }),
    c.countDocuments({ bot: b, joined: { $gte: day } }),
    c.countDocuments({ bot: b, joined: { $gte: week } }),
  ]);
  return { total, blocked, active: total - blocked, today, week: thisWeek };
}

/* عدّادات الاستخدام (أيام/مشاهدات/ضغطات) */
async function incStat(botId, key, n = 1) {
  await (await col('bots')).updateOne({ _id: String(botId) }, { $inc: { [`stats.${key}`]: n } });
}
async function getStats(botId) {
  const d = await (await col('bots')).findOne({ _id: String(botId) }, { projection: { stats: 1 } });
  return (d && d.stats) || {};
}

/* ------------------------------------------------------------------ */
/*  الإحالات                                                           */
/* ------------------------------------------------------------------ */
// يعيد true إذا سُجّلت الإحالة لأول مرة
async function addRef(inviter, invited) {
  if (String(inviter) === String(invited)) return false;
  const r = await (await col('refs')).updateOne(
    { _id: String(invited) },
    { $setOnInsert: { by: String(inviter), at: Date.now() } },
    { upsert: true }
  );
  return r.upsertedCount > 0;
}
async function refCount(uid) {
  return (await col('refs')).countDocuments({ by: String(uid) });
}

/* ------------------------------------------------------------------ */
/*  إعدادات عامة (يديرها الأدمن)                                        */
/* ------------------------------------------------------------------ */
async function getSettings() {
  const d = await (await col('settings')).findOne({ _id: 'global' });
  return (d && d.data) || {};
}
async function setSetting(key, value) {
  await (await col('settings')).updateOne(
    { _id: 'global' },
    { $set: { [`data.${key}`]: value } },
    { upsert: true }
  );
}

/* ------------------------------------------------------------------ */
async function counts() {
  const [users, bots, subs] = await Promise.all([
    (await col('users')).countDocuments(),
    (await col('bots')).countDocuments(),
    (await col('subs')).countDocuments(),
  ]);
  return { users, bots, subs };
}

module.exports = {
  rid,
  newPage,
  normalizeBot,
  getUser,
  saveUser,
  usersPage,
  getBot,
  saveBot,
  delBot,
  botsOf,
  allBotIds,
  touchSub,
  setSubBlocked,
  getSub,
  subsPage,
  subStats,
  incStat,
  getStats,
  addRef,
  refCount,
  getSettings,
  setSetting,
  counts,
};
