'use strict';
const tg = require('./telegram');
const store = require('./store');
const { encrypt, decrypt, secretFor } = require('./crypto');
const { COLORS, styled, sendStored } = require('./render');

const MAX_BOTS_PER_USER = 10;
const MAX_BUTTONS = 6;
const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;

const main = () => process.env.MAIN_BOT_TOKEN;
const baseUrl = () => String(process.env.BASE_URL).replace(/\/+$/, '');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const btn = (text, data, style) => styled({ text, callback_data: data }, style);

/* ---------- أدوات الإرسال ---------- */
function send(chatId, text, kb) {
  const p = { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  if (kb) p.reply_markup = { inline_keyboard: kb };
  return tg.call(main(), 'sendMessage', p);
}

async function show(ctx, text, kb) {
  // إن جاء من زر: عدّل الرسالة، وإلا أرسل رسالة جديدة
  if (ctx.q) {
    try {
      await tg.call(main(), 'editMessageText', {
        chat_id: ctx.chatId,
        message_id: ctx.q.message.message_id,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: kb || [] },
      });
      return;
    } catch (e) {
      if (/not modified/i.test(e.message)) return;
    }
  }
  await send(ctx.chatId, text, kb);
}

/* ---------- الواجهات ---------- */
function mainMenu() {
  return [
    [btn('➕ إنشاء بوت جديد', 'new', 'success')],
    [btn('🤖 بوتاتي', 'list', 'primary')],
    [btn('ℹ️ المساعدة', 'help')],
  ];
}

const WELCOME =
  '👋 أهلًا بك في <b>صانع البوتات</b>\n\n' +
  'أنشئ بوت تيليجرام خاصًا بك في دقيقة: ضع توكن البوت، ثم حدّد الرسالة التي ستظهر عند كتابة <code>/ms</code> وأضف أزرارًا سفلية بالألوان والروابط التي تريدها.';

const HELP =
  '<b>طريقة الاستخدام</b>\n\n' +
  '1️⃣ أنشئ بوتًا من @BotFather وانسخ التوكن.\n' +
  '2️⃣ اضغط «إنشاء بوت جديد» وأرسل التوكن.\n' +
  '3️⃣ أرسل الرسالة التي تريدها كما هي (التنسيق والروابط تُحفظ كما هي).\n' +
  '4️⃣ أضف أزرارًا سفلية (نص + رابط + لون) إن أردت.\n' +
  '5️⃣ اكتب <code>/ms</code> في بوتك لتظهر الرسالة.\n\n' +
  '🔒 التوكنات تُخزَّن مشفّرة.';

function botPanel(bot) {
  const text =
    `🤖 <b>${esc(bot.name)}</b> (@${esc(bot.username)})\n\n` +
    `📝 الرسالة: ${bot.message ? '✅ محفوظة' : '❌ غير محددة'}\n` +
    `🔘 الأزرار: ${bot.buttons.length}/${MAX_BUTTONS}\n\n` +
    'اكتب <code>/ms</code> في البوت لعرض الرسالة.';
  const kb = [
    [btn('📝 تعديل الرسالة', `msg:${bot.id}`, 'primary')],
    [btn('🔘 إدارة الأزرار', `btns:${bot.id}`, 'primary')],
    [btn('👁 معاينة', `prev:${bot.id}`, 'success')],
    [btn('🗑 حذف البوت', `del:${bot.id}`, 'danger')],
    [btn('🔙 رجوع', 'list')],
  ];
  return { text, kb };
}

function buttonsPanel(bot) {
  const lines = bot.buttons.length
    ? bot.buttons.map((b, i) => `${i + 1}. ${COLORS[b.style || 'default']} — ${esc(b.text)}`).join('\n')
    : 'لا توجد أزرار بعد.';
  const kb = [];
  if (bot.buttons.length < MAX_BUTTONS) kb.push([btn('➕ إضافة زر', `badd:${bot.id}`, 'success')]);
  bot.buttons.forEach((b, i) => kb.push([btn(`🗑 حذف: ${b.text}`, `bdel:${bot.id}:${i}`, 'danger')]));
  kb.push([btn('🔙 رجوع', `b:${bot.id}`)]);
  return { text: `🔘 <b>الأزرار السفلية</b>\n\n${lines}`, kb };
}

/* ---------- المنطق ---------- */
function ownedBot(uid, id) {
  const b = store.db.bots[id];
  return b && b.owner === uid ? b : null;
}

async function showPanel(ctx, bot) {
  const p = botPanel(bot);
  await show(ctx, p.text, p.kb);
}

async function createBot(ctx, token) {
  if (!TOKEN_RE.test(token)) {
    await send(ctx.chatId, '❌ التوكن غير صالح. تأكد من نسخه كاملًا من @BotFather وأعد إرساله.', [
      [btn('إلغاء', 'menu')],
    ]);
    return;
  }
  // احذف رسالة التوكن من المحادثة لحمايته
  tg.call(main(), 'deleteMessage', { chat_id: ctx.chatId, message_id: ctx.msg.message_id }).catch(() => {});

  let me;
  try {
    me = await tg.call(token, 'getMe');
  } catch (_) {
    await send(ctx.chatId, '❌ تعذّر التحقق من التوكن. تأكد أنه صحيح وغير ملغى.', [[btn('إلغاء', 'menu')]]);
    return;
  }
  const id = String(me.id);
  const existing = store.db.bots[id];
  if (existing && existing.owner !== ctx.uid) {
    await send(ctx.chatId, '❌ هذا البوت مسجّل لدى مستخدم آخر.', [[btn('🔙 القائمة', 'menu')]]);
    return;
  }
  const count = Object.values(store.db.bots).filter((b) => b.owner === ctx.uid).length;
  if (!existing && count >= MAX_BOTS_PER_USER) {
    await send(ctx.chatId, `❌ وصلت للحد الأقصى (${MAX_BOTS_PER_USER} بوتات).`, [[btn('🔙 القائمة', 'menu')]]);
    return;
  }

  try {
    await tg.call(token, 'setWebhook', {
      url: `${baseUrl()}/webhook/child/${id}`,
      secret_token: secretFor(`child:${id}`),
      allowed_updates: ['message'],
      drop_pending_updates: true,
    });
    await tg
      .call(token, 'setMyCommands', { commands: [{ command: 'ms', description: 'عرض الرسالة' }] })
      .catch(() => {});
  } catch (e) {
    await send(ctx.chatId, `❌ فشل ربط البوت: ${esc(e.message)}`, [[btn('🔙 القائمة', 'menu')]]);
    return;
  }

  const bot = existing || {
    id,
    owner: ctx.uid,
    message: null,
    buttons: [],
    createdAt: Date.now(),
  };
  bot.username = me.username;
  bot.name = me.first_name;
  bot.tokenEnc = encrypt(token);
  store.db.bots[id] = bot;
  store.user(ctx.uid).state = { step: 'message', botId: id };
  store.save();

  await send(
    ctx.chatId,
    `✅ تم ربط <b>@${esc(me.username)}</b> بنجاح!\n\nالآن أرسل لي <b>الرسالة</b> التي تريد أن يرسلها البوت عند كتابة <code>/ms</code> (سيتم حفظها كما هي بنفس التنسيق والروابط).`,
    [[btn('تخطي الآن', `b:${id}`)]]
  );
}

async function onMessage(ctx) {
  const { msg, uid } = ctx;
  const text = msg.text || '';
  const u = store.user(uid);

  if (/^\/start(@\w+)?(\s|$)/.test(text) || /^\/menu(@\w+)?(\s|$)/.test(text)) {
    u.state = null;
    store.save();
    return send(ctx.chatId, WELCOME, mainMenu());
  }

  if (text === '/stats' && String(uid) === String(process.env.ADMIN_ID || '')) {
    return send(
      ctx.chatId,
      `👥 المستخدمون: ${Object.keys(store.db.users).length}\n🤖 البوتات: ${Object.keys(store.db.bots).length}`
    );
  }

  const st = u.state;
  if (!st) return send(ctx.chatId, 'اختر من القائمة 👇', mainMenu());

  if (st.step === 'token') {
    return createBot(ctx, text.trim());
  }

  if (st.step === 'message') {
    const bot = ownedBot(uid, st.botId);
    if (!bot) return;
    if (!msg.text) return send(ctx.chatId, '⚠️ أرسل الرسالة كنص (يدعم التنسيق والروابط).');
    if (msg.text.length > 4096) return send(ctx.chatId, '⚠️ الرسالة أطول من 4096 حرفًا.');
    bot.message = { text: msg.text, entities: msg.entities || [] };
    u.state = null;
    store.save();
    await send(ctx.chatId, '✅ تم حفظ الرسالة.');
    return showPanel(ctx, bot);
  }

  if (st.step === 'btn_text') {
    if (!msg.text || msg.text.length > 40) return send(ctx.chatId, '⚠️ أرسل نص الزر (حتى 40 حرفًا).');
    st.step = 'btn_url';
    st.text = msg.text.trim();
    store.save();
    return send(ctx.chatId, '🔗 الآن أرسل <b>رابط</b> الزر (يبدأ بـ https:// أو http://).', [
      [btn('إلغاء', `btns:${st.botId}`)],
    ]);
  }

  if (st.step === 'btn_url') {
    const url = text.trim();
    if (!/^https?:\/\/[^\s]+\.[^\s]+$/i.test(url) && !/^tg:\/\/[^\s]+$/i.test(url)) {
      return send(ctx.chatId, '⚠️ رابط غير صالح. يجب أن يبدأ بـ https:// أو http://');
    }
    st.step = 'btn_color';
    st.url = url;
    store.save();
    return send(ctx.chatId, '🎨 اختر <b>لون الزر</b>:', [
      [btn(COLORS.primary, 'col:primary', 'primary'), btn(COLORS.success, 'col:success', 'success')],
      [btn(COLORS.danger, 'col:danger', 'danger'), btn(COLORS.default, 'col:default')],
    ]);
  }

  return send(ctx.chatId, 'اختر من القائمة 👇', mainMenu());
}

async function onCallback(ctx) {
  const { q, uid } = ctx;
  const d = q.data || '';
  const u = store.user(uid);
  const [act, a, b] = d.split(':');

  if (act === 'menu') {
    u.state = null;
    store.save();
    return show(ctx, WELCOME, mainMenu());
  }
  if (act === 'help') return show(ctx, HELP, [[btn('🔙 رجوع', 'menu')]]);

  if (act === 'new') {
    u.state = { step: 'token' };
    store.save();
    return show(
      ctx,
      '🔑 أرسل الآن <b>توكن البوت</b> الذي أنشأته من @BotFather.\n\nسأحذف رسالتك فور التحقق منه لحمايته.',
      [[btn('إلغاء', 'menu')]]
    );
  }

  if (act === 'list') {
    u.state = null;
    const mine = Object.values(store.db.bots).filter((x) => x.owner === uid);
    if (!mine.length) {
      return show(ctx, 'لا توجد لديك بوتات بعد.', [
        [btn('➕ إنشاء بوت جديد', 'new', 'success')],
        [btn('🔙 رجوع', 'menu')],
      ]);
    }
    const kb = mine.map((x) => [btn(`🤖 @${x.username}`, `b:${x.id}`, 'primary')]);
    kb.push([btn('🔙 رجوع', 'menu')]);
    return show(ctx, '🤖 <b>بوتاتك</b>\nاختر بوتًا لإدارته:', kb);
  }

  // كل ما يلي يتعلق ببوت معيّن
  if (['b', 'msg', 'btns', 'badd', 'bdel', 'prev', 'del', 'delok'].includes(act)) {
    const bot = ownedBot(uid, a);
    if (!bot) return show(ctx, '❌ البوت غير موجود.', [[btn('🔙 رجوع', 'list')]]);

    if (act === 'b') {
      u.state = null;
      store.save();
      return showPanel(ctx, bot);
    }
    if (act === 'msg') {
      u.state = { step: 'message', botId: bot.id };
      store.save();
      return show(ctx, '📝 أرسل الآن الرسالة التي تريدها (تُحفظ كما هي بالتنسيق والروابط).', [
        [btn('إلغاء', `b:${bot.id}`)],
      ]);
    }
    if (act === 'btns') {
      u.state = null;
      store.save();
      const p = buttonsPanel(bot);
      return show(ctx, p.text, p.kb);
    }
    if (act === 'badd') {
      if (bot.buttons.length >= MAX_BUTTONS) return;
      u.state = { step: 'btn_text', botId: bot.id };
      store.save();
      return show(ctx, '✏️ أرسل <b>نص الزر</b> (حتى 40 حرفًا).', [[btn('إلغاء', `btns:${bot.id}`)]]);
    }
    if (act === 'bdel') {
      const i = Number(b);
      if (Number.isInteger(i) && bot.buttons[i]) bot.buttons.splice(i, 1);
      store.save();
      const p = buttonsPanel(bot);
      return show(ctx, p.text, p.kb);
    }
    if (act === 'prev') {
      if (!bot.message) {
        return tg.call(main(), 'answerCallbackQuery', {
          callback_query_id: q.id,
          text: 'حدّد الرسالة أولًا',
          show_alert: true,
        });
      }
      await sendStored(main(), ctx.chatId, bot);
      return;
    }
    if (act === 'del') {
      return show(ctx, `⚠️ هل تريد حذف <b>@${esc(bot.username)}</b> نهائيًا؟`, [
        [btn('✅ نعم، احذف', `delok:${bot.id}`, 'danger'), btn('إلغاء', `b:${bot.id}`)],
      ]);
    }
    if (act === 'delok') {
      try {
        await tg.call(decrypt(bot.tokenEnc), 'deleteWebhook', { drop_pending_updates: true });
      } catch (_) {}
      delete store.db.bots[bot.id];
      store.save();
      return show(ctx, '🗑 تم حذف البوت.', [[btn('🔙 رجوع', 'list')]]);
    }
  }

  // اختيار لون زر جديد
  if (act === 'col') {
    const st = u.state;
    if (!st || st.step !== 'btn_color' || !COLORS[a]) return;
    const bot = ownedBot(uid, st.botId);
    if (!bot) return;
    if (bot.buttons.length < MAX_BUTTONS) {
      bot.buttons.push({ text: st.text, url: st.url, style: a });
    }
    u.state = null;
    store.save();
    const p = buttonsPanel(bot);
    return show(ctx, `✅ تمت إضافة الزر.\n\n${p.text}`, p.kb);
  }
}

async function handle(update) {
  if (update.message && update.message.chat && update.message.chat.type === 'private') {
    const msg = update.message;
    return onMessage({ msg, uid: msg.from.id, chatId: msg.chat.id });
  }
  if (update.callback_query) {
    const q = update.callback_query;
    tg.call(main(), 'answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    if (!q.message) return;
    return onCallback({ q, uid: q.from.id, chatId: q.message.chat.id });
  }
}

module.exports = { handle };
