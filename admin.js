'use strict';
// لوحة إدارة داخل البوت الابن نفسه (كيبورد سفلي للمستخدمين + محرر أزرار + محتوى + إحصائيات + بث + إعدادات)
const tg = require('./telegram');
const store = require('./store');
const { sendPage, extractMessage } = require('./render');
const actions = require('./actions');
const W = require('./wallet');
const L = (bot) => W.limitsOf(bot); // الحدود حسب ترقيات البوت

const BC_BUDGET = Number(process.env.BC_BUDGET_MS || 8000);
const SYS_VARS = ['name', 'first_name', 'username', 'id', 'bot'];
const VAR_RE = /^[a-z][a-z0-9_]{1,19}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const isBlocked = (e) => /blocked|deactivated|kicked|chat not found/i.test((e && e.message) || '');
const pageOf = (bot, id) => (id && Object.prototype.hasOwnProperty.call(bot.pages, id) ? bot.pages[id] : null);

// نصوص أزرار الإدارة (محجوزة: لا يمكن استخدامها كأسماء أزرار للمستخدمين)
const T = {
  editor: '🎛 محرر الأزرار',
  content: '📝 تعديل المحتوى',
  admin: '🔐 الإدارة',
  exit: '🔙 خروج من الإدارة',
  stopE: '🛑 إيقاف المحرر',
  stopC: '🛑 إيقاف التعديل',
  add: '➕ إضافة زر',
  stats: '📊 الإحصائيات',
  bc: '📢 بث',
  start: '🏠 رسالة البدء',
  settings: '⚙️ الإعدادات',
  vars: '🗄 المتغيرات',
  channels: '📡 القنوات والمجموعات',
  admins: '👮 المشرفون',
};
const RESERVED = new Set(Object.values(T));

// صلاحيات المشرفين (المالك يملكها كلها دائمًا، وإدارة المشرفين للمالك وحده)
const PERMS = {
  editor: '🎛 محرر الأزرار',
  content: '📝 المحتوى ورسالة البدء',
  vars: '🗄 المتغيرات والإجراءات',
  stats: '📊 الإحصائيات',
  bc: '📢 البث',
  channels: '📡 القنوات والمجموعات',
  settings: '⚙️ الإعدادات',
};
const DEFAULT_PERMS = ['content', 'stats'];
// قد تكون العناصر القديمة معرّفات نصية فقط، فنحوّلها إلى { id, name, perms }
const adminEntries = (bot) =>
  ((bot.settings && bot.settings.admins) || []).map((x) =>
    x && typeof x === 'object' ? x : { id: String(x), name: String(x), perms: DEFAULT_PERMS.slice() }
  );
const isOwner = (bot, uid) => String(uid) === String(bot.owner);
const isAdmin = (bot, uid) => isOwner(bot, uid) || adminEntries(bot).some((a) => String(a.id) === String(uid));
const can = (bot, uid, perm) =>
  isOwner(bot, uid) || adminEntries(bot).some((a) => String(a.id) === String(uid) && (a.perms || []).includes(perm));

// الصلاحية المطلوبة لكل عملية في الأزرار المضمّنة
const OP_PERM = {};
const permOps = (perm, ops) => ops.split(' ').forEach((o) => (OP_PERM[o] = perm));
permOps('editor', 'tn tp br bp bs bu bd bw bx bxy bpn');
permOps('vars', 'ac an as ao al ad vl va vsg vsu vtn vtt vp vv vu uvs uvc vx vxy');
permOps('content', 'sm sp sk skr');
permOps('channels', 'fs fa fd ft ff');
permOps('settings', 'tf');
permOps('bc', 'bcgo bcnext');
permOps('owner', 'ml ma mp mt md mdy');

/* ------------------------------------------------------------------ */
/*  الكيبورد السفلي                                                    */
/* ------------------------------------------------------------------ */
function userRows(bot) {
  const rows = [];
  (bot.rkb || []).forEach((b) => {
    const last = rows[rows.length - 1];
    if (b.newRow === false && last && last.length < 3) last.push(b.text);
    else rows.push([b.text]);
  });
  return rows;
}

function rowsFor(bot, st, uid) {
  const admin = isAdmin(bot, uid);
  const mode = admin ? st.mode || 'main' : 'main';
  const rows = userRows(bot);
  if (mode === 'admin') {
    const btns = [];
    if (can(bot, uid, 'stats')) btns.push(T.stats);
    if (can(bot, uid, 'bc')) btns.push(T.bc);
    if (can(bot, uid, 'content')) btns.push(T.start);
    if (can(bot, uid, 'settings')) btns.push(T.settings);
    if (can(bot, uid, 'vars')) btns.push(T.vars);
    if (can(bot, uid, 'channels')) btns.push(T.channels);
    if (isOwner(bot, uid)) btns.push(T.admins);
    const out = [];
    for (let i = 0; i < btns.length; i += 2) out.push(btns.slice(i, i + 2));
    out.push([T.exit]);
    return out;
  }
  if (mode === 'editor') {
    rows.push([T.add]);
    rows.push([T.stopE]);
  } else if (mode === 'content') {
    rows.push([T.start]);
    rows.push([T.stopC]);
  } else if (admin) {
    const r = [];
    if (can(bot, uid, 'editor')) r.push(T.editor);
    if (can(bot, uid, 'content')) r.push(T.content);
    if (r.length) rows.push(r);
    rows.push([T.admin]);
  }
  return rows.length ? rows : null;
}

function sendKeyboard(bot, token, chatId, text, st) {
  const rows = rowsFor(bot, st, chatId); // في المحادثة الخاصة معرّف المحادثة = معرّف المستخدم
  const p = { chat_id: chatId, text, parse_mode: 'HTML' };
  p.reply_markup = rows
    ? { keyboard: rows.map((r) => r.map((t) => ({ text: t }))), resize_keyboard: true, is_persistent: true }
    : { remove_keyboard: true };
  return tg.call(token, 'sendMessage', p);
}

const MODE_TEXT = {
  main: '⬆️ القائمة الرئيسية',
  admin: '🔐 <b>لوحة الإدارة</b>',
  editor: '🔧 أنت في وضع <b>تحرير الأزرار</b>.\nاضغط «➕ إضافة زر»، أو اضغط على زر موجود لتعديله.',
  content: '📝 أنت في وضع <b>تعديل المحتوى</b>.\nاضغط على الزر الذي تريد تغيير محتواه، أو «🏠 رسالة البدء».',
};

// يُستدعى بعد /start: يعرض الكيبورد المناسب (للمشرف دائمًا، وللمستخدم إن وُجدت أزرار)
async function showMenu(bot, token, chatId, uid) {
  const admin = isAdmin(bot, uid);
  let st = { mode: 'main', step: null };
  if (admin) {
    st = await store.getCState(bot.id, uid);
    st.mode = 'main';
    st.step = null;
    await store.saveCState(bot.id, uid, st);
  } else if (!(bot.rkb || []).length) return;
  await sendKeyboard(bot, token, chatId, (bot.settings && bot.settings.menuText) || MODE_TEXT.main, st, admin);
}

async function setMode(bot, token, chatId, uid, st, mode) {
  st.mode = mode;
  st.step = null;
  st.data = null;
  await store.saveCState(bot.id, uid, st);
  return sendKeyboard(bot, token, chatId, MODE_TEXT[mode], st, true);
}

const refresh = (bot, token, chatId, st, text) => sendKeyboard(bot, token, chatId, text, st, true);

/* ------------------------------------------------------------------ */
/*  أدوات                                                              */
/* ------------------------------------------------------------------ */
const say = (token, chatId, text, kb) => {
  const p = { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  if (kb) p.reply_markup = { inline_keyboard: kb };
  return tg.call(token, 'sendMessage', p);
};

// الوسائط التي يرسلها المشرف إلى البوت الابن file_id الخاص بها صالح لهذا البوت نفسه
function adopt(ex, bot) {
  if (ex.ok && ex.ok.media) {
    ex.ok.media.fids = Object.assign({}, ex.ok.media.fids, { [bot.id]: ex.ok.media.mainId });
    ex.ok.media.origin = 'child';
  }
  return ex;
}

const ib = (text, data) => ({ text, callback_data: data });

function buttonPanel(bot, b) {
  const pg = pageOf(bot, b.page);
  return {
    text:
      `🎛 <b>${esc(b.text)}</b>\n📄 الصفحة: ${pg ? esc(pg.title) : '⚠️ محذوفة'}\n` +
      `↔️ الصف: ${b.newRow === false ? 'مع الزر السابق' : 'صف مستقل'}\n⚡ الإجراءات: ${(b.actions || []).length}`,
    kb: [
      [ib('⚡ الإجراءات', `a:ac:${b.id}`)],
      [ib('✏️ تغيير النص', `a:br:${b.id}`), ib('📄 تغيير الصفحة', `a:bp:${b.id}`)],
      [ib('⬆️', `a:bu:${b.id}`), ib('⬇️', `a:bd:${b.id}`), ib(b.newRow === false ? '↕️ صف مستقل' : '↔️ مع السابق', `a:bw:${b.id}`)],
      [ib('🗑 حذف الزر', `a:bx:${b.id}`)],
      [ib('إغلاق', 'a:cx')],
    ],
  };
}

function actionsPanel(bot, b) {
  const list = b.actions || [];
  const lines = list.length ? list.map((a, i) => `${i + 1}. ${actions.describe(a)}`).join('\n') : 'لا توجد إجراءات.';
  const kb = list.map((a, i) => [ib(`🗑 ${i + 1}. {${a.var}}`, `a:ad:${b.id}:${a.id}`)]);
  if (list.length < actions.MAX_ACTIONS) kb.push([ib('➕ إجراء جديد', `a:an:${b.id}`)]);
  kb.push([ib('🔙 رجوع', `a:bpn:${b.id}`)]);
  return {
    text:
      `⚡ <b>إجراءات الزر «${esc(b.text)}»</b> (${list.length}/${actions.MAX_ACTIONS})\n\n${lines}\n\n` +
      'تُنفَّذ بالترتيب عند ضغط الزر، ثم تظهر الصفحة بالقيم الجديدة. إن فشل شرط (رصيد غير كافٍ أو حد التكرار) لا يُنفَّذ شيء.',
    kb,
  };
}

function pagesKb(bot, prefix, extraFirst) {
  const kb = extraFirst ? [extraFirst] : [];
  Object.values(bot.pages).forEach((p) => kb.push([ib(`${p.id === 'main' ? '🏠' : '📄'} ${p.title}`, `${prefix}${p.id}`)]));
  kb.push([ib('إلغاء', 'a:cx')]);
  return kb;
}

function settingsPanel(bot) {
  const s = bot.settings;
  const on = (v) => (v ? '✅' : '❌');
  return {
    text:
      `⚙️ <b>إعدادات @${esc(bot.username)}</b>\n\n` +
      `📨 وضع التواصل: ${on(s.feedback)}\n🔒 منع الحفظ والتوجيه: ${on(s.protect)}`,
    kb: [
      [ib(`${on(s.feedback)} وضع التواصل`, 'a:tf:feedback')],
      [ib(`${on(s.protect)} منع الحفظ والتوجيه`, 'a:tf:protect')],
      [ib('إغلاق', 'a:cx')],
    ],
  };
}

async function statsText(bot) {
  const [s, c] = await Promise.all([store.subStats(bot.id), store.getStats(bot.id)]);
  return (
    `📊 <b>إحصائيات @${esc(bot.username)}</b>\n\n` +
    `👥 المشتركون: ${s.total} (نشطون ${s.active} • حاظرون ${s.blocked})\n` +
    `🆕 جدد خلال 24 ساعة: ${s.today}\n📅 خلال 7 أيام: ${s.week}\n\n` +
    `👁 مشاهدات الصفحات: ${c.views || 0}\n👆 ضغطات الأزرار: ${c.clicks || 0}\n📩 رسائل التواصل: ${c.feedback || 0}`
  );
}

/* ------------------------------------------------------------------ */
/*  البث لمشتركي البوت                                                 */
/* ------------------------------------------------------------------ */
async function runBroadcast(bot, token, job) {
  const page = { id: 'bc', title: 'بث', message: job.msg, buttons: [] };
  const warm = () => !job.msg.media || (job.msg.media.fids && job.msg.media.fids[bot.id]);
  const t0 = Date.now();
  while (Date.now() - t0 < BC_BUDGET) {
    const rows = await store.subsPage(bot.id, job.cursor, warm() ? 25 : 1);
    if (!rows.length) return true;
    const res = await Promise.allSettled(rows.map((r) => sendPage(token, r.uid, bot, page)));
    res.forEach((x, i) => {
      if (x.status === 'fulfilled') job.sent++;
      else {
        job.failed++;
        if (isBlocked(x.reason)) {
          job.blocked++;
          store.setSubBlocked(bot.id, rows[i].uid, true).catch(() => {});
        }
      }
    });
    job.cursor = rows[rows.length - 1].cursor;
    await sleep(700);
  }
  return false;
}

const bcReport = (j) => `✅ أُرسل: ${j.sent}\n🚫 فشل: ${j.failed} (منهم حاظرون ${j.blocked})`;


/* ------------------------------------------------------------------ */
/*  رسالة البدء                                                        */
/* ------------------------------------------------------------------ */
function startPanel(bot) {
  const m = bot.pages.main && bot.pages.main.message;
  return {
    text:
      '🏠 <b>رسالة البدء</b>\n\nتظهر عند كتابة <code>/start</code>.\n' +
      `📝 الرسالة: ${m ? '✅ محددة' : '❌ غير محددة'}\n` +
      `⌨️ نص رسالة الكيبورد: ${(bot.settings && bot.settings.menuText) || MODE_TEXT.main}`,
    kb: [
      [ib('📝 تعديل الرسالة', 'a:sm'), ib('👁 معاينة', 'a:sp')],
      [ib('⌨️ نص رسالة الكيبورد', 'a:sk'), ib('↩️ الافتراضي', 'a:skr')],
      [ib('إغلاق', 'a:cx')],
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  المتغيرات المخصصة                                                  */
/* ------------------------------------------------------------------ */
const scopeLabel = (d) => (d.scope === 'user' ? '👤 لكل مستخدم' : '🌐 عام');

function varsPanel(bot) {
  const names = Object.keys(bot.vars || {});
  const lines = names.length
    ? names.map((n) => `• <code>{${n}}</code> — ${scopeLabel(bot.vars[n])} (${esc(bot.vars[n].value)})`).join('\n')
    : 'لا توجد متغيرات بعد.';
  const kb = names.map((n) => [ib(`{${n}}`, `a:vp:${n}`)]);
  if (names.length < L(bot).vars) kb.push([ib('➕ متغير جديد', 'a:va')]);
  kb.push([ib('إغلاق', 'a:cx')]);
  return {
    text:
      `🗄 <b>المتغيرات</b> (${names.length}/${L(bot).vars})\n\n${lines}\n\n` +
      'استخدمها داخل أي رسالة بالشكل <code>{الاسم}</code>.\n' +
      'الجاهزة: <code>{name}</code> <code>{first_name}</code> <code>{username}</code> <code>{id}</code> <code>{bot}</code>',
    kb,
  };
}

function varPanel(bot, name) {
  const d = bot.vars[name];
  const kb = [[ib(d.scope === 'user' ? '✏️ القيمة الافتراضية' : '✏️ تعيين القيمة', `a:vv:${name}`)]];
  if (d.scope === 'user') kb.push([ib('👤 قيمة مستخدم محدد', `a:vu:${name}`)]);
  kb.push([ib('🗑 حذف المتغير', `a:vx:${name}`)], [ib('🔙 رجوع', 'a:vl')]);
  return {
    text:
      `🗄 <code>{${name}}</code>\nالنطاق: ${scopeLabel(d)}\nالنوع: ${d.type === 'num' ? '🔢 رقم' : '🔤 نص'}\n` +
      `${d.scope === 'user' ? 'القيمة الافتراضية' : 'القيمة'}: <b>${esc(d.value)}</b>`,
    kb,
  };
}

async function uvPanel(bot, name, uid) {
  const d = bot.vars[name];
  const uv = await store.getUVars(bot.id, uid);
  const v = uv[d.id] !== undefined ? uv[d.id] : d.value;
  const kb = [[ib('✏️ تعيين', `a:uvs:${name}:${uid}`)]];
  if (d.type === 'num') kb.push([ib('➕➖ تغيير (إضافة/طرح)', `a:uvc:${name}:${uid}`)]);
  kb.push([ib('🔙 رجوع', `a:vp:${name}`)]);
  return { text: `👤 المستخدم <code>${esc(uid)}</code>\n<code>{${name}}</code> = <b>${esc(v)}</b>`, kb };
}

function parseValue(type, text) {
  if (type === 'num') {
    const n = Number(String(text || '').replace(/,/g, '').trim());
    if (!text || !Number.isFinite(n) || Math.abs(n) > 1e12) return { error: '⚠️ أرسل رقمًا صحيحًا.' };
    return { value: Math.round(n * 1e6) / 1e6 };
  }
  if (!text || text.length > 200) return { error: '⚠️ أرسل نصًا (حتى 200 حرف).' };
  return { value: text };
}


/* ------------------------------------------------------------------ */
/*  إدارة المشرفين (للمالك فقط)                                         */
/* ------------------------------------------------------------------ */
function adminsPanel(bot) {
  const list = adminEntries(bot);
  const lines = list.length
    ? list.map((a, i) => `${i + 1}. ${esc(a.name || a.id)} (<code>${esc(a.id)}</code>) — ${(a.perms || []).length}/${Object.keys(PERMS).length} صلاحية`).join('\n')
    : 'لا يوجد مشرفون إضافيون.';
  const kb = list.map((a) => [ib(`👮 ${a.name || a.id}`, `a:mp:${a.id}`)]);
  if (list.length < L(bot).admins) kb.push([ib('➕ إضافة مشرف', 'a:ma')]);
  kb.push([ib('إغلاق', 'a:cx')]);
  return {
    text:
      `👮 <b>المشرفون</b> (${list.length}/${L(bot).admins})\n\n${lines}\n\n` +
      'أنت المالك وتملك كل الصلاحيات. المشرف يدير البوت من داخله حسب الصلاحيات التي تحددها له، ولا يستطيع إدارة المشرفين.',
    kb,
  };
}

function adminPermPanel(bot, a) {
  const kb = Object.keys(PERMS).map((p) => [ib(`${(a.perms || []).includes(p) ? '✅' : '❌'} ${PERMS[p]}`, `a:mt:${a.id}:${p}`)]);
  kb.push([ib('🗑 إزالة المشرف', `a:md:${a.id}`)], [ib('🔙 رجوع', 'a:ml')]);
  return { text: `👮 <b>${esc(a.name || a.id)}</b> (<code>${esc(a.id)}</code>)\n\nحدّد صلاحياته:`, kb };
}

/* ------------------------------------------------------------------ */
/*  القنوات والمجموعات (الاشتراك الإجباري)                              */
/* ------------------------------------------------------------------ */
function parseChannel(msg) {
  const fo = msg.forward_origin;
  if (fo && fo.type === 'channel' && fo.chat) return fo.chat.id;
  if (fo && fo.sender_chat) return fo.sender_chat.id;
  if (msg.forward_from_chat) return msg.forward_from_chat.id;
  const t = (msg.text || '').trim();
  const m = t.match(/^(?:https?:\/\/)?t\.me\/([A-Za-z][A-Za-z0-9_]{3,})\/?$/i);
  if (m) return '@' + m[1];
  if (/^@[A-Za-z][A-Za-z0-9_]{3,}$/.test(t)) return t;
  if (/^-100\d{5,}$/.test(t)) return t;
  return null;
}

async function verifyChat(bot, token, chat) {
  const info = await tg.call(token, 'getChat', { chat_id: chat });
  const me = await tg.call(token, 'getChatMember', { chat_id: info.id, user_id: Number(bot.id) });
  if (me.status !== 'administrator' && me.status !== 'creator') throw new Error('not admin');
  const entry = { chat: info.username ? '@' + info.username : info.id, title: info.title || String(chat) };
  if (!info.username) {
    const link = await tg.call(token, 'exportChatInviteLink', { chat_id: info.id }).catch(() => null);
    if (link) entry.link = link;
  }
  return entry;
}

async function channelsPanel(bot, token) {
  const list = bot.settings.forceSub || [];
  const states = await Promise.all(
    list.map((c) =>
      tg
        .call(token, 'getChatMember', { chat_id: c.chat, user_id: Number(bot.id) })
        .then((m) => (m.status === 'administrator' || m.status === 'creator' ? '✅' : '⚠️'))
        .catch(() => '⚠️')
    )
  );
  const lines = list.length ? list.map((c, i) => `${i + 1}. ${states[i]} ${esc(c.title || c.chat)}`).join('\n') : 'لا توجد قنوات أو مجموعات.';
  const kb = [];
  if (list.length < L(bot).force) kb.push([ib('➕ إضافة قناة/مجموعة', 'a:fa')]);
  list.forEach((c, i) => kb.push([ib(`🗑 ${c.title || c.chat}`, `a:fd:${i}`)]));
  kb.push([ib('✏️ نص رسالة الاشتراك', 'a:ft'), ib('↩️ الافتراضي', 'a:ff')]);
  kb.push([ib('إغلاق', 'a:cx')]);
  return {
    text:
      `📡 <b>القنوات والمجموعات</b> (${list.length}/${L(bot).force})\n\n${lines}\n\n` +
      'يجب الاشتراك فيها قبل استخدام البوت. ⚠️ = البوت ليس مشرفًا فيها (يجب أن يكون <b>مشرفًا</b>).\n' +
      'المشرفون لا يخضعون للاشتراك الإجباري.',
    kb,
  };
}

/* ------------------------------------------------------------------ */
/*  أوامر المشرف (/admin و /cancel)                                    */
/* ------------------------------------------------------------------ */
async function command(bot, token, msg, cmd) {
  const uid = String(msg.from.id);
  const st = await store.getCState(bot.id, uid);
  if (cmd === 'admin') return setMode(bot, token, msg.chat.id, uid, st, 'admin');
  st.step = null;
  st.data = null;
  st.bc = null;
  await store.saveCState(bot.id, uid, st);
  return refresh(bot, token, msg.chat.id, st, '✅ تم الإلغاء.');
}

/* ------------------------------------------------------------------ */
/*  الرسائل                                                            */
/* ------------------------------------------------------------------ */
// ضغطة على زر من الكيبورد السفلي من مستخدم عادي
async function userTap(bot, token, msg, h) {
  const b = (bot.rkb || []).find((x) => x.text === msg.text);
  if (!b) return false;
  const page = pageOf(bot, b.page);
  if (!page) return true;
  if (!(await h.gate(token, bot, msg.chat.id, msg.from.id))) return true;
  if (!(await runActions(bot, token, msg, b))) return true;
  await h.deliver(token, bot, msg.chat.id, page, msg.from);
  return true;
}

// ينفّذ إجراءات الزر؛ يعيد false إن رُفض التنفيذ (ويُبلغ المستخدم)
async function runActions(bot, token, msg, b) {
  if (!(b.actions || []).length) return true;
  try {
    const r = await actions.run(bot, msg.from, b);
    if (!r.ok) await say(token, msg.chat.id, r.text);
    return r.ok;
  } catch (e) {
    console.error('actions error:', e && e.message);
    await say(token, msg.chat.id, '⚠️ تعذّر تنفيذ العملية الآن. حاول مرة أخرى.').catch(() => {});
    return false;
  }
}

async function onMessage(bot, token, msg, h) {
  const uid = String(msg.from.id);
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';
  if (!isAdmin(bot, uid)) return msg.text ? userTap(bot, token, msg, h) : false;

  const st = await store.getCState(bot.id, uid);
  const save = () => store.saveCState(bot.id, uid, st);
  const mode = st.mode || 'main';

  // أزرار الخروج تعمل حتى أثناء إدخال خطوة
  if (text === T.exit || text === T.stopE || text === T.stopC) return setMode(bot, token, chatId, uid, st, 'main');

  // الضغط على زر إدارة آخر يلغي الخطوة الجارية
  if (st.step && RESERVED.has(text)) {
    st.step = null;
    st.data = null;
  }
  if (st.step) return stepInput(bot, token, msg, st, save, h);

  const deny = () => say(token, chatId, '⛔ ليست لديك صلاحية لهذا القسم.');
  switch (text) {
    case T.editor:
      if (!can(bot, uid, 'editor')) return deny();
      return setMode(bot, token, chatId, uid, st, 'editor');
    case T.content:
      if (!can(bot, uid, 'content')) return deny();
      return setMode(bot, token, chatId, uid, st, 'content');
    case T.admin:
      return setMode(bot, token, chatId, uid, st, 'admin');
    case T.add:
      if (mode !== 'editor') break;
      if (!can(bot, uid, 'editor')) return deny();
      if ((bot.rkb || []).length >= L(bot).rkb) return say(token, chatId, `⚠️ وصلت للحد الأقصى (${L(bot).rkb} زرًا).`);
      st.step = 'add_text';
      await save();
      return say(token, chatId, '✏️ أرسل <b>نص الزر</b> (حتى 40 حرفًا).\nللإلغاء: /cancel');
    case T.stats:
      if (mode !== 'admin') break;
      if (!can(bot, uid, 'stats')) return deny();
      return say(token, chatId, await statsText(bot));
    case T.bc:
      if (mode !== 'admin') break;
      if (!can(bot, uid, 'bc')) return deny();
      st.step = 'bc_msg';
      await save();
      return say(token, chatId, '📢 أرسل الرسالة التي تريد بثها لمشتركي البوت (نص أو وسائط).\nللإلغاء: /cancel');
    case T.start: {
      if (mode !== 'admin' && mode !== 'content') break;
      if (!can(bot, uid, 'content')) return deny();
      if (mode === 'content') return askContent(bot, token, chatId, st, save, 'main');
      const p = startPanel(bot);
      return say(token, chatId, p.text, p.kb);
    }
    case T.vars: {
      if (mode !== 'admin') break;
      if (!can(bot, uid, 'vars')) return deny();
      const p = varsPanel(bot);
      return say(token, chatId, p.text, p.kb);
    }
    case T.channels: {
      if (mode !== 'admin') break;
      if (!can(bot, uid, 'channels')) return deny();
      const p = await channelsPanel(bot, token);
      return say(token, chatId, p.text, p.kb);
    }
    case T.settings: {
      if (mode !== 'admin') break;
      if (!can(bot, uid, 'settings')) return deny();
      const p = settingsPanel(bot);
      return say(token, chatId, p.text, p.kb);
    }
    case T.admins: {
      if (mode !== 'admin') break;
      if (!isOwner(bot, uid)) return deny();
      const p = adminsPanel(bot);
      return say(token, chatId, p.text, p.kb);
    }
  }

  // ضغطة على زر مستخدم
  const b = (bot.rkb || []).find((x) => x.text === text);
  if (!b) return false;
  if (mode === 'editor') {
    if (!can(bot, uid, 'editor')) return deny();
    const p = buttonPanel(bot, b);
    return say(token, chatId, p.text, p.kb);
  }
  if (mode === 'content') {
    if (!can(bot, uid, 'content')) return deny();
    if (!pageOf(bot, b.page)) return say(token, chatId, '⚠️ الصفحة المرتبطة بهذا الزر محذوفة.');
    return askContent(bot, token, chatId, st, save, b.page);
  }
  const page = pageOf(bot, b.page);
  if (page && (await runActions(bot, token, msg, b))) await h.deliver(token, bot, chatId, page, msg.from);
  return true;
}

async function askContent(bot, token, chatId, st, save, pageId) {
  const page = pageOf(bot, pageId);
  if (!page) return say(token, chatId, '⚠️ الصفحة غير موجودة.');
  st.step = 'content';
  st.data = { pageId };
  await save();
  if (page.message) {
    await say(token, chatId, `👇 المحتوى الحالي لـ «${esc(page.title)}»:`);
    await sendPage(token, chatId, bot, page, {}).catch(() => {});
  }
  return say(
    token,
    chatId,
    `📝 أرسل الآن <b>المحتوى الجديد</b> لصفحة «${esc(page.title)}» (نص أو صورة أو فيديو أو GIF أو ملف أو صوت).\n` +
      'التنسيق والروابط تُحفظ كما هي، ويمكنك استخدام <code>{name}</code>.\nللإلغاء: /cancel'
  );
}

async function stepInput(bot, token, msg, st, save, h) {
  const uid = String(msg.from.id);
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';

  switch (st.step) {
    case 'add_text':
    case 'btn_rename': {
      if (!text || text.length > 40 || text.startsWith('/')) return say(token, chatId, '⚠️ أرسل نص الزر (حتى 40 حرفًا، بدون / في البداية).');
      if (RESERVED.has(text)) return say(token, chatId, '⚠️ هذا الاسم محجوز لأزرار الإدارة. اختر اسمًا آخر.');
      const dup = (bot.rkb || []).find((x) => x.text === text && (st.step === 'add_text' || x.id !== (st.data || {}).bid));
      if (dup) return say(token, chatId, '⚠️ يوجد زر بنفس الاسم.');
      if (st.step === 'btn_rename') {
        const b = (bot.rkb || []).find((x) => x.id === (st.data || {}).bid);
        st.step = null;
        st.data = null;
        await save();
        if (!b) return say(token, chatId, '⚠️ الزر غير موجود.');
        b.text = text;
        await store.saveBot(bot);
        return refresh(bot, token, chatId, st, '✅ تم تغيير النص.');
      }
      st.step = 'add_target';
      st.data = { text };
      await save();
      return say(token, chatId, `ماذا سيفتح الزر «${esc(text)}»؟`, pagesKb(bot, 'a:tp:', [ib('🆕 صفحة جديدة', 'a:tn')]));
    }

    case 'add_target':
      return say(token, chatId, 'اختر من الأزرار أعلاه، أو /cancel للإلغاء.');

    case 'v_name': {
      const name = text.toLowerCase();
      if (!VAR_RE.test(name)) return say(token, chatId, '⚠️ اسم المتغير: حروف إنجليزية صغيرة وأرقام و _ (من 2 إلى 20)، ويبدأ بحرف.');
      if (SYS_VARS.includes(name) || bot.vars[name]) return say(token, chatId, '⚠️ هذا الاسم مستخدم. اختر اسمًا آخر.');
      st.step = 'v_scope';
      st.data = { name };
      await save();
      return say(token, chatId, `نطاق المتغير <code>{${name}}</code>؟`, [
        [ib('🌐 عام للبوت', 'a:vsg'), ib('👤 لكل مستخدم', 'a:vsu')],
        [ib('إلغاء', 'a:cx')],
      ]);
    }


    case 'adm_add': {
      if (!isOwner(bot, uid)) return false;
      const fo = msg.forward_origin;
      let id = null;
      let name = null;
      if (fo && fo.type === 'user' && fo.sender_user) {
        id = String(fo.sender_user.id);
        name = [fo.sender_user.first_name, fo.sender_user.last_name].filter(Boolean).join(' ');
      } else if (msg.forward_from) {
        id = String(msg.forward_from.id);
        name = [msg.forward_from.first_name, msg.forward_from.last_name].filter(Boolean).join(' ');
      } else if (/^\d{1,15}$/.test(text)) id = text;
      else return say(token, chatId, '⚠️ أرسل آيدي المستخدم (أرقام) أو حوّل إليّ رسالة منه.\nللإلغاء: /cancel');
      if (id === String(bot.owner)) return say(token, chatId, '⚠️ أنت المالك بالفعل.');
      const list = adminEntries(bot);
      if (list.some((a) => a.id === id)) return say(token, chatId, '⚠️ هذا المستخدم مشرف بالفعل.');
      if (list.length >= L(bot).admins) return say(token, chatId, '⚠️ وصلت للحد الأقصى للمشرفين.');
      const sub = await store.getSub(bot.id, id);
      if (!sub) return say(token, chatId, '⚠️ يجب أن يكون المستخدم قد فتح البوت (/start) أولًا ليصبح مشتركًا.');
      const entry = { id, name: (name || sub.name || id).slice(0, 40), perms: DEFAULT_PERMS.slice() };
      list.push(entry);
      bot.settings.admins = list;
      await store.saveBot(bot);
      st.step = null;
      await save();
      say(token, id, `👮 تم تعيينك مشرفًا في @${esc(bot.username)}.\nاكتب /start لتظهر لك أزرار الإدارة.`).catch(() => {});
      const p = adminPermPanel(bot, entry);
      return say(token, chatId, `✅ تمت إضافة المشرف بصلاحيات أساسية (المحتوى والإحصائيات).\n\n${p.text}`, p.kb);
    }

    case 'ac_op':
    case 'ac_limit':
      return say(token, chatId, 'اختر من الأزرار أعلاه، أو /cancel للإلغاء.');

    case 'ac_value': {
      const { bid, name, op } = st.data || {};
      const b = (bot.rkb || []).find((x) => x.id === bid);
      const d = bot.vars[name];
      if (!b || !d) return say(token, chatId, '⚠️ انتهت صلاحية هذه الخطوة.');
      const r = parseValue(op === 'add' ? 'num' : d.type, text);
      if (r.error) return say(token, chatId, r.error);
      if (op === 'add' && r.value === 0) return say(token, chatId, '⚠️ أرسل رقمًا غير الصفر.');
      st.data.value = r.value;
      st.step = 'ac_limit';
      await save();
      return say(token, chatId, 'كم مرة يمكن للمستخدم تنفيذ هذا الإجراء؟', [
        [ib(actions.LIMITS.always, `a:al:${bid}:always`)],
        [ib(actions.LIMITS.once, `a:al:${bid}:once`)],
        [ib(actions.LIMITS.daily, `a:al:${bid}:daily`)],
        [ib('إلغاء', 'a:cx')],
      ]);
    }

    case 'v_scope':
    case 'v_type':
      return say(token, chatId, 'اختر من الأزرار أعلاه، أو /cancel للإلغاء.');

    case 'v_value': {
      const d = st.data || {};
      const r = parseValue(d.type, text);
      if (r.error) return say(token, chatId, r.error);
      if (!d.name || bot.vars[d.name]) return say(token, chatId, '⚠️ انتهت صلاحية هذه الخطوة.');
      bot.vars[d.name] = { id: store.rid('v'), scope: d.scope, type: d.type, value: r.value };
      await store.saveBot(bot);
      st.step = null;
      st.data = null;
      await save();
      const p = varPanel(bot, d.name);
      return say(token, chatId, `✅ تم إنشاء المتغير.\n\n${p.text}`, p.kb);
    }

    case 'v_set': {
      const d = bot.vars[(st.data || {}).name];
      if (!d) return say(token, chatId, '⚠️ المتغير غير موجود.');
      const r = parseValue(d.type, text);
      if (r.error) return say(token, chatId, r.error);
      d.value = r.value;
      await store.saveBot(bot);
      const name = st.data.name;
      st.step = null;
      st.data = null;
      await save();
      const p = varPanel(bot, name);
      return say(token, chatId, `✅ تم الحفظ.\n\n${p.text}`, p.kb);
    }

    case 'uv_id': {
      const name = (st.data || {}).name;
      if (!bot.vars[name]) return say(token, chatId, '⚠️ المتغير غير موجود.');
      if (!/^\d{1,15}$/.test(text)) return say(token, chatId, '⚠️ أرسل آيدي المستخدم (أرقام فقط).');
      if (!(await store.getSub(bot.id, text))) return say(token, chatId, '⚠️ هذا المستخدم ليس مشتركًا في البوت.');
      st.step = null;
      st.data = null;
      await save();
      const p = await uvPanel(bot, name, text);
      return say(token, chatId, p.text, p.kb);
    }

    case 'uv_set':
    case 'uv_chg': {
      const { name, uid: target } = st.data || {};
      const d = bot.vars[name];
      if (!d || !target) return say(token, chatId, '⚠️ انتهت صلاحية هذه الخطوة.');
      const r = parseValue(st.step === 'uv_chg' ? 'num' : d.type, text);
      if (r.error) return say(token, chatId, r.error);
      let value = r.value;
      if (st.step === 'uv_chg') {
        const uv = await store.getUVars(bot.id, target);
        const cur = Number(uv[d.id] !== undefined ? uv[d.id] : d.value) || 0;
        value = Math.round((cur + r.value) * 1e6) / 1e6;
      }
      await store.setUVar(bot.id, target, d.id, value);
      st.step = null;
      st.data = null;
      await save();
      const p = await uvPanel(bot, name, target);
      return say(token, chatId, `✅ تم الحفظ.\n\n${p.text}`, p.kb);
    }

    case 'menu_text': {
      if (!text || text.length > 100 || text.startsWith('/')) return say(token, chatId, '⚠️ أرسل نصًا (حتى 100 حرف).');
      bot.settings.menuText = esc(text);
      await store.saveBot(bot);
      st.step = null;
      await save();
      return refresh(bot, token, chatId, st, '✅ تم تحديث نص رسالة الكيبورد.');
    }

    case 'fs_add': {
      const chat = parseChannel(msg);
      if (chat === null) return say(token, chatId, '⚠️ أرسل معرّف القناة/المجموعة (@name) أو رابطها أو حوّل رسالة منها.');
      if ((bot.settings.forceSub || []).length >= L(bot).force) return say(token, chatId, '⚠️ وصلت للحد الأقصى.');
      try {
        const entry = await verifyChat(bot, token, chat);
        const list = bot.settings.forceSub || [];
        if (list.some((c) => String(c.chat) === String(entry.chat))) return say(token, chatId, '⚠️ مضافة بالفعل.');
        list.push(entry);
        bot.settings.forceSub = list;
        await store.saveBot(bot);
        st.step = null;
        await save();
        const p = await channelsPanel(bot, token);
        return say(token, chatId, `✅ تمت الإضافة.\n\n${p.text}`, p.kb);
      } catch (_) {
        return say(token, chatId, '❌ لا أستطيع الوصول إليها. أضف هذا البوت <b>مشرفًا</b> فيها ثم أعد الإرسال.\nللإلغاء: /cancel');
      }
    }

    case 'fs_text': {
      if (!text || text.length > 500) return say(token, chatId, '⚠️ أرسل نصًا (حتى 500 حرف).');
      bot.settings.forceText = text;
      await store.saveBot(bot);
      st.step = null;
      await save();
      const p = await channelsPanel(bot, token);
      return say(token, chatId, `✅ تم حفظ النص.\n\n${p.text}`, p.kb);
    }


    case 'content': {
      const page = pageOf(bot, (st.data || {}).pageId);
      if (!page) {
        st.step = null;
        await save();
        return say(token, chatId, '⚠️ الصفحة غير موجودة.');
      }
      const ex = adopt(extractMessage(msg), bot);
      if (ex.error) return say(token, chatId, ex.error);
      page.message = ex.ok;
      await store.saveBot(bot);
      st.step = null;
      st.data = null;
      await save();
      return refresh(bot, token, chatId, st, '✅ تم حفظ المحتوى.');
    }

    case 'bc_msg': {
      const ex = adopt(extractMessage(msg), bot);
      if (ex.error) return say(token, chatId, ex.error);
      const s = await store.subStats(bot.id);
      st.bc = { msg: ex.ok, cursor: null, sent: 0, failed: 0, blocked: 0 };
      st.step = null;
      await save();
      await say(token, chatId, '👇 معاينة البث:');
      await sendPage(token, chatId, bot, { id: 'bc', title: 'بث', message: ex.ok, buttons: [] }, { user: msg.from }).catch(() => {});
      return say(token, chatId, `سيُرسل إلى <b>${s.active}</b> مشترك نشط. تأكيد؟`, [[ib('✅ بدء البث', 'a:bcgo'), ib('إلغاء', 'a:cx')]]);
    }
  }
  st.step = null;
  await save();
  return false;
}

/* ------------------------------------------------------------------ */
/*  الأزرار المضمّنة (callback_data تبدأ بـ a:)                         */
/* ------------------------------------------------------------------ */
async function onCallback(bot, token, q) {
  const uid = String(q.from.id);
  const chatId = q.message.chat.id;
  const [, op, arg, arg2] = String(q.data).split(':');
  const answer = (extra) =>
    tg.call(token, 'answerCallbackQuery', Object.assign({ callback_query_id: q.id }, extra || {})).catch(() => {});
  if (!isAdmin(bot, uid)) return answer({ text: 'غير مصرّح', show_alert: true });
  const need = OP_PERM[op];
  if (need === 'owner' ? !isOwner(bot, uid) : need && !can(bot, uid, need)) {
    return answer({ text: '⛔ ليست لديك صلاحية لهذا القسم.', show_alert: true });
  }

  const st = await store.getCState(bot.id, uid);
  const save = () => store.saveCState(bot.id, uid, st);
  const edit = (text, kb) =>
    tg
      .call(token, 'editMessageText', {
        chat_id: chatId,
        message_id: q.message.message_id,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: kb || [] },
      })
      .catch(() => {});
  const btnById = (id) => (bot.rkb || []).find((x) => x.id === id);
  const done = async (text) => {
    await edit(text);
    return refresh(bot, token, chatId, st, '⌨️ تم تحديث القائمة.');
  };

  switch (op) {
    case 'cx':
      st.step = null;
      st.data = null;
      st.bc = null;
      await save();
      await answer();
      return edit('تم الإلغاء.');

    // ---- إضافة زر ----
    case 'tn':
    case 'tp': {
      if (st.step !== 'add_target' || !st.data || !st.data.text) return answer({ text: 'انتهت صلاحية هذه الخطوة.', show_alert: true });
      if ((bot.rkb || []).length >= L(bot).rkb) return answer({ text: 'وصلت للحد الأقصى للأزرار.', show_alert: true });
      let pageId = arg;
      let isNew = false;
      if (op === 'tn') {
        pageId = store.rid('p');
        bot.pages[pageId] = store.newPage(pageId, st.data.text);
        isNew = true;
      } else if (!pageOf(bot, pageId)) return answer({ text: 'الصفحة غير موجودة.', show_alert: true });
      bot.rkb = bot.rkb || [];
      bot.rkb.push({ id: store.rid('r'), text: st.data.text, page: pageId, newRow: true });
      await store.saveBot(bot);
      await answer();
      if (isNew) {
        st.step = 'content';
        st.data = { pageId };
        await save();
        await edit('✅ أُضيف الزر.');
        await refresh(bot, token, chatId, st, '⌨️ تم تحديث القائمة.');
        return say(token, chatId, '📝 أرسل الآن <b>محتوى الصفحة</b> (نص أو وسائط).\nللإلغاء: /cancel');
      }
      st.step = null;
      st.data = null;
      await save();
      return done('✅ أُضيف الزر وربط بالصفحة.');
    }

    // ---- تعديل زر ----
    case 'br': {
      if (!btnById(arg)) return answer({ text: 'الزر غير موجود.', show_alert: true });
      st.step = 'btn_rename';
      st.data = { bid: arg };
      await save();
      await answer();
      return say(token, chatId, '✏️ أرسل <b>النص الجديد</b> للزر (حتى 40 حرفًا).\nللإلغاء: /cancel');
    }
    case 'bp': {
      const b = btnById(arg);
      if (!b) return answer({ text: 'الزر غير موجود.', show_alert: true });
      await answer();
      return edit(`📄 اختر الصفحة الجديدة للزر «${esc(b.text)}»:`, pagesKb(bot, `a:bs:${b.id}:`));
    }
    case 'bs': {
      const b = btnById(arg);
      if (!b || !pageOf(bot, arg2)) return answer({ text: 'غير موجود.', show_alert: true });
      b.page = arg2;
      await store.saveBot(bot);
      await answer();
      const p = buttonPanel(bot, b);
      return edit(`✅ تم الربط.\n\n${p.text}`, p.kb);
    }
    case 'bu':
    case 'bd': {
      const i = (bot.rkb || []).findIndex((x) => x.id === arg);
      if (i < 0) return answer({ text: 'الزر غير موجود.', show_alert: true });
      const j = op === 'bu' ? i - 1 : i + 1;
      if (j < 0 || j >= bot.rkb.length) return answer();
      [bot.rkb[i], bot.rkb[j]] = [bot.rkb[j], bot.rkb[i]];
      await store.saveBot(bot);
      await answer();
      const p = buttonPanel(bot, bot.rkb[j]);
      await edit(p.text, p.kb);
      return refresh(bot, token, chatId, st, '⌨️ تم تحديث القائمة.');
    }
    case 'bw': {
      const b = btnById(arg);
      if (!b) return answer({ text: 'الزر غير موجود.', show_alert: true });
      b.newRow = b.newRow === false;
      await store.saveBot(bot);
      await answer();
      const p = buttonPanel(bot, b);
      await edit(p.text, p.kb);
      return refresh(bot, token, chatId, st, '⌨️ تم تحديث القائمة.');
    }
    case 'bx': {
      const b = btnById(arg);
      if (!b) return answer({ text: 'الزر غير موجود.', show_alert: true });
      await answer();
      return edit(`⚠️ حذف الزر «${esc(b.text)}»؟ (صفحته تبقى محفوظة)`, [[ib('✅ نعم، احذف', `a:bxy:${b.id}`), ib('إلغاء', 'a:cx')]]);
    }
    case 'bxy': {
      bot.rkb = (bot.rkb || []).filter((x) => x.id !== arg);
      await store.saveBot(bot);
      await answer();
      return done('🗑 تم حذف الزر.');
    }

    // ---- الإعدادات ----
    case 'tf': {
      if (arg !== 'feedback' && arg !== 'protect') return answer();
      bot.settings[arg] = !bot.settings[arg];
      await store.saveBot(bot);
      await answer();
      const p = settingsPanel(bot);
      return edit(p.text, p.kb);
    }



    // ---- إدارة المشرفين (المالك) ----
    case 'ml': {
      await answer();
      const p = adminsPanel(bot);
      return edit(p.text, p.kb);
    }
    case 'ma':
      if (adminEntries(bot).length >= L(bot).admins) return answer({ text: 'وصلت للحد الأقصى للمشرفين.', show_alert: true });
      st.step = 'adm_add';
      await save();
      await answer();
      return say(token, chatId, '👮 أرسل <b>آيدي المستخدم</b> أو حوّل إليّ رسالة منه.\n(يجب أن يكون قد فتح البوت /start أولًا)\nللإلغاء: /cancel');
    case 'mp': {
      const a = adminEntries(bot).find((x) => x.id === arg);
      if (!a) return answer({ text: 'المشرف غير موجود.', show_alert: true });
      await answer();
      const p = adminPermPanel(bot, a);
      return edit(p.text, p.kb);
    }
    case 'mt': {
      const list = adminEntries(bot);
      const a = list.find((x) => x.id === arg);
      if (!a || !PERMS[arg2]) return answer({ text: 'غير موجود.', show_alert: true });
      a.perms = a.perms || [];
      a.perms = a.perms.includes(arg2) ? a.perms.filter((x) => x !== arg2) : a.perms.concat(arg2);
      bot.settings.admins = list;
      await store.saveBot(bot);
      await answer();
      const p = adminPermPanel(bot, a);
      return edit(p.text, p.kb);
    }
    case 'md': {
      const a = adminEntries(bot).find((x) => x.id === arg);
      if (!a) return answer({ text: 'المشرف غير موجود.', show_alert: true });
      await answer();
      return edit(`⚠️ إزالة المشرف <b>${esc(a.name || a.id)}</b>؟`, [[ib('✅ نعم، أزِله', `a:mdy:${a.id}`), ib('إلغاء', 'a:ml')]]);
    }
    case 'mdy': {
      bot.settings.admins = adminEntries(bot).filter((x) => x.id !== arg);
      await store.saveBot(bot);
      await store.saveCState(bot.id, arg, { mode: 'main', step: null }); // يلغي أي خطوة جارية له
      await answer();
      say(token, arg, 'ℹ️ تمت إزالة صلاحيات الإشراف عنك. اكتب /start لتحديث القائمة.').catch(() => {});
      const p = adminsPanel(bot);
      return edit(`🗑 تمت الإزالة.\n\n${p.text}`, p.kb);
    }

    // ---- إجراءات الأزرار ----
    case 'bpn': {
      const b = btnById(arg);
      if (!b) return answer({ text: 'الزر غير موجود.', show_alert: true });
      await answer();
      const p = buttonPanel(bot, b);
      return edit(p.text, p.kb);
    }
    case 'ac': {
      const b = btnById(arg);
      if (!b) return answer({ text: 'الزر غير موجود.', show_alert: true });
      await answer();
      const p = actionsPanel(bot, b);
      return edit(p.text, p.kb);
    }
    case 'an': {
      const b = btnById(arg);
      if (!b) return answer({ text: 'الزر غير موجود.', show_alert: true });
      const names = Object.keys(bot.vars);
      if (!names.length) return answer({ text: 'أنشئ متغيرًا أولًا من 🗄 المتغيرات.', show_alert: true });
      if ((b.actions || []).length >= actions.MAX_ACTIONS) return answer({ text: 'وصلت للحد الأقصى للإجراءات.', show_alert: true });
      await answer();
      const kb = names.map((n) => [ib(`{${n}} ${bot.vars[n].scope === 'user' ? '👤' : '🌐'}`, `a:as:${b.id}:${n}`)]);
      kb.push([ib('🔙 رجوع', `a:ac:${b.id}`)]);
      return edit('اختر المتغير الذي سيتغير:', kb);
    }
    case 'as': {
      const b = btnById(arg);
      const d = bot.vars[arg2];
      if (!b || !d) return answer({ text: 'غير موجود.', show_alert: true });
      await answer();
      if (d.type === 'num') {
        st.step = 'ac_op';
        st.data = { bid: b.id, name: arg2 };
        await save();
        return edit(`ماذا نفعل بـ <code>{${arg2}}</code>؟`, [
          [ib('➕ إضافة / طرح', `a:ao:${b.id}:add`), ib('= تعيين قيمة', `a:ao:${b.id}:set`)],
          [ib('إلغاء', 'a:cx')],
        ]);
      }
      st.step = 'ac_value';
      st.data = { bid: b.id, name: arg2, op: 'set' };
      await save();
      await edit(`✅ <code>{${arg2}}</code> = ...`);
      return say(token, chatId, `✏️ أرسل القيمة النصية التي تُعيَّن لـ <code>{${arg2}}</code> عند الضغط.\nللإلغاء: /cancel`);
    }
    case 'ao': {
      if (st.step !== 'ac_op' || !st.data || st.data.bid !== arg || !['add', 'set'].includes(arg2)) {
        return answer({ text: 'انتهت صلاحية هذه الخطوة.', show_alert: true });
      }
      st.data.op = arg2;
      st.step = 'ac_value';
      await save();
      await answer();
      await edit(`✅ <code>{${st.data.name}}</code> ${arg2 === 'add' ? '± ...' : '= ...'}`);
      return say(
        token,
        chatId,
        arg2 === 'add'
          ? '➕ أرسل الرقم الذي يُضاف عند الضغط (سالب للطرح، مثل <code>-15</code>).\nللإلغاء: /cancel'
          : '= أرسل القيمة التي تُعيَّن عند الضغط (رقم).\nللإلغاء: /cancel'
      );
    }
    case 'al': {
      const b = btnById(arg);
      if (st.step !== 'ac_limit' || !st.data || !b || !actions.LIMITS[arg2]) {
        return answer({ text: 'انتهت صلاحية هذه الخطوة.', show_alert: true });
      }
      const { name, op, value } = st.data;
      if (!bot.vars[name]) return answer({ text: 'المتغير غير موجود.', show_alert: true });
      const a = { id: store.rid('x'), var: name, op, value, limit: arg2 };
      if (op === 'add' && value < 0) a.min = -value; // الطرح يتطلب رصيدًا كافيًا
      b.actions = b.actions || [];
      b.actions.push(a);
      await store.saveBot(bot);
      st.step = null;
      st.data = null;
      await save();
      await answer();
      const p = actionsPanel(bot, b);
      return edit(`✅ تمت إضافة الإجراء.\n\n${p.text}`, p.kb);
    }
    case 'ad': {
      const b = btnById(arg);
      if (!b) return answer({ text: 'الزر غير موجود.', show_alert: true });
      b.actions = (b.actions || []).filter((x) => x.id !== arg2);
      await store.saveBot(bot);
      await answer();
      const p = actionsPanel(bot, b);
      return edit(p.text, p.kb);
    }

    // ---- رسالة البدء ----
    case 'sm':
      await answer();
      return askContent(bot, token, chatId, st, save, 'main');
    case 'sp':
      await answer();
      return sendPage(token, chatId, bot, bot.pages.main, { user: q.from }).catch(() => say(token, chatId, '⚠️ رسالة البدء غير محددة بعد.'));
    case 'sk':
      st.step = 'menu_text';
      await save();
      await answer();
      return say(token, chatId, '⌨️ أرسل <b>النص</b> الذي يظهر مع الكيبورد السفلي (حتى 100 حرف).\nللإلغاء: /cancel');
    case 'skr': {
      delete bot.settings.menuText;
      await store.saveBot(bot);
      await answer();
      const p = startPanel(bot);
      return edit(p.text, p.kb);
    }

    // ---- المتغيرات ----
    case 'vl': {
      await answer();
      const p = varsPanel(bot);
      return edit(p.text, p.kb);
    }
    case 'va':
      if (Object.keys(bot.vars).length >= L(bot).vars) return answer({ text: 'وصلت للحد الأقصى للمتغيرات.', show_alert: true });
      st.step = 'v_name';
      st.data = null;
      await save();
      await answer();
      return say(token, chatId, '🗄 أرسل <b>اسم المتغير</b> (حروف إنجليزية صغيرة وأرقام و _، مثل <code>coins</code>).\nللإلغاء: /cancel');
    case 'vsg':
    case 'vsu':
      if (st.step !== 'v_scope' || !st.data) return answer({ text: 'انتهت صلاحية هذه الخطوة.', show_alert: true });
      st.data.scope = op === 'vsu' ? 'user' : 'global';
      st.step = 'v_type';
      await save();
      await answer();
      return edit(`نوع المتغير <code>{${st.data.name}}</code>؟`, [[ib('🔢 رقم', 'a:vtn'), ib('🔤 نص', 'a:vtt')], [ib('إلغاء', 'a:cx')]]);
    case 'vtn':
    case 'vtt':
      if (st.step !== 'v_type' || !st.data) return answer({ text: 'انتهت صلاحية هذه الخطوة.', show_alert: true });
      st.data.type = op === 'vtn' ? 'num' : 'text';
      st.step = 'v_value';
      await save();
      await answer();
      await edit(`✅ ${st.data.scope === 'user' ? '👤 لكل مستخدم' : '🌐 عام'} • ${st.data.type === 'num' ? '🔢 رقم' : '🔤 نص'}`);
      return say(token, chatId, `أرسل الآن ${st.data.scope === 'user' ? '<b>القيمة الافتراضية</b>' : '<b>القيمة</b>'} (${st.data.type === 'num' ? 'رقم' : 'نص'}).\nللإلغاء: /cancel`);
    case 'vp': {
      if (!bot.vars[arg]) return answer({ text: 'المتغير غير موجود.', show_alert: true });
      await answer();
      const p = varPanel(bot, arg);
      return edit(p.text, p.kb);
    }
    case 'vv':
      if (!bot.vars[arg]) return answer({ text: 'المتغير غير موجود.', show_alert: true });
      st.step = 'v_set';
      st.data = { name: arg };
      await save();
      await answer();
      return say(token, chatId, `✏️ أرسل القيمة الجديدة لـ <code>{${arg}}</code> (${bot.vars[arg].type === 'num' ? 'رقم' : 'نص'}).\nللإلغاء: /cancel`);
    case 'vu':
      if (!bot.vars[arg] || bot.vars[arg].scope !== 'user') return answer({ text: 'غير متاح.', show_alert: true });
      st.step = 'uv_id';
      st.data = { name: arg };
      await save();
      await answer();
      return say(token, chatId, '👤 أرسل <b>آيدي المستخدم</b> (يجب أن يكون مشتركًا في البوت).\nللإلغاء: /cancel');
    case 'uvs':
    case 'uvc': {
      const d = bot.vars[arg];
      if (!d || d.scope !== 'user' || !/^\d{1,15}$/.test(arg2 || '')) return answer({ text: 'غير متاح.', show_alert: true });
      st.step = op === 'uvs' ? 'uv_set' : 'uv_chg';
      st.data = { name: arg, uid: arg2 };
      await save();
      await answer();
      return say(
        token,
        chatId,
        op === 'uvs'
          ? `✏️ أرسل القيمة الجديدة (${d.type === 'num' ? 'رقم' : 'نص'}).\nللإلغاء: /cancel`
          : '➕➖ أرسل الرقم الذي سيُضاف (استخدم سالبًا للطرح، مثل <code>-5</code>).\nللإلغاء: /cancel'
      );
    }
    case 'vx': {
      if (!bot.vars[arg]) return answer({ text: 'المتغير غير موجود.', show_alert: true });
      await answer();
      return edit(`⚠️ حذف <code>{${arg}}</code>؟ ستبقى النصوص التي تستخدمه كما هي دون استبدال.`, [[ib('✅ نعم، احذف', `a:vxy:${arg}`), ib('إلغاء', 'a:cx')]]);
    }
    case 'vxy': {
      delete bot.vars[arg];
      await store.saveBot(bot);
      await answer();
      const p = varsPanel(bot);
      return edit(`🗑 تم الحذف.\n\n${p.text}`, p.kb);
    }

    // ---- القنوات والمجموعات ----
    case 'fs': {
      await answer();
      const p = await channelsPanel(bot, token);
      return edit(p.text, p.kb);
    }
    case 'fa':
      if ((bot.settings.forceSub || []).length >= L(bot).force) return answer({ text: 'وصلت للحد الأقصى.', show_alert: true });
      st.step = 'fs_add';
      await save();
      await answer();
      return say(
        token,
        chatId,
        '📡 أرسل معرّف القناة أو المجموعة (<code>@name</code>) أو رابطها، أو حوّل إليّ رسالة منها.\n\n⚠️ أضف هذا البوت <b>مشرفًا</b> فيها أولًا.\nللإلغاء: /cancel'
      );
    case 'fd': {
      const list = bot.settings.forceSub || [];
      if (list[Number(arg)]) {
        list.splice(Number(arg), 1);
        bot.settings.forceSub = list;
        await store.saveBot(bot);
      }
      await answer();
      const p = await channelsPanel(bot, token);
      return edit(p.text, p.kb);
    }
    case 'ft':
      st.step = 'fs_text';
      await save();
      await answer();
      return say(token, chatId, '✏️ أرسل <b>نص رسالة الاشتراك</b> التي تظهر لمن لم يشترك.\nللإلغاء: /cancel');
    case 'ff': {
      delete bot.settings.forceText;
      await store.saveBot(bot);
      await answer();
      const p = await channelsPanel(bot, token);
      return edit(p.text, p.kb);
    }

    // ---- البث ----
    case 'bcgo':
    case 'bcnext': {
      const job = st.bc;
      if (!job) return answer({ text: 'انتهت صلاحية هذا البث.', show_alert: true });
      await answer();
      const finished = await runBroadcast(bot, token, job);
      if (finished) st.bc = null;
      await save();
      return edit(
        finished ? `📢 <b>اكتمل البث</b>\n\n${bcReport(job)}` : `⏳ <b>البث جارٍ…</b>\n\n${bcReport(job)}`,
        finished ? [] : [[ib('▶️ متابعة', 'a:bcnext')]]
      );
    }
  }
  return answer();
}

module.exports = { isAdmin, showMenu, command, onMessage, onCallback };
