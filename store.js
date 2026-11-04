'use strict';
// طبقة التخزين الدائم عبر MongoDB (Atlas)
// المجموعات: users | bots | subs | refs | settings | cstate | uvars | wallets
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
    { forceSub: [], feedback: false, welcomeOnce: false, protect: false, admins: [] },
    b.settings
  );
  b.rkb = Array.isArray(b.rkb) ? b.rkb : []; // أزرار الكيبورد السفلي: { id, text, page, newRow }
  b.vars = b.vars && typeof b.vars === 'object' && !Array.isArray(b.vars) ? b.vars : {}; // متغيرات مخصصة: { name: { id, scope, type, value } }
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
// الترقيات تُخزَّن خارج data حتى لا يمحوها saveBot عند الحفظ من نسخة قديمة
function hydrate(d) {
  if (!d || !d.data) return null;
  const b = normalizeBot(d.data);
  b.perks = d.perks || {};
  return b;
}
async function getBot(id) {
  const d = await (await col('bots')).findOne({ _id: String(id) });
  return hydrate(d);
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
  await (await col('cstate')).deleteMany({ _id: { $regex: '^' + String(bot.id) + ':' } });
  await (await col('uvars')).deleteMany({ bot: String(bot.id) });
}
async function botsOf(uid) {
  const docs = await (await col('bots')).find({ owner: String(uid) }).toArray();
  return docs.map(hydrate).filter(Boolean);
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
/*  حالة المشرف داخل البوت الابن (وضع الكيبورد + الخطوة الجارية)         */
/* ------------------------------------------------------------------ */
async function getCState(botId, uid) {
  const d = await (await col('cstate')).findOne({ _id: `${botId}:${uid}` });
  return d && d.data ? d.data : { mode: 'main', step: null };
}
async function saveCState(botId, uid, s) {
  await (await col('cstate')).updateOne({ _id: `${botId}:${uid}` }, { $set: { data: s } }, { upsert: true });
}

/* ------------------------------------------------------------------ */
/*  قيم المتغيرات الخاصة بكل مستخدم (مفتاحها معرّف المتغير vid)            */
/* ------------------------------------------------------------------ */
async function getUVars(botId, uid) {
  const d = await (await col('uvars')).findOne({ _id: `${botId}:${uid}` });
  return (d && d.vars) || {};
}
async function setUVar(botId, uid, vid, value) {
  await (await col('uvars')).updateOne(
    { _id: `${botId}:${uid}` },
    { $set: { bot: String(botId), [`vars.${vid}`]: value } },
    { upsert: true }
  );
}

// تغيير قيمة متغير عام مباشرة (دون إعادة كتابة وثيقة البوت كلها)
async function setGlobalVar(botId, name, value) {
  await (await col('bots')).updateOne({ _id: String(botId) }, { $set: { [`data.vars.${name}.value`]: value } });
}


/* ------------------------------------------------------------------ */
/*  المحفظة (💎): كل العمليات ذرّية حتى لا يضيع رصيد مع الضغط المتكرر      */
/* ------------------------------------------------------------------ */
const DAY_MS = 24 * 3600 * 1000;
async function ensureWallet(uid) {
  await (await col('wallets')).updateOne(
    { _id: String(uid) },
    { $setOnInsert: { gems: 0, slots: 0, spent: 0, streak: 0, daily: 0, charges: [] } },
    { upsert: true }
  );
}
async function getWallet(uid) {
  const d = await (await col('wallets')).findOne({ _id: String(uid) });
  return d || { gems: 0, slots: 0, spent: 0, streak: 0, daily: 0 };
}
// يضيف جواهر؛ chargeId يمنع احتساب نفس الدفعة مرتين. يعيد true إن أُضيفت
async function addGems(uid, n, chargeId) {
  await ensureWallet(uid);
  const f = { _id: String(uid) };
  const up = { $inc: { gems: n } };
  if (chargeId) {
    f.charges = { $ne: String(chargeId) };
    up.$push = { charges: { $each: [String(chargeId)], $slice: -50 } };
  }
  const r = await (await col('wallets')).updateOne(f, up);
  return r.modifiedCount > 0;
}
// يخصم إن كان الرصيد كافيًا (شرط وخصم في عملية واحدة). extra مثل { slots: 1 }
async function spendGems(uid, cost, extra) {
  const r = await (await col('wallets')).updateOne(
    { _id: String(uid), gems: { $gte: cost } },
    { $inc: Object.assign({ gems: -cost, spent: cost }, extra || {}) }
  );
  return r.modifiedCount > 0;
}
// مكافأة يومية متصاعدة: 5 💎 + 2 لكل يوم متتالٍ (حتى 17)
async function claimDaily(uid) {
  await ensureWallet(uid);
  const now = Date.now();
  const w = await getWallet(uid);
  const streak = w.daily && now - w.daily < 2 * DAY_MS ? (w.streak || 0) + 1 : 1;
  const gems = 5 + 2 * Math.min(streak - 1, 6);
  const r = await (await col('wallets')).updateOne(
    { _id: String(uid), daily: { $lte: now - DAY_MS } },
    { $set: { daily: now, streak }, $inc: { gems } }
  );
  if (!r.modifiedCount) return { ok: false, wait: Math.max(0, DAY_MS - (now - (w.daily || 0))) };
  return { ok: true, gems, streak };
}
// ترقية بوت: تُفعَّل ذرّيًا مرة واحدة، ويمكن التراجع إن فشل الخصم
async function claimPerk(botId, perk) {
  const r = await (await col('bots')).updateOne(
    { _id: String(botId), [`perks.${perk}`]: { $ne: true } },
    { $set: { [`perks.${perk}`]: true } }
  );
  return r.modifiedCount > 0;
}
async function releasePerk(botId, perk) {
  await (await col('bots')).updateOne({ _id: String(botId) }, { $unset: { [`perks.${perk}`]: '' } });
}
// يحجز تنفيذ إجراء محدود (مرة واحدة / كل مدة) ذرّيًا؛ window=Infinity لمرة واحدة
async function claimAction(botId, uid, key, window, now) {
  const c = await col('uvars');
  const id = `${botId}:${uid}`;
  await c.updateOne({ _id: id }, { $setOnInsert: { bot: String(botId) } }, { upsert: true });
  const path = `vars.${key}`;
  const cond =
    window === Infinity
      ? { [path]: { $exists: false } }
      : { $or: [{ [path]: { $exists: false } }, { [path]: { $lt: now - window } }] };
  const r = await c.updateOne(Object.assign({ _id: id }, cond), { $set: { [path]: now } });
  return r.modifiedCount > 0;
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
  getCState,
  getUVars,
  setGlobalVar,
  setUVar,
  saveCState,
  addRef,
  refCount,
  getSettings,
  setSetting,
  counts,
  getWallet,
  addGems,
  spendGems,
  claimDaily,
  claimPerk,
  releasePerk,
  claimAction,
};
