'use strict';
// بوت الصانع الرئيسي: إنشاء وإدارة البوتات (صفحات، أزرار، أوامر، بث، إحصائيات،
// اشتراك إجباري، تواصل، إضافة تلقائية، إحالات، نجوم تيليجرام، لوحة أدمن)
const tg = require('./telegram');
const store = require('./store');
const { encrypt, decrypt, secretFor } = require('./crypto');
const R = require('./render');
const { COLORS, BTN_TYPES, styled, extractMessage, sendPage } = R;

/* ------------------------------------------------------------------ */
/*  الإعدادات                                                          */
/* ------------------------------------------------------------------ */
const BASE_BOTS = Number(process.env.MAX_BOTS_PER_USER || 10); // الحد الأساسي لكل مستخدم
const BOTS_CAP = 100; // سقف مطلق
const REF_SLOTS = Number(process.env.REF_SLOTS || 1); // مساحات إضافية لكل إحالة
const MAX_BUTTONS = 12; // أزرار لكل صفحة
const MAX_PAGES = 30; // صفحات لكل بوت
const MAX_FORCE = 5; // قنوات الاشتراك الإجباري
const BC_BUDGET = Number(process.env.BC_BUDGET_MS || 8000); // ميزانية وقت البث في كل مرة
const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
const CMD_RE = /^[a-z0-9_]{2,32}$/;
const PACKS = [
  { slots: 1, stars: Number(process.env.STARS_1 || 25) },
  { slots: 3, stars: Number(process.env.STARS_3 || 60) },
  { slots: 10, stars: Number(process.env.STARS_10 || 180) },
];

const main = () => process.env.MAIN_BOT_TOKEN;
const baseUrl = () =>
  String(process.env.BASE_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`).replace(/\/+$/, '');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const btn = (text, data, style) => styled({ text, callback_data: data }, style);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAdmin = (uid) =>
  String(process.env.ADMIN_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(String(uid));

async function mainMe() {
  if (!global._makerMe) global._makerMe = await tg.call(main(), 'getMe');
  return global._makerMe;
}

/* ------------------------------------------------------------------ */
/*  أدوات الإرسال                                                      */
/* ------------------------------------------------------------------ */
function send(chatId, text, kb, extra) {
  const p = Object.assign(
    { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
    extra || {}
  );
  if (kb) p.reply_markup = { inline_keyboard: kb };
  return tg.call(main(), 'sendMessage', p);
}

async function show(ctx, text, kb) {
  // إن جاء من زر: عدّل الرسالة، وإلا أرسل رسالة جديدة
  if (ctx.q && ctx.q.message && ctx.q.message.text !== undefined) {
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

const alert = (ctx, text) => {
  ctx.acked = true;
  return tg.call(main(), 'answerCallbackQuery', { callback_query_id: ctx.q.id, text, show_alert: true }).catch(() => {});
};

async function setState(uid, u, state) {
  u.state = state;
  await store.saveUser(uid, u);
}

/* ------------------------------------------------------------------ */
/*  النصوص والقوائم الرئيسية                                            */
/* ------------------------------------------------------------------ */
function mainMenu() {
  return [
    [btn('➕ إضافة بوت (بالتوكن)', 'new', 'success'), btn('➕ إضافة بوت (تلقائيًا)', 'auto', 'success')],
    [btn('🤖 قائمة البوتات', 'list', 'primary')],
    [btn('⭐ شراء مساحة بوتات', 'shop'), btn('👥 نظام الإحالة', 'ref')],
    [btn('🎩 طلب الإعلان', 'ads'), btn('📞 جهات الاتصال', 'contact')],
    [btn('❓ مساعدة', 'help')],
  ];
}

const WELCOME =
  '👋 أهلًا بك في <b>صانع البوتات</b>\n\n' +
  'أنشئ بوت قوائم احترافي في دقيقة: صفحات متعددة، أزرار بالألوان، وسائط، أوامر مخصصة، بث للمشتركين، ' +
  'اشتراك إجباري، وإحصائيات.\n\nاضغط «إدارة البوتات» للبدء 👇';

const HELP =
  '<b>طريقة الاستخدام</b>\n\n' +
  '1️⃣ أضف بوتك: <b>تلقائيًا</b> بضغطة واحدة، أو بالتوكن من @BotFather.\n' +
  '2️⃣ أرسل رسالة الصفحة الرئيسية (نص أو صورة أو فيديو بنفس التنسيق).\n' +
  '3️⃣ أضف أزرارًا: رابط، صفحة داخلية، نسخ نص، أو تطبيق مصغّر.\n' +
  '4️⃣ أنشئ صفحات وأوامر مخصصة (مثل /prices).\n' +
  '5️⃣ فعّل الاشتراك الإجباري أو وضع التواصل من «الإعدادات».\n' +
  '6️⃣ أرسل بثًا لمشتركي بوتك من «بث رسالة».\n\n' +
  '<b>المتغيّرات داخل النص:</b>\n' +
  '<code>{name}</code> الاسم الكامل • <code>{first_name}</code> الاسم الأول • ' +
  '<code>{username}</code> المعرّف • <code>{id}</code> الآيدي • <code>{bot}</code> معرّف البوت\n\n' +
  '🔒 التوكنات تُخزَّن مشفّرة.';

/* ------------------------------------------------------------------ */
/*  الحدود والإحالات                                                    */
/* ------------------------------------------------------------------ */
async function botLimit(uid, u) {
  const refs = await store.refCount(uid);
  return Math.min(BOTS_CAP, BASE_BOTS + (u.extraSlots || 0) + refs * REF_SLOTS);
}

async function ownedBot(uid, id) {
  const b = await store.getBot(id);
  return b && b.owner === String(uid) ? b : null;
}

/* ------------------------------------------------------------------ */
/*  واجهات البوت                                                       */
/* ------------------------------------------------------------------ */
async function botPanel(bot) {
  const s = await store.subStats(bot.id);
  const text =
    `🤖 <b>${esc(bot.name)}</b> (@${esc(bot.username)})\n\n` +
    `📄 الصفحات: ${Object.keys(bot.pages).length}\n` +
    `👥 المشتركون: ${s.active}${s.blocked ? ` (حاظرون: ${s.blocked})` : ''}\n` +
    `📝 الرئيسية: ${bot.pages.main.message ? '✅ محفوظة' : '❌ غير محددة'}\n\n` +
    'اكتب <code>/start</code> في البوت لعرض الصفحة الرئيسية.\n' +
    '💡 اكتب <code>/admin</code> داخل بوتك لإدارته من هناك (محرر الأزرار والمحتوى والبث).';
  const kb = [
    [btn('📄 الصفحات والقوائم', `pgs:${bot.id}`, 'primary')],
    [btn('⌨️ الأوامر', `cmds:${bot.id}`), btn('⚙️ الإعدادات', `set:${bot.id}`)],
    [btn('📢 بث رسالة', `bc:${bot.id}`, 'success'), btn('📊 الإحصائيات', `st:${bot.id}`)],
    [btn('🔑 تغيير التوكن', `rtok:${bot.id}`), btn('🗑 حذف البوت', `del:${bot.id}`, 'danger')],
    [btn('🔙 رجوع', 'list')],
  ];
  return { text, kb };
}

async function showPanel(ctx, bot) {
  const p = await botPanel(bot);
  await show(ctx, p.text, p.kb);
}

function pagesPanel(bot) {
  const kb = Object.values(bot.pages).map((p) => [
    btn(`${p.id === 'main' ? '🏠' : '📄'} ${p.title}  •  ${R.pageSummary(p)}`, `pg:${bot.id}:${p.id}`, p.id === 'main' ? 'primary' : undefined),
  ]);
  if (Object.keys(bot.pages).length < MAX_PAGES) kb.push([btn('➕ صفحة جديدة', `padd:${bot.id}`, 'success')]);
  kb.push([btn('🔙 رجوع', `b:${bot.id}`)]);
  return {
    text: '📄 <b>الصفحات والقوائم</b>\n\nكل صفحة لها رسالة وأزرار. اربط الصفحات ببعضها بزر من نوع «صفحة داخل البوت».',
    kb,
  };
}

function pagePanel(bot, page) {
  const cmds = Object.entries(bot.commands)
    .filter(([, pid]) => pid === page.id)
    .map(([c]) => '/' + c);
  const text =
    `${page.id === 'main' ? '🏠' : '📄'} <b>${esc(page.title)}</b>\n\n` +
    `${R.pageSummary(page)}\n` +
    `⌨️ الأوامر: ${cmds.length ? cmds.join(' ') : 'لا يوجد'}`;
  const kb = [
    [btn('📝 تعديل الرسالة', `pmsg:${bot.id}:${page.id}`, 'primary')],
    [btn('🔘 الأزرار', `pbt:${bot.id}:${page.id}`, 'primary'), btn('👁 معاينة', `pprev:${bot.id}:${page.id}`, 'success')],
    [btn('✏️ تغيير الاسم', `pren:${bot.id}:${page.id}`), btn('⌨️ ربط بأمر', `cpg:${bot.id}:${page.id}`)],
  ];
  if (page.id !== 'main') kb.push([btn('🗑 حذف الصفحة', `pdel:${bot.id}:${page.id}`, 'danger')]);
  kb.push([btn('🔙 رجوع', `pgs:${bot.id}`)]);
  return { text, kb };
}

const typeIcon = (t) => ({ url: '🔗', page: '📄', copy: '📋', webapp: '🌐' }[t || 'url']);

function buttonsPanel(bot, page) {
  const lines = page.buttons.length
    ? page.buttons
        .map((b, i) => `${i + 1}. ${typeIcon(b.type)} ${COLORS[b.style || 'default'].slice(0, 2)} ${esc(b.text)}${b.newRow === false ? ' ↔️' : ''}`)
        .join('\n')
    : 'لا توجد أزرار بعد.';
  const kb = [];
  if (page.buttons.length < MAX_BUTTONS) kb.push([btn('➕ إضافة زر', `pbadd:${bot.id}:${page.id}`, 'success')]);
  page.buttons.forEach((b, i) => kb.push([btn(`${i + 1}. ${b.text}`, `pbd:${bot.id}:${page.id}:${i}`)]));
  kb.push([btn('🔙 رجوع', `pg:${bot.id}:${page.id}`)]);
  return {
    text: `🔘 <b>أزرار «${esc(page.title)}»</b> (${page.buttons.length}/${MAX_BUTTONS})\n\n${lines}\n\n↔️ = في نفس صف الزر السابق`,
    kb,
  };
}

function buttonDetail(bot, page, i) {
  const b = page.buttons[i];
  let target = '';
  if (b.type === 'page') target = `→ ${esc((bot.pages[b.page] || { title: '⚠️ محذوفة' }).title)}`;
  else if (b.type === 'copy') target = `📋 ${esc(String(b.value).slice(0, 60))}`;
  else target = esc(b.url || '');
  const base = `pbd:${bot.id}:${page.id}:${i}`;
  const id = `${bot.id}:${page.id}:${i}`;
  return {
    text: `🔘 <b>${esc(b.text)}</b>\nالنوع: ${BTN_TYPES[b.type || 'url']}\n${target}\nاللون: ${COLORS[b.style || 'default']}\nالصف: ${b.newRow === false ? 'مع السابق ↔️' : 'صف مستقل'}`,
    kb: [
      [btn('⬆️', `pbmv:${id}:u`), btn('⬇️', `pbmv:${id}:d`), btn(b.newRow === false ? '↕️ صف مستقل' : '↔️ مع السابق', `pbrow:${id}`)],
      [btn('🎨 تغيير اللون', `pbcol:${id}`)],
      [btn('🗑 حذف الزر', `pbdel:${id}`, 'danger')],
      [btn('🔙 رجوع', `pbt:${bot.id}:${page.id}`)],
    ],
    base,
  };
}

function settingsPanel(bot) {
  const s = bot.settings;
  const on = (v) => (v ? '✅' : '❌');
  return {
    text:
      `⚙️ <b>إعدادات @${esc(bot.username)}</b>\n\n` +
      `📨 وضع التواصل: ${on(s.feedback)} — رسائل المستخدمين تصلك هنا ويمكنك الرد عليها\n` +
      `🔒 منع إعادة التوجيه والحفظ: ${on(s.protect)}\n` +
      `📢 الاشتراك الإجباري: ${(s.forceSub || []).length ? `${s.forceSub.length} قناة` : '❌'}`,
    kb: [
      [btn(`${on(s.feedback)} وضع التواصل`, `tg:${bot.id}:feedback`)],
      [btn(`${on(s.protect)} منع الحفظ والتوجيه`, `tg:${bot.id}:protect`)],
      [btn('📢 الاشتراك الإجباري', `fs:${bot.id}`, 'primary')],
      [btn('🔙 رجوع', `b:${bot.id}`)],
    ],
  };
}

function forcePanel(bot) {
  const list = bot.settings.forceSub || [];
  const lines = list.length ? list.map((c, i) => `${i + 1}. ${esc(c.title || c.chat)}`).join('\n') : 'لا توجد قنوات.';
  const kb = [];
  if (list.length < MAX_FORCE) kb.push([btn('➕ إضافة قناة', `fsadd:${bot.id}`, 'success')]);
  list.forEach((c, i) => kb.push([btn(`🗑 ${c.title || c.chat}`, `fsdel:${bot.id}:${i}`, 'danger')]));
  kb.push([btn('🔙 رجوع', `set:${bot.id}`)]);
  return {
    text:
      `📢 <b>الاشتراك الإجباري</b>\n\n${lines}\n\n` +
      'يجب أن يكون <b>بوتك مشرفًا</b> في القناة ليتمكن من فحص الاشتراك.',
    kb,
  };
}

function commandsPanel(bot) {
  const entries = Object.entries(bot.commands);
  const lines = entries.map(([c, pid]) => `/${c} ← ${esc((bot.pages[pid] || { title: '⚠️' }).title)}`).join('\n');
  const kb = [[btn('➕ أمر جديد', `cadd:${bot.id}`, 'success')]];
  entries.forEach(([c], i) => {
    if (c !== 'start') kb.push([btn(`🗑 /${c}`, `cdel:${bot.id}:${i}`, 'danger')]);
  });
  kb.push([btn('🔙 رجوع', `b:${bot.id}`)]);
  return { text: `⌨️ <b>الأوامر</b>\n\n${lines}`, kb };
}

async function statsPanel(bot) {
  const [s, c] = await Promise.all([store.subStats(bot.id), store.getStats(bot.id)]);
  return {
    text:
      `📊 <b>إحصائيات @${esc(bot.username)}</b>\n\n` +
      `👥 المشتركون: ${s.total} (نشطون ${s.active} • حاظرون ${s.blocked})\n` +
      `🆕 جدد خلال 24 ساعة: ${s.today}\n` +
      `📅 جدد خلال 7 أيام: ${s.week}\n\n` +
      `👁 مشاهدات الصفحات: ${c.views || 0}\n` +
      `👆 ضغطات الأزرار: ${c.clicks || 0}\n` +
      `📩 رسائل التواصل: ${c.feedback || 0}`,
    kb: [[btn('🔄 تحديث', `st:${bot.id}`)], [btn('🔙 رجوع', `b:${bot.id}`)]],
  };
}

/* ------------------------------------------------------------------ */
/*  أدوات مساعدة                                                       */
/* ------------------------------------------------------------------ */
const CHILD_UPDATES = ['message', 'callback_query', 'my_chat_member']; // يجب أن تطابق /setup?resync=1 في index.js
const ADS_DEFAULT = '🎩 للإعلان في البوتات تواصل مع الإدارة.';
const CONTACT_DEFAULT = '📞 للتواصل مع الإدارة راسل الأدمن مباشرة.';

const pageOf = (bot, id) => (id && Object.prototype.hasOwnProperty.call(bot.pages, id) ? bot.pages[id] : null);
const isBlocked = (e) => /blocked|deactivated|kicked|chat not found/i.test((e && e.message) || '');
const userFrom = (ctx) => (ctx.q ? ctx.q.from : ctx.msg.from);

function ack(ctx) {
  if (!ctx.q || ctx.acked) return;
  ctx.acked = true;
  tg.call(main(), 'answerCallbackQuery', { callback_query_id: ctx.q.id }).catch(() => {});
}

const ask = (ctx, text, back) => show(ctx, text, [[btn('إلغاء', back)]]);

const colorKb = (mk, back) => {
  const kb = [
    [btn(COLORS.primary, mk('primary'), 'primary'), btn(COLORS.success, mk('success'), 'success')],
    [btn(COLORS.danger, mk('danger'), 'danger'), btn(COLORS.default, mk('default'))],
  ];
  if (back) kb.push([btn('🔙 رجوع', back)]);
  return kb;
};

async function linkChild(token, id) {
  await tg.call(token, 'setWebhook', {
    url: `${baseUrl()}/webhook/child/${id}`,
    secret_token: secretFor(`child:${id}`),
    allowed_updates: CHILD_UPDATES,
    drop_pending_updates: true,
  });
}

// يحدّث قائمة أوامر البوت الابن (زر القائمة في تيليجرام)
async function syncCommands(bot) {
  try {
    const commands = Object.keys(bot.commands)
      .filter((c) => CMD_RE.test(c))
      .slice(0, 100)
      .map((c) => ({ command: c, description: String((bot.pages[bot.commands[c]] || {}).title || c).slice(0, 64) }));
    await tg.call(decrypt(bot.tokenEnc), 'setMyCommands', { commands });
  } catch (_) {}
}

// تسجيل بوت (من توكن أو من البوتات المُدارة). يعيد { bot, isNew } أو { error }
async function registerBot(uid, token, me) {
  const id = String(me.id);
  const existing = await store.getBot(id);
  if (existing && existing.owner !== String(uid)) return { error: '❌ هذا البوت مسجّل لدى مستخدم آخر.' };
  if (!existing) {
    const u = await store.getUser(uid);
    const lim = await botLimit(uid, u);
    const count = (await store.botsOf(uid)).length;
    if (count >= lim) {
      return { error: `❌ وصلت للحد الأقصى (${lim} بوتات). زِد الحد من «شراء مساحة بوتات» أو «نظام الإحالة».` };
    }
  }
  try {
    await linkChild(token, id);
  } catch (e) {
    return { error: `❌ فشل ربط البوت: ${esc(e.message)}` };
  }
  const bot = store.normalizeBot(
    existing || { id, owner: String(uid), pages: { main: store.newPage('main', 'الرئيسية') }, createdAt: Date.now() }
  );
  bot.username = me.username;
  bot.name = me.first_name || me.username;
  bot.tokenEnc = encrypt(token);
  await store.saveBot(bot);
  await syncCommands(bot);
  return { bot, isNew: !existing };
}

/* ------------------------------------------------------------------ */
/*  البث (يعمل على دفعات ضمن ميزانية وقت)                                */
/* ------------------------------------------------------------------ */
async function runBroadcast(job, nextPage, sendOne, onBlocked, batchSize) {
  const t0 = Date.now();
  while (Date.now() - t0 < BC_BUDGET) {
    const rows = await nextPage(job.cursor, batchSize());
    if (!rows.length) return true;
    const res = await Promise.allSettled(rows.map((r) => sendOne(r)));
    res.forEach((x, i) => {
      if (x.status === 'fulfilled') job.sent++;
      else {
        job.failed++;
        if (isBlocked(x.reason)) {
          job.blocked++;
          if (onBlocked) Promise.resolve(onBlocked(rows[i])).catch(() => {});
        }
      }
    });
    job.cursor = rows[rows.length - 1].cursor;
    await sleep(700);
  }
  return false;
}

const bcReport = (job) => `✅ أُرسل: ${job.sent}\n🚫 حاظرون/فشل: ${job.failed} (منهم حاظرون ${job.blocked})`;

/* ------------------------------------------------------------------ */
/*  لوحات إضافية                                                       */
/* ------------------------------------------------------------------ */
async function adminPanel() {
  const c = await store.counts();
  return {
    text: `🛠 <b>لوحة الأدمن</b>\n\n👥 المستخدمون: ${c.users}\n🤖 البوتات: ${c.bots}\n📬 المشتركون: ${c.subs}`,
    kb: [
      [btn('📢 بث لكل المستخدمين', 'admbc', 'success')],
      [btn('🎩 نص الإعلان', 'admads'), btn('📞 نص جهات الاتصال', 'admct')],
      [btn('🔙 رجوع', 'menu')],
    ],
  };
}

async function shopPanel(uid) {
  const u = await store.getUser(uid);
  const lim = await botLimit(uid, u);
  const kb = PACKS.map((p, i) => [btn(`${p.slots} مساحة — ${p.stars} ⭐`, `buy:${i}`, 'primary')]);
  kb.push([btn('🔙 رجوع', 'menu')]);
  return {
    text:
      `⭐ <b>شراء مساحة بوتات</b>\n\nحدّك الحالي: <b>${lim}</b> بوتًا (الحد الأقصى ${BOTS_CAP}).\n` +
      'كل مساحة تتيح لك إضافة بوت جديد. الدفع بنجوم تيليجرام.',
    kb,
  };
}

function parseChannel(msg) {
  const fo = msg.forward_origin;
  if (fo && fo.type === 'channel' && fo.chat) return fo.chat.id;
  if (msg.forward_from_chat && msg.forward_from_chat.type === 'channel') return msg.forward_from_chat.id;
  const t = (msg.text || '').trim();
  const m = t.match(/^(?:https?:\/\/)?t\.me\/([A-Za-z][A-Za-z0-9_]{3,})\/?$/i);
  if (m) return '@' + m[1];
  if (/^@[A-Za-z][A-Za-z0-9_]{3,}$/.test(t)) return t;
  if (/^-100\d{5,}$/.test(t)) return t;
  return null;
}

/* ------------------------------------------------------------------ */
/*  إنشاء بوت                                                          */
/* ------------------------------------------------------------------ */
async function createFromToken(ctx, token) {
  const { uid, chatId } = ctx;
  const cancel = [[btn('إلغاء', 'menu')]];
  if (!TOKEN_RE.test(token)) {
    return send(chatId, '❌ التوكن غير صالح. تأكد من نسخه كاملًا من @BotFather وأعد إرساله.', cancel);
  }
  tg.call(main(), 'deleteMessage', { chat_id: chatId, message_id: ctx.msg.message_id }).catch(() => {});
  let me;
  try {
    me = await tg.call(token, 'getMe');
  } catch (_) {
    return send(chatId, '❌ تعذّر التحقق من التوكن. تأكد أنه صحيح وغير ملغى.', cancel);
  }
  const r = await registerBot(uid, token, me);
  if (r.error) return send(chatId, r.error, [[btn('🔙 القائمة', 'menu')]]);
  const u = await store.getUser(uid);
  await setState(uid, u, { step: 'pmsg', botId: r.bot.id, pageId: 'main', create: true });
  return send(
    chatId,
    `✅ تم ربط <b>@${esc(me.username)}</b> بنجاح!\n\nأرسل الآن <b>رسالة الصفحة الرئيسية</b> (نص أو صورة أو فيديو…) التي تظهر عند <code>/start</code>. تُحفظ بنفس التنسيق والروابط.`,
    [[btn('تخطي الآن', `b:${r.bot.id}`)]]
  );
}

async function changeToken(ctx, u, st, token) {
  const { uid, chatId } = ctx;
  const back = [[btn('🔙 رجوع', `b:${st.botId}`)]];
  const bot = await ownedBot(uid, st.botId);
  if (!bot) return send(chatId, '❌ البوت غير موجود.', [[btn('🔙 رجوع', 'list')]]);
  if (!TOKEN_RE.test(token)) return send(chatId, '❌ التوكن غير صالح. أعد المحاولة.', back);
  tg.call(main(), 'deleteMessage', { chat_id: chatId, message_id: ctx.msg.message_id }).catch(() => {});
  let me;
  try {
    me = await tg.call(token, 'getMe');
  } catch (_) {
    return send(chatId, '❌ تعذّر التحقق من التوكن.', back);
  }
  if (String(me.id) !== bot.id) return send(chatId, '❌ هذا التوكن يخص بوتًا آخر.', back);
  try {
    await linkChild(token, bot.id);
  } catch (e) {
    return send(chatId, `❌ فشل ربط البوت: ${esc(e.message)}`, back);
  }
  bot.tokenEnc = encrypt(token);
  await store.saveBot(bot);
  await setState(uid, u, null);
  await send(chatId, '✅ تم تحديث التوكن.');
  const p = await botPanel(bot);
  return send(chatId, p.text, p.kb);
}

// تحديث من تيليجرام: تم إنشاء بوت عبر رابط «الإضافة التلقائية» (managed_bot)
async function onManagedBot(mb) {
  const creator = mb.user;
  const bu = mb.bot || mb.bot_user;
  if (!creator || !bu) return;
  const uid = creator.id;
  const notify = (t, kb) => send(uid, t, kb).catch(() => {});
  let token;
  try {
    token = String(await tg.call(main(), 'getManagedBotToken', { user_id: bu.id }));
  } catch (e) {
    return notify(`❌ تعذّر جلب توكن البوت الجديد: ${esc(e.message)}`);
  }
  let me = bu;
  if (!me.username) me = await tg.call(token, 'getMe').catch(() => bu);
  const r = await registerBot(uid, token, me);
  if (r.error) return notify(r.error);
  if (!r.isNew) return notify(`✅ تم تحديث بيانات <b>@${esc(r.bot.username)}</b>.`);
  const u = await store.getUser(uid);
  await setState(uid, u, { step: 'pmsg', botId: r.bot.id, pageId: 'main', create: true });
  return notify(
    `✅ تم إنشاء وربط <b>@${esc(r.bot.username)}</b>!\n\nأرسل الآن <b>رسالة الصفحة الرئيسية</b> التي تظهر عند <code>/start</code>.`,
    [[btn('تخطي الآن', `b:${r.bot.id}`)]]
  );
}

/* ------------------------------------------------------------------ */
/*  الدفع بالنجوم                                                      */
/* ------------------------------------------------------------------ */
async function onPreCheckout(q) {
  const m = String(q.invoice_payload || '').match(/^slots:(\d+):(\d+)$/);
  const ok = !!m && m[2] === String(q.from.id) && PACKS.some((p) => p.slots === Number(m[1]));
  const p = { pre_checkout_query_id: q.id, ok };
  if (!ok) p.error_message = 'طلب غير صالح';
  await tg.call(main(), 'answerPreCheckoutQuery', p);
}

async function onPayment(ctx, u) {
  const pay = ctx.msg.successful_payment;
  const m = String(pay.invoice_payload || '').match(/^slots:(\d+):(\d+)$/);
  if (!m || m[2] !== String(ctx.uid)) return;
  const n = Number(m[1]);
  if (!PACKS.some((p) => p.slots === n)) return;
  const charges = u.charges || [];
  if (charges.includes(pay.telegram_payment_charge_id)) return; // منع التكرار
  u.extraSlots = (u.extraSlots || 0) + n;
  u.charges = charges.slice(-19).concat(pay.telegram_payment_charge_id);
  await store.saveUser(ctx.uid, u);
  return send(ctx.chatId, `✅ تم الدفع! أُضيفت <b>${n}</b> مساحة بوتات إلى حسابك.`, mainMenu());
}

/* ------------------------------------------------------------------ */
/*  الرسائل                                                            */
/* ------------------------------------------------------------------ */
async function onMessage(ctx) {
  const { msg, uid, chatId } = ctx;
  const text = msg.text || '';
  const u = await store.getUser(uid);

  if (msg.successful_payment) return onPayment(ctx, u);

  const cm = text.match(/^\/(start|menu|cancel|admin|stats)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (cm) {
    const cmd = cm[1].toLowerCase();
    if (cmd === 'admin' || cmd === 'stats') {
      if (!isAdmin(uid)) return;
      const p = await adminPanel();
      return send(chatId, p.text, p.kb);
    }
    if (cmd === 'start' && !u.seen) {
      u.seen = true;
      const rm = (cm[2] || '').trim().match(/^ref_(\d+)$/);
      // نحتسب الإحالة للمستخدمين الجدد فقط
      if (rm && Date.now() - (u.createdAt || 0) < 3600 * 1000) {
        const ok = await store.addRef(rm[1], uid).catch(() => false);
        if (ok) send(rm[1], '🎉 انضم مستخدم جديد عبر رابط إحالتك وزاد حدّ بوتاتك!').catch(() => {});
      }
    }
    u.state = null;
    await store.saveUser(uid, u);
    return send(chatId, WELCOME, mainMenu());
  }

  const st = u.state;
  if (!st) return send(chatId, 'اختر من القائمة 👇', mainMenu());

  const fail = async (t) => {
    await setState(uid, u, null);
    return send(chatId, t, [[btn('🔙 القائمة', 'menu')]]);
  };

  switch (st.step) {
    case 'token':
      return createFromToken(ctx, text.trim());
    case 'rtok':
      return changeToken(ctx, u, st, text.trim());

    case 'adm_bc': {
      if (!isAdmin(uid)) return;
      u.abc = { chat: chatId, mid: msg.message_id, cursor: null, sent: 0, failed: 0, blocked: 0 };
      u.state = null;
      await store.saveUser(uid, u);
      return send(chatId, '👆 هذه الرسالة ستُرسل لكل مستخدمي الصانع. تأكيد؟', [
        [btn('✅ بدء البث', 'admgo', 'success'), btn('إلغاء', 'adm')],
      ]);
    }
    case 'adm_ads':
    case 'adm_ct': {
      if (!isAdmin(uid)) return;
      if (!text || text.length > 3000) return send(chatId, '⚠️ أرسل نصًا (حتى 3000 حرف).');
      await store.setSetting(st.step === 'adm_ads' ? 'adsText' : 'contactText', text);
      await setState(uid, u, null);
      return send(chatId, '✅ تم الحفظ.', [[btn('🔙 لوحة الأدمن', 'adm')]]);
    }
  }

  // كل ما يلي يخص بوتًا معيّنًا
  const bot = await ownedBot(uid, st.botId);
  if (!bot) return fail('❌ البوت غير موجود.');
  const page = pageOf(bot, st.pageId);

  switch (st.step) {
    case 'pmsg': {
      if (!page) return fail('❌ الصفحة غير موجودة.');
      const ex = extractMessage(msg);
      if (ex.error) return send(chatId, ex.error);
      page.message = ex.ok;
      await store.saveBot(bot);
      await setState(uid, u, null);
      await send(chatId, '✅ تم حفظ الرسالة.');
      if (st.create) {
        const p = await botPanel(bot);
        return send(chatId, p.text, p.kb);
      }
      const p = pagePanel(bot, page);
      return send(chatId, p.text, p.kb);
    }

    case 'ptitle': {
      const title = text.trim();
      if (!title || title.length > 30) return send(chatId, '⚠️ أرسل اسمًا للصفحة (حتى 30 حرفًا).');
      if (Object.keys(bot.pages).length >= MAX_PAGES) return fail('❌ وصلت للحد الأقصى للصفحات.');
      const id = store.rid('p');
      bot.pages[id] = store.newPage(id, title);
      await store.saveBot(bot);
      await setState(uid, u, null);
      const p = pagePanel(bot, bot.pages[id]);
      return send(chatId, `✅ تم إنشاء الصفحة.\n\n${p.text}`, p.kb);
    }

    case 'prename': {
      if (!page) return fail('❌ الصفحة غير موجودة.');
      const title = text.trim();
      if (!title || title.length > 30) return send(chatId, '⚠️ أرسل اسمًا (حتى 30 حرفًا).');
      page.title = title;
      await store.saveBot(bot);
      await setState(uid, u, null);
      await syncCommands(bot);
      const p = pagePanel(bot, page);
      return send(chatId, p.text, p.kb);
    }

    case 'cmd_name': {
      const name = text.trim().replace(/^\//, '').toLowerCase();
      if (!CMD_RE.test(name)) return send(chatId, '⚠️ اسم الأمر: حروف إنجليزية صغيرة وأرقام و _ فقط (من 2 إلى 32).');
      if (st.pageId) {
        if (!page) return fail('❌ الصفحة غير موجودة.');
        bot.commands[name] = page.id;
        await store.saveBot(bot);
        await setState(uid, u, null);
        await syncCommands(bot);
        const p = commandsPanel(bot);
        return send(chatId, `✅ تم ربط /${name}\n\n${p.text}`, p.kb);
      }
      st.step = 'cmd_page';
      st.name = name;
      await store.saveUser(uid, u);
      const kb = Object.values(bot.pages).map((p) => [btn(`${p.id === 'main' ? '🏠' : '📄'} ${p.title}`, `cpgs:${bot.id}:${p.id}`)]);
      kb.push([btn('إلغاء', `cmds:${bot.id}`)]);
      return send(chatId, `اختر الصفحة التي سيفتحها الأمر /${name}:`, kb);
    }

    case 'b_text': {
      if (!page) return fail('❌ الصفحة غير موجودة.');
      if (!msg.text || msg.text.length > 40) return send(chatId, '⚠️ أرسل نص الزر (حتى 40 حرفًا).');
      st.text = msg.text.trim();
      const back = `pbt:${bot.id}:${page.id}`;
      if (st.type === 'url' || st.type === 'webapp') {
        st.step = 'b_url';
        await store.saveUser(uid, u);
        return send(
          chatId,
          st.type === 'webapp'
            ? '🌐 أرسل رابط التطبيق المصغّر (يجب أن يبدأ بـ https://).'
            : '🔗 أرسل <b>رابط</b> الزر (https:// أو http:// أو tg://).',
          [[btn('إلغاء', back)]]
        );
      }
      if (st.type === 'copy') {
        st.step = 'b_copy';
        await store.saveUser(uid, u);
        return send(chatId, '📋 أرسل النص الذي سيُنسخ عند الضغط (حتى 256 حرفًا).', [[btn('إلغاء', back)]]);
      }
      st.step = 'b_pick';
      await store.saveUser(uid, u);
      const kb = Object.values(bot.pages).map((p) => [btn(`${p.id === 'main' ? '🏠' : '📄'} ${p.title}`, `pbpick:${p.id}`)]);
      kb.push([btn('إلغاء', back)]);
      return send(chatId, '📄 اختر الصفحة التي سيفتحها الزر:', kb);
    }

    case 'b_url': {
      const url = text.trim();
      const okUrl = st.type === 'webapp' ? R.isHttps(url) : R.isUrl(url);
      if (!okUrl) return send(chatId, st.type === 'webapp' ? '⚠️ الرابط يجب أن يبدأ بـ https://' : '⚠️ رابط غير صالح.');
      st.value = url;
      st.step = 'b_color';
      await store.saveUser(uid, u);
      return send(chatId, '🎨 اختر <b>لون الزر</b>:', colorKb((s) => `col:${s}`));
    }

    case 'b_copy': {
      if (!text || text.length > 256) return send(chatId, '⚠️ أرسل نصًا (حتى 256 حرفًا).');
      st.value = text;
      st.step = 'b_color';
      await store.saveUser(uid, u);
      return send(chatId, '🎨 اختر <b>لون الزر</b>:', colorKb((s) => `col:${s}`));
    }

    case 'fs_add': {
      const chat = parseChannel(msg);
      if (chat === null) return send(chatId, '⚠️ أرسل معرّف القناة (@name) أو رابطها أو حوّل رسالة منها.');
      if ((bot.settings.forceSub || []).length >= MAX_FORCE) return fail('❌ وصلت للحد الأقصى للقنوات.');
      const token = decrypt(bot.tokenEnc);
      try {
        const info = await tg.call(token, 'getChat', { chat_id: chat });
        const me = await tg.call(token, 'getChatMember', { chat_id: info.id, user_id: Number(bot.id) });
        if (me.status !== 'administrator' && me.status !== 'creator') throw new Error('not admin');
        const entry = { chat: info.username ? '@' + info.username : info.id, title: info.title || String(chat) };
        if (!info.username) {
          const link = await tg.call(token, 'exportChatInviteLink', { chat_id: info.id }).catch(() => null);
          if (link) entry.link = link;
        }
        const list = bot.settings.forceSub || [];
        if (list.some((c) => String(c.chat) === String(entry.chat))) return send(chatId, '⚠️ هذه القناة مضافة بالفعل.');
        list.push(entry);
        bot.settings.forceSub = list;
        await store.saveBot(bot);
        await setState(uid, u, null);
        const p = forcePanel(bot);
        return send(chatId, `✅ تمت إضافة القناة.\n\n${p.text}`, p.kb);
      } catch (_) {
        return send(chatId, '❌ لا يستطيع البوت الوصول للقناة. أضف بوتك <b>مشرفًا</b> في القناة ثم أعد الإرسال.', [
          [btn('إلغاء', `fs:${bot.id}`)],
        ]);
      }
    }

    case 'bc_msg': {
      const ex = extractMessage(msg);
      if (ex.error) return send(chatId, ex.error);
      const s = await store.subStats(bot.id);
      u.bc = { botId: bot.id, msg: ex.ok, cursor: null, sent: 0, failed: 0, blocked: 0 };
      u.state = null;
      await store.saveUser(uid, u);
      await send(chatId, '👇 معاينة البث:');
      await sendPage(main(), chatId, bot, { id: 'bc', title: 'بث', message: ex.ok, buttons: [] }, { preview: true, user: msg.from }).catch(
        () => {}
      );
      return send(chatId, `سيُرسل إلى <b>${s.active}</b> مشترك نشط في @${esc(bot.username)}. تأكيد؟`, [
        [btn('✅ بدء البث', `bcgo:${bot.id}`, 'success'), btn('إلغاء', `b:${bot.id}`)],
      ]);
    }

    case 'reply': {
      const ex = extractMessage(msg);
      if (ex.error) return send(chatId, ex.error);
      await setState(uid, u, null);
      try {
        await sendPage(decrypt(bot.tokenEnc), st.to, bot, { id: 'reply', title: 'رد', message: ex.ok, buttons: [] });
        return send(chatId, '✅ تم إرسال ردك للمستخدم.', [[btn('🔙 القائمة', 'menu')]]);
      } catch (_) {
        return send(chatId, '❌ تعذّر الإرسال (ربما حظر المستخدم البوت).', [[btn('🔙 القائمة', 'menu')]]);
      }
    }
  }

  return send(chatId, 'اختر من القائمة 👇', mainMenu());
}

/* ------------------------------------------------------------------ */
/*  الأزرار (Callbacks)                                                */
/* ------------------------------------------------------------------ */
const BOT_ACTS = new Set([
  'b', 'pgs', 'pg', 'padd', 'pmsg', 'pbt', 'pprev', 'pren', 'cpg', 'pdel', 'pdelok',
  'pbadd', 'pbtype', 'pbd', 'pbmv', 'pbrow', 'pbcol', 'pbcs', 'pbdel',
  'cmds', 'cadd', 'cdel', 'cpgs', 'set', 'tg', 'fs', 'fsadd', 'fsdel',
  'bc', 'bcgo', 'bcnext', 'st', 'rtok', 'del', 'delok', 'rp',
]);
const PAGE_ACTS = new Set([
  'pg', 'pmsg', 'pbt', 'pprev', 'pren', 'cpg', 'pdel', 'pdelok',
  'pbadd', 'pbtype', 'pbd', 'pbmv', 'pbrow', 'pbcol', 'pbcs', 'pbdel', 'cpgs',
]);

async function onCallback(ctx) {
  const { q, uid } = ctx;
  const parts = String(q.data || '').split(':');
  const act = parts[0];
  const u = await store.getUser(uid);

  if (BOT_ACTS.has(act)) {
    const bot = await ownedBot(uid, parts[1]);
    if (!bot) return show(ctx, '❌ البوت غير موجود.', [[btn('🔙 رجوع', 'list')]]);
    return onBotAction(ctx, u, bot, parts);
  }

  if (act.startsWith('adm') && !isAdmin(uid)) return;

  switch (act) {
    case 'noop':
      return;
    case 'menu':
      await setState(uid, u, null);
      return show(ctx, WELCOME, mainMenu());
    case 'help':
      return show(ctx, HELP, [[btn('🔙 رجوع', 'menu')]]);

    case 'new':
      await setState(uid, u, { step: 'token' });
      return ask(ctx, '🔑 أرسل الآن <b>توكن البوت</b> من @BotFather.\n\nسأحذف رسالتك فور التحقق منه لحمايته.', 'menu');

    case 'auto': {
      const lim = await botLimit(uid, u);
      const count = (await store.botsOf(uid)).length;
      if (count >= lim) {
        return show(ctx, `❌ وصلت للحد الأقصى (${lim} بوتات).`, [[btn('⭐ شراء مساحة', 'shop')], [btn('🔙 رجوع', 'menu')]]);
      }
      const me = await mainMe();
      const sug = `mk${Math.random().toString(36).slice(2, 10)}_bot`;
      const url = `https://t.me/newbot/${me.username}/${sug}?name=${encodeURIComponent('بوتي')}`;
      return show(
        ctx,
        '➕ <b>إضافة تلقائية</b>\n\nاضغط الزر، أكّد إنشاء البوت (يمكنك تغيير اسمه ومعرّفه)، وسيُربط بحسابك تلقائيًا دون نسخ توكن.',
        [[{ text: '🤖 إنشاء البوت الآن', url }], [btn('🔙 رجوع', 'menu')]]
      );
    }

    case 'list': {
      await setState(uid, u, null);
      const mine = await store.botsOf(uid);
      if (!mine.length) {
        return show(ctx, 'لا توجد لديك بوتات بعد.', [
          [btn('➕ إضافة بوت (بالتوكن)', 'new', 'success'), btn('➕ تلقائيًا', 'auto', 'success')],
          [btn('🔙 رجوع', 'menu')],
        ]);
      }
      const kb = mine.map((x) => [btn(`🤖 @${x.username}`, `b:${x.id}`, 'primary')]);
      kb.push([btn('🔙 رجوع', 'menu')]);
      return show(ctx, '🤖 <b>بوتاتك</b>\nاختر بوتًا لإدارته:', kb);
    }

    case 'shop': {
      const p = await shopPanel(uid);
      return show(ctx, p.text, p.kb);
    }
    case 'buy': {
      const p = PACKS[Number(parts[1])];
      if (!p) return;
      await tg.call(main(), 'sendInvoice', {
        chat_id: ctx.chatId,
        title: `${p.slots} مساحة بوتات`,
        description: `إضافة ${p.slots} مساحة لإنشاء بوتات جديدة`,
        payload: `slots:${p.slots}:${uid}`,
        currency: 'XTR',
        prices: [{ label: `${p.slots} مساحة`, amount: p.stars }],
      });
      return;
    }

    case 'ref': {
      const me = await mainMe();
      const n = await store.refCount(uid);
      const link = `https://t.me/${me.username}?start=ref_${uid}`;
      return show(
        ctx,
        `👥 <b>نظام الإحالة</b>\n\nكل مستخدم جديد يدخل عبر رابطك يمنحك <b>${REF_SLOTS}</b> مساحة بوت إضافية.\n\n🔗 رابطك:\n<code>${link}</code>\n\n✅ إحالاتك الناجحة: ${n}`,
        [
          [{ text: '📤 مشاركة الرابط', url: `https://t.me/share/url?url=${encodeURIComponent(link)}` }],
          [btn('🔙 رجوع', 'menu')],
        ]
      );
    }

    case 'ads':
    case 'contact': {
      const s = await store.getSettings();
      const t = act === 'ads' ? s.adsText || ADS_DEFAULT : s.contactText || CONTACT_DEFAULT;
      return show(ctx, esc(t), [[btn('🔙 رجوع', 'menu')]]);
    }

    case 'col': {
      const st = u.state;
      const style = parts[1];
      if (!st || st.step !== 'b_color' || !COLORS[style]) return;
      const bot = await ownedBot(uid, st.botId);
      const page = bot && pageOf(bot, st.pageId);
      if (!page) return;
      if (page.buttons.length < MAX_BUTTONS) {
        const b = { id: store.rid('b'), text: st.text, type: st.type, style, newRow: true };
        if (st.type === 'page') b.page = st.value;
        else if (st.type === 'copy') b.value = st.value;
        else b.url = st.value;
        page.buttons.push(b);
        await store.saveBot(bot);
      }
      await setState(uid, u, null);
      const p = buttonsPanel(bot, page);
      return show(ctx, `✅ تمت إضافة الزر.\n\n${p.text}`, p.kb);
    }

    case 'pbpick': {
      const st = u.state;
      if (!st || st.step !== 'b_pick') return;
      const bot = await ownedBot(uid, st.botId);
      if (!bot || !pageOf(bot, parts[1])) return;
      st.value = parts[1];
      st.step = 'b_color';
      await store.saveUser(uid, u);
      return show(ctx, '🎨 اختر <b>لون الزر</b>:', colorKb((s) => `col:${s}`));
    }

    /* ---- الأدمن ---- */
    case 'adm': {
      await setState(uid, u, null);
      const p = await adminPanel();
      return show(ctx, p.text, p.kb);
    }
    case 'admbc':
      await setState(uid, u, { step: 'adm_bc' });
      return ask(ctx, '📢 أرسل الرسالة التي تريد بثها لكل مستخدمي الصانع (أي نوع).', 'adm');
    case 'admads':
    case 'admct':
      await setState(uid, u, { step: act === 'admads' ? 'adm_ads' : 'adm_ct' });
      return ask(ctx, act === 'admads' ? '🎩 أرسل نص «طلب الإعلان» الجديد.' : '📞 أرسل نص «جهات الاتصال» الجديد.', 'adm');
    case 'admgo':
    case 'admnext': {
      ack(ctx);
      const job = u.abc;
      if (!job) return show(ctx, 'انتهت صلاحية هذا البث.', [[btn('🔙 لوحة الأدمن', 'adm')]]);
      const done = await runBroadcast(
        job,
        async (cur, n) => (await store.usersPage(cur, n)).map((r) => ({ cursor: r.id, uid: r.id, banned: r.banned })),
        (r) =>
          r.banned
            ? Promise.resolve()
            : tg.call(main(), 'copyMessage', { chat_id: r.uid, from_chat_id: job.chat, message_id: job.mid }),
        null,
        () => 25
      );
      if (done) u.abc = null;
      await store.saveUser(uid, u);
      return show(
        ctx,
        done ? `📢 <b>اكتمل البث</b>\n\n${bcReport(job)}` : `⏳ <b>البث جارٍ…</b>\n\n${bcReport(job)}`,
        done ? [[btn('🔙 لوحة الأدمن', 'adm')]] : [[btn('▶️ متابعة', 'admnext', 'success')]]
      );
    }
  }
}

async function onBotAction(ctx, u, bot, parts) {
  const { uid } = ctx;
  const act = parts[0];
  const pid = parts[2];
  const page = pageOf(bot, pid);
  const idx = Number(parts[3]);
  const save = () => store.saveBot(bot);
  const clear = () => setState(uid, u, null);

  if (PAGE_ACTS.has(act) && !page) {
    const p = pagesPanel(bot);
    return show(ctx, `⚠️ الصفحة غير موجودة.\n\n${p.text}`, p.kb);
  }
  const detail = (i) => {
    const d = buttonDetail(bot, page, i);
    return show(ctx, d.text, d.kb);
  };
  const buttonsView = async (prefix) => {
    const p = buttonsPanel(bot, page);
    return show(ctx, (prefix || '') + p.text, p.kb);
  };

  switch (act) {
    case 'b':
      await clear();
      return showPanel(ctx, bot);

    /* ---- الصفحات ---- */
    case 'pgs': {
      await clear();
      const p = pagesPanel(bot);
      return show(ctx, p.text, p.kb);
    }
    case 'pg': {
      await clear();
      const p = pagePanel(bot, page);
      return show(ctx, p.text, p.kb);
    }
    case 'padd':
      if (Object.keys(bot.pages).length >= MAX_PAGES) return alert(ctx, 'وصلت للحد الأقصى للصفحات.');
      await setState(uid, u, { step: 'ptitle', botId: bot.id });
      return ask(ctx, '✏️ أرسل <b>اسم الصفحة</b> الجديدة (حتى 30 حرفًا).', `pgs:${bot.id}`);
    case 'pmsg':
      await setState(uid, u, { step: 'pmsg', botId: bot.id, pageId: page.id });
      return ask(ctx, '📝 أرسل الآن رسالة الصفحة (نص أو صورة أو فيديو أو GIF أو ملف أو صوت). التنسيق والروابط تُحفظ كما هي.\n\nيمكنك استخدام المتغيّرات مثل <code>{name}</code>.', `pg:${bot.id}:${page.id}`);
    case 'pren':
      await setState(uid, u, { step: 'prename', botId: bot.id, pageId: page.id });
      return ask(ctx, '✏️ أرسل الاسم الجديد للصفحة.', `pg:${bot.id}:${page.id}`);
    case 'pprev': {
      if (!page.message && !(page.buttons || []).length) return alert(ctx, 'الصفحة فارغة. حدّد رسالتها أولًا.');
      ack(ctx);
      try {
        await sendPage(main(), ctx.chatId, bot, page, { preview: true, user: userFrom(ctx) });
      } catch (e) {
        await send(ctx.chatId, `❌ تعذّرت المعاينة: ${esc(e.message)}`);
      }
      return;
    }
    case 'pdel':
      if (page.id === 'main') return alert(ctx, 'لا يمكن حذف الصفحة الرئيسية.');
      return show(ctx, `⚠️ حذف الصفحة <b>${esc(page.title)}</b>؟ ستُحذف أوامرها والأزرار التي تشير إليها.`, [
        [btn('✅ نعم، احذف', `pdelok:${bot.id}:${page.id}`, 'danger'), btn('إلغاء', `pg:${bot.id}:${page.id}`)],
      ]);
    case 'pdelok': {
      if (page.id === 'main') return;
      delete bot.pages[page.id];
      bot.rkb = (bot.rkb || []).filter((b) => b.page !== page.id);
      Object.values(bot.pages).forEach((p) => {
        p.buttons = (p.buttons || []).filter((b) => !(b.type === 'page' && b.page === page.id));
      });
      Object.keys(bot.commands).forEach((c) => {
        if (bot.commands[c] !== page.id) return;
        if (c === 'start' || c === 'ms') bot.commands[c] = 'main';
        else delete bot.commands[c];
      });
      await save();
      await syncCommands(bot);
      const p = pagesPanel(bot);
      return show(ctx, `🗑 تم حذف الصفحة.\n\n${p.text}`, p.kb);
    }

    /* ---- الأوامر ---- */
    case 'cmds': {
      await clear();
      const p = commandsPanel(bot);
      return show(ctx, p.text, p.kb);
    }
    case 'cadd':
      await setState(uid, u, { step: 'cmd_name', botId: bot.id, pageId: null });
      return ask(ctx, '⌨️ أرسل اسم الأمر الجديد (مثل <code>prices</code>).', `cmds:${bot.id}`);
    case 'cpg':
      await setState(uid, u, { step: 'cmd_name', botId: bot.id, pageId: page.id });
      return ask(ctx, '⌨️ أرسل اسم الأمر الذي سيفتح هذه الصفحة (مثل <code>prices</code>).', `pg:${bot.id}:${page.id}`);
    case 'cpgs': {
      const st = u.state;
      if (!st || st.step !== 'cmd_page' || st.botId !== bot.id) return;
      bot.commands[st.name] = page.id;
      await save();
      await clear();
      await syncCommands(bot);
      const p = commandsPanel(bot);
      return show(ctx, `✅ تم ربط /${st.name}\n\n${p.text}`, p.kb);
    }
    case 'cdel': {
      const name = Object.keys(bot.commands)[Number(pid)];
      if (name && name !== 'start') {
        delete bot.commands[name];
        await save();
        await syncCommands(bot);
      }
      const p = commandsPanel(bot);
      return show(ctx, p.text, p.kb);
    }

    /* ---- الأزرار ---- */
    case 'pbt':
      await clear();
      return buttonsView();
    case 'pbadd':
      if (page.buttons.length >= MAX_BUTTONS) return alert(ctx, 'وصلت للحد الأقصى للأزرار.');
      return show(ctx, '🔘 اختر <b>نوع الزر</b>:', [
        ...Object.keys(BTN_TYPES).map((t) => [btn(BTN_TYPES[t], `pbtype:${bot.id}:${page.id}:${t}`)]),
        [btn('🔙 رجوع', `pbt:${bot.id}:${page.id}`)],
      ]);
    case 'pbtype':
      if (!Object.prototype.hasOwnProperty.call(BTN_TYPES, parts[3])) return;
      await setState(uid, u, { step: 'b_text', botId: bot.id, pageId: page.id, type: parts[3] });
      return ask(ctx, '✏️ أرسل <b>نص الزر</b> (حتى 40 حرفًا).', `pbt:${bot.id}:${page.id}`);
    case 'pbd':
      if (!page.buttons[idx]) return buttonsView();
      return detail(idx);
    case 'pbmv': {
      if (!page.buttons[idx]) return buttonsView();
      const j = parts[4] === 'u' ? idx - 1 : idx + 1;
      if (j < 0 || j >= page.buttons.length) return detail(idx);
      [page.buttons[idx], page.buttons[j]] = [page.buttons[j], page.buttons[idx]];
      await save();
      return detail(j);
    }
    case 'pbrow': {
      const b = page.buttons[idx];
      if (!b) return buttonsView();
      b.newRow = b.newRow === false;
      await save();
      return detail(idx);
    }
    case 'pbcol':
      if (!page.buttons[idx]) return buttonsView();
      return show(ctx, '🎨 اختر لون الزر:', colorKb((s) => `pbcs:${bot.id}:${page.id}:${idx}:${s}`, `pbd:${bot.id}:${page.id}:${idx}`));
    case 'pbcs': {
      const b = page.buttons[idx];
      if (!b || !COLORS[parts[4]]) return buttonsView();
      b.style = parts[4];
      await save();
      return detail(idx);
    }
    case 'pbdel':
      if (page.buttons[idx]) {
        page.buttons.splice(idx, 1);
        await save();
      }
      return buttonsView();

    /* ---- الإعدادات ---- */
    case 'set': {
      await clear();
      const p = settingsPanel(bot);
      return show(ctx, p.text, p.kb);
    }
    case 'tg': {
      if (pid !== 'feedback' && pid !== 'protect') return;
      bot.settings[pid] = !bot.settings[pid];
      await save();
      const p = settingsPanel(bot);
      return show(ctx, p.text, p.kb);
    }
    case 'fs': {
      await clear();
      const p = forcePanel(bot);
      return show(ctx, p.text, p.kb);
    }
    case 'fsadd':
      if ((bot.settings.forceSub || []).length >= MAX_FORCE) return alert(ctx, 'وصلت للحد الأقصى للقنوات.');
      await setState(uid, u, { step: 'fs_add', botId: bot.id });
      return ask(ctx, '📢 أرسل معرّف القناة (<code>@name</code>) أو رابطها، أو حوّل إليّ رسالة منها.\n\n⚠️ أضف <b>بوتك مشرفًا</b> في القناة أولًا.', `fs:${bot.id}`);
    case 'fsdel': {
      const list = bot.settings.forceSub || [];
      if (list[Number(pid)]) {
        list.splice(Number(pid), 1);
        bot.settings.forceSub = list;
        await save();
      }
      const p = forcePanel(bot);
      return show(ctx, p.text, p.kb);
    }

    /* ---- الإحصائيات والتوكن والحذف ---- */
    case 'st': {
      const p = await statsPanel(bot);
      return show(ctx, p.text, p.kb);
    }
    case 'rtok':
      await setState(uid, u, { step: 'rtok', botId: bot.id });
      return ask(ctx, '🔑 أرسل <b>التوكن الجديد</b> لهذا البوت (يجب أن يكون لنفس البوت).', `b:${bot.id}`);
    case 'del':
      return show(ctx, `⚠️ هل تريد حذف <b>@${esc(bot.username)}</b> نهائيًا مع مشتركيه؟`, [
        [btn('✅ نعم، احذف', `delok:${bot.id}`, 'danger'), btn('إلغاء', `b:${bot.id}`)],
      ]);
    case 'delok': {
      try {
        await tg.call(decrypt(bot.tokenEnc), 'deleteWebhook', { drop_pending_updates: true });
      } catch (_) {}
      await store.delBot(bot);
      await clear();
      return show(ctx, '🗑 تم حذف البوت.', [[btn('🔙 رجوع', 'list')]]);
    }

    /* ---- البث ---- */
    case 'bc': {
      const s = await store.subStats(bot.id);
      await setState(uid, u, { step: 'bc_msg', botId: bot.id });
      return ask(ctx, `📢 أرسل الرسالة التي تريد بثها (نص أو وسائط).\nالمشتركون النشطون: <b>${s.active}</b>`, `b:${bot.id}`);
    }
    case 'bcgo':
    case 'bcnext': {
      ack(ctx);
      const job = u.bc;
      if (!job || job.botId !== bot.id) return show(ctx, 'انتهت صلاحية هذا البث.', [[btn('🔙 رجوع', `b:${bot.id}`)]]);
      const token = decrypt(bot.tokenEnc);
      const bpage = { id: 'bc', title: 'بث', message: job.msg, buttons: [] };
      // أول إرسال للوسائط يخزّن file_id للبوت، لذا نرسل مستلمًا واحدًا أولًا
      const warm = () => !job.msg.media || (job.msg.media.fids && job.msg.media.fids[bot.id]);
      const done = await runBroadcast(
        job,
        (cur, n) => store.subsPage(bot.id, cur, n),
        (r) => sendPage(token, r.uid, bot, bpage),
        (r) => store.setSubBlocked(bot.id, r.uid, true),
        () => (warm() ? 25 : 1)
      );
      if (done) u.bc = null;
      await store.saveUser(uid, u);
      return show(
        ctx,
        done ? `📢 <b>اكتمل البث</b>\n\n${bcReport(job)}` : `⏳ <b>البث جارٍ…</b>\n\n${bcReport(job)}`,
        done ? [[btn('🔙 رجوع', `b:${bot.id}`)]] : [[btn('▶️ متابعة', `bcnext:${bot.id}`, 'success')]]
      );
    }

    /* ---- الرد على رسالة مستخدم (وضع التواصل) ---- */
    case 'rp':
      await setState(uid, u, { step: 'reply', botId: bot.id, to: pid });
      return send(ctx.chatId, '↩️ أرسل ردّك الآن وسأوصله للمستخدم.', [[btn('إلغاء', 'menu')]]);
  }
}

/* ------------------------------------------------------------------ */
/*  نقطة الدخول                                                        */
/* ------------------------------------------------------------------ */
async function handle(update) {
  if (update.pre_checkout_query) return onPreCheckout(update.pre_checkout_query);
  if (update.managed_bot) return onManagedBot(update.managed_bot);

  if (update.message) {
    const msg = update.message;
    if (!msg.chat || msg.chat.type !== 'private' || !msg.from) return;
    return onMessage({ msg, uid: msg.from.id, chatId: msg.chat.id });
  }

  if (update.callback_query) {
    const q = update.callback_query;
    const ctx = { q, uid: q.from.id, chatId: q.message && q.message.chat.id, acked: false };
    if (!q.message) return ack(ctx);
    try {
      await onCallback(ctx);
    } catch (e) {
      console.error('callback error:', q.data, e && e.message);
      await send(ctx.chatId, '⚠️ حدث خطأ غير متوقع. حاول مرة أخرى.', [[btn('🔙 القائمة', 'menu')]]).catch(() => {});
    } finally {
      ack(ctx);
    }
  }
}

module.exports = { handle };
