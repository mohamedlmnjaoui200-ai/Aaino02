'use strict';
const tg = require('./telegram');
const store = require('./store');
const { decrypt } = require('./crypto');
const { sendPage, showPage, extractMessage, MEDIA } = require('./render');
const admin = require('./admin');
const ai = require('./ai');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const MEMBER_OK = ['creator', 'administrator', 'member', 'restricted'];

/* ------------------------------------------------------------------ */
/*  أدوات                                                              */
/* ------------------------------------------------------------------ */
// يحفظ file_id الجديد الخاص بالبوت الابن دون الكتابة فوق تعديلات المالك
async function persistFid(bot, page) {
  try {
    const m = page.message;
    if (!m || !m.media || !m.media.fids) return;
    const fresh = await store.getBot(bot.id);
    const fp = fresh && fresh.pages[page.id];
    if (!fp || !fp.message || !fp.message.media || fp.message.media.mainId !== m.media.mainId) return;
    fp.message.media.fids = Object.assign({}, fp.message.media.fids, m.media.fids);
    await store.saveBot(fresh);
  } catch (_) {}
}

const isBlockedErr = (e) => /blocked|deactivated|kicked|chat not found/i.test((e && e.message) || '');

/* ------------------------------------------------------------------ */
/*  الاشتراك الإجباري في القنوات                                         */
/* ------------------------------------------------------------------ */
async function missingChannels(token, uid, list) {
  const miss = [];
  for (const ch of list || []) {
    try {
      const m = await tg.call(token, 'getChatMember', { chat_id: ch.chat, user_id: uid });
      const ok = MEMBER_OK.includes(m.status) && !(m.status === 'restricted' && m.is_member === false);
      if (!ok) miss.push(ch);
    } catch (_) {
      // البوت ليس مشرفًا في القناة: نتجاوز الفحص حتى لا نحجب المستخدمين
    }
  }
  return miss;
}

function joinLink(ch) {
  if (ch.link) return ch.link;
  if (typeof ch.chat === 'string' && ch.chat.startsWith('@')) return `https://t.me/${ch.chat.slice(1)}`;
  return null;
}

// يعيد true إن كان المستخدم مستوفيًا للشروط، وإلا يرسل رسالة الاشتراك ويعيد false
async function gate(token, bot, chatId, uid, srcMsg) {
  if (admin.isAdmin(bot, uid)) return true; // المشرفون لا يخضعون للاشتراك الإجباري
  const list = bot.settings.forceSub || [];
  if (!list.length) return true;
  const miss = await missingChannels(token, uid, list);
  if (!miss.length) return true;
  const kb = miss
    .map((c) => {
      const url = joinLink(c);
      return url ? [{ text: `📢 ${c.title || c.chat}`, url }] : null;
    })
    .filter(Boolean);
  kb.push([{ text: '✅ تحققت من اشتراكي', callback_data: 'chk' }]);
  const text = bot.settings.forceText || '🔒 للاستمرار يجب الاشتراك في القنوات التالية ثم الضغط على «تحققت من اشتراكي».';
  if (srcMsg && srcMsg.text !== undefined) {
    try {
      await tg.call(token, 'editMessageText', {
        chat_id: chatId,
        message_id: srcMsg.message_id,
        text,
        reply_markup: { inline_keyboard: kb },
      });
      return false;
    } catch (_) {}
  }
  await tg.call(token, 'sendMessage', { chat_id: chatId, text, reply_markup: { inline_keyboard: kb } });
  return false;
}

/* ------------------------------------------------------------------ */
/*  إرسال صفحة                                                         */
/* ------------------------------------------------------------------ */
async function deliver(token, bot, chatId, page, user) {
  if (!page || (!page.message && !(page.buttons || []).length)) {
    await tg.call(token, 'sendMessage', { chat_id: chatId, text: 'لم يتم إعداد رسالة هذا البوت بعد.' });
    return;
  }
  const r = await sendPage(token, chatId, bot, page, { user });
  if (r.cached) await persistFid(bot, page);
  store.incStat(bot.id, 'views').catch(() => {});
}

/* ------------------------------------------------------------------ */
/*  تلقّي رسائل المستخدمين (وضع التواصل مع المالك)                       */
/* ------------------------------------------------------------------ */
async function forwardToOwner(bot, token, msg) {
  const mainTok = process.env.MAIN_BOT_TOKEN;
  const u = msg.from;
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'مستخدم';
  const head =
    `📩 <b>رسالة جديدة</b> عبر @${esc(bot.username)}\n` +
    `👤 ${esc(name)}${u.username ? ` (@${esc(u.username)})` : ''}\n🆔 <code>${u.id}</code>`;
  const kb = { inline_keyboard: [[{ text: '↩️ رد', callback_data: `rp:${bot.id}:${u.id}` }]] };

  const ex = extractMessage(msg);
  if (ex.ok && ex.ok.media) {
    const f = await tg.call(token, 'getFile', { file_id: ex.ok.media.mainId });
    const type = ex.ok.media.type;
    const cap = `${head}\n\n${esc(ex.ok.text || '').slice(0, 800)}`;
    await tg.call(mainTok, MEDIA[type].method, {
      chat_id: bot.owner,
      [type]: `https://api.telegram.org/file/bot${token}/${f.file_path}`,
      caption: cap,
      parse_mode: 'HTML',
      reply_markup: kb,
    });
    return true;
  }
  if (msg.text) {
    await tg.call(mainTok, 'sendMessage', {
      chat_id: bot.owner,
      text: `${head}\n\n${esc(msg.text).slice(0, 3500)}`,
      parse_mode: 'HTML',
      reply_markup: kb,
    });
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  الذكاء الاصطناعي: ردّ تلقائي بلهجة العميل من معلومات نشاط المالك     */
/* ------------------------------------------------------------------ */
async function handleAI(bot, token, msg) {
  const send = (text) =>
    tg.call(token, 'sendMessage', {
      chat_id: msg.chat.id,
      text,
      reply_to_message_id: msg.message_id,
      protect_content: !!bot.settings.protect,
    });
  let r;
  try {
    r = await ai.reply(bot, token, msg);
  } catch (e) {
    console.error('ai error', bot.id, e && e.message);
    await send('⚠️ الخدمة مشغولة الآن، حاول بعد قليل.').catch(() => {});
    return;
  }
  if (r.silent) return;
  await send(r.text);
  // طلب يحتاج بشرًا: نحوّله للمالك إن كان وضع التواصل مفعّلًا
  if (r.handoff && bot.settings.feedback) {
    const ok = await forwardToOwner(bot, token, msg).catch(() => false);
    if (ok) store.incStat(bot.id, 'feedback').catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/*  المعالجات                                                          */
/* ------------------------------------------------------------------ */
async function onMessage(bot, token, msg) {
  const isPrivate = msg.chat.type === 'private';
  const text = (msg.text || '').trim();
  const m = text.match(/^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s+(.*))?$/s);

  if (isPrivate && msg.from) {
    const fresh = await store.touchSub(bot.id, msg.from);
    if (fresh) store.incStat(bot.id, 'joins').catch(() => {});
  }

  if (m) {
    const cmd = m[1].toLowerCase();
    const payload = (m[2] || '').trim();
    // أوامر المشرف داخل البوت: /admin و /cancel
    if (isPrivate && msg.from && (cmd === 'admin' || cmd === 'cancel') && admin.isAdmin(bot, msg.from.id)) {
      return admin.command(bot, token, msg, cmd);
    }
    let pageId = bot.commands[cmd];

    // رابط عميق: /start p_<معرّف الصفحة> يفتح صفحة محددة
    if (cmd === 'start' && /^p_[A-Za-z0-9_]+$/.test(payload) && bot.pages[payload.slice(2)]) {
      pageId = payload.slice(2);
    }
    if (!pageId || !bot.pages[pageId]) return;
    if (isPrivate && !(await gate(token, bot, msg.chat.id, msg.from.id))) return;
    await deliver(token, bot, msg.chat.id, bot.pages[pageId], msg.from);
    // الكيبورد السفلي (أزرار القائمة + أزرار الإدارة للمشرف)
    if (isPrivate && cmd === 'start' && msg.from) await admin.showMenu(bot, token, msg.chat.id, msg.from.id);
    return;
  }

  // ضغطات الكيبورد السفلي ورسائل المشرف (محرر الأزرار، المحتوى، البث...)
  if (isPrivate && msg.from) {
    const handled = await admin.onMessage(bot, token, msg, { deliver, gate });
    if (handled) return;
  }

  // رسالة نصية عادية والذكاء الاصطناعي مفعّل: يردّ البوت تلقائيًا
  if (isPrivate && msg.from && msg.text) {
    const a = ai.cfg(bot);
    if (a.enabled && a.info) {
      if (!(await gate(token, bot, msg.chat.id, msg.from.id))) return;
      return handleAI(bot, token, msg);
    }
  }

  // رسالة عادية في الخاص: تُمرَّر للمالك إن كان وضع التواصل مفعّلًا
  if (isPrivate && bot.settings.feedback) {
    if (!(await gate(token, bot, msg.chat.id, msg.from.id))) return;
    const ok = await forwardToOwner(bot, token, msg).catch(() => false);
    if (ok) {
      store.incStat(bot.id, 'feedback').catch(() => {});
      await tg.call(token, 'sendMessage', {
        chat_id: msg.chat.id,
        text: bot.settings.feedbackAck || '✅ تم استلام رسالتك وسنرد عليك قريبًا.',
        reply_to_message_id: msg.message_id,
      });
    }
  }
}

async function onCallback(bot, token, q) {
  const answer = (extra) =>
    tg.call(token, 'answerCallbackQuery', Object.assign({ callback_query_id: q.id }, extra || {})).catch(() => {});
  if (!q.message) return answer();
  const chatId = q.message.chat.id;
  const d = q.data || '';

  if (d.startsWith('a:')) return admin.onCallback(bot, token, q);

  if (d === 'chk') {
    const miss = await missingChannels(token, q.from.id, bot.settings.forceSub);
    if (miss.length) return answer({ text: '❌ لم تشترك في كل القنوات بعد.', show_alert: true });
    await answer();
    return showPage(token, chatId, q.message, bot, bot.pages.main, { user: q.from }).then((r) => {
      if (r.cached) return persistFid(bot, bot.pages.main);
    });
  }

  if (d.startsWith('g:')) {
    const page = bot.pages[d.slice(2)];
    if (!page) return answer({ text: 'هذه الصفحة لم تعد متاحة.', show_alert: true });
    await answer();
    if (!(await gate(token, bot, chatId, q.from.id, q.message))) return;
    store.incStat(bot.id, 'clicks').catch(() => {});
    const r = await showPage(token, chatId, q.message, bot, page, { user: q.from });
    if (r.cached) await persistFid(bot, page);
    return;
  }
  return answer();
}

// حظر البوت أو إلغاء الحظر من المستخدم
async function onMember(bot, upd) {
  if (!upd.chat || upd.chat.type !== 'private') return;
  const st = upd.new_chat_member && upd.new_chat_member.status;
  if (st === 'kicked' || st === 'left') await store.setSubBlocked(bot.id, upd.from.id, true);
  else if (st === 'member') await store.setSubBlocked(bot.id, upd.from.id, false);
}

// معالجة تحديثات البوتات التي أنشأها المستخدمون
async function handle(botId, update) {
  const bot = await store.getBot(botId);
  if (!bot) return;
  const token = decrypt(bot.tokenEnc);
  try {
    if (update.message) return await onMessage(bot, token, update.message);
    if (update.callback_query) return await onCallback(bot, token, update.callback_query);
    if (update.my_chat_member) return await onMember(bot, update.my_chat_member);
  } catch (e) {
    const uid =
      (update.message && update.message.from && update.message.from.id) ||
      (update.callback_query && update.callback_query.from.id);
    if (uid && isBlockedErr(e)) await store.setSubBlocked(bot.id, uid, true).catch(() => {});
    else console.error('child error', bot.id, e && e.message);
  }
}

module.exports = { handle };
