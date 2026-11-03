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

const alert = (ctx, text) =>
  tg.call(main(), 'answerCallbackQuery', { callback_query_id: ctx.q.id, text, show_alert: true }).catch(() => {});

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
    'اكتب <code>/start</code> في البوت لعرض الصفحة الرئيسية.';
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
