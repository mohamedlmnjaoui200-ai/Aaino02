'use strict';
// لوحة إدارة داخل البوت الابن نفسه (كيبورد سفلي للمستخدمين + محرر أزرار + محتوى + إحصائيات + بث + إعدادات)
const tg = require('./telegram');
const store = require('./store');
const { sendPage, extractMessage } = require('./render');

const BC_BUDGET = Number(process.env.BC_BUDGET_MS || 8000);
const MAX_RKB = 20; // أقصى عدد أزرار الكيبورد السفلي
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
};
const RESERVED = new Set(Object.values(T));

const isAdmin = (bot, uid) =>
  String(uid) === String(bot.owner) || ((bot.settings && bot.settings.admins) || []).map(String).includes(String(uid));

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

function rowsFor(bot, st, admin) {
  const mode = admin ? st.mode || 'main' : 'main';
  const rows = userRows(bot);
  if (mode === 'admin') return [[T.stats, T.bc], [T.start, T.settings], [T.exit]];
  if (mode === 'editor') {
    rows.push([T.add]);
    rows.push([T.stopE]);
  } else if (mode === 'content') {
    rows.push([T.start]);
    rows.push([T.stopC]);
  } else if (admin) {
    rows.push([T.editor, T.content]);
    rows.push([T.admin]);
  }
  return rows.length ? rows : null;
}

function sendKeyboard(bot, token, chatId, text, st, admin) {
  const rows = rowsFor(bot, st, admin);
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
      `↔️ الصف: ${b.newRow === false ? 'مع الزر السابق' : 'صف مستقل'}`,
    kb: [
      [ib('✏️ تغيير النص', `a:br:${b.id}`), ib('📄 تغيير الصفحة', `a:bp:${b.id}`)],
      [ib('⬆️', `a:bu:${b.id}`), ib('⬇️', `a:bd:${b.id}`), ib(b.newRow === false ? '↕️ صف مستقل' : '↔️ مع السابق', `a:bw:${b.id}`)],
      [ib('🗑 حذف الزر', `a:bx:${b.id}`)],
      [ib('إغلاق', 'a:cx')],
    ],
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
  await h.deliver(token, bot, msg.chat.id, page, msg.from);
  return true;
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

  switch (text) {
    case T.editor:
      return setMode(bot, token, chatId, uid, st, 'editor');
    case T.content:
      return setMode(bot, token, chatId, uid, st, 'content');
    case T.admin:
      return setMode(bot, token, chatId, uid, st, 'admin');
    case T.add:
      if (mode !== 'editor') break;
      if ((bot.rkb || []).length >= MAX_RKB) return say(token, chatId, `⚠️ وصلت للحد الأقصى (${MAX_RKB} زرًا).`);
      st.step = 'add_text';
      await save();
      return say(token, chatId, '✏️ أرسل <b>نص الزر</b> (حتى 40 حرفًا).\nللإلغاء: /cancel');
    case T.stats:
      if (mode !== 'admin') break;
      return say(token, chatId, await statsText(bot));
    case T.bc:
      if (mode !== 'admin') break;
      st.step = 'bc_msg';
      await save();
      return say(token, chatId, '📢 أرسل الرسالة التي تريد بثها لمشتركي البوت (نص أو وسائط).\nللإلغاء: /cancel');
    case T.start:
      if (mode !== 'admin' && mode !== 'content') break;
      return askContent(bot, token, chatId, st, save, 'main');
    case T.settings: {
      if (mode !== 'admin') break;
      const p = settingsPanel(bot);
      return say(token, chatId, p.text, p.kb);
    }
  }

  // ضغطة على زر مستخدم
  const b = (bot.rkb || []).find((x) => x.text === text);
  if (!b) return false;
  if (mode === 'editor') {
    const p = buttonPanel(bot, b);
    return say(token, chatId, p.text, p.kb);
  }
  if (mode === 'content') {
    if (!pageOf(bot, b.page)) return say(token, chatId, '⚠️ الصفحة المرتبطة بهذا الزر محذوفة.');
    return askContent(bot, token, chatId, st, save, b.page);
  }
  const page = pageOf(bot, b.page);
  if (page) await h.deliver(token, bot, chatId, page, msg.from);
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
      if ((bot.rkb || []).length >= MAX_RKB) return answer({ text: 'وصلت للحد الأقصى للأزرار.', show_alert: true });
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
