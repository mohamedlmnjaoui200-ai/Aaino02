'use strict';
// عرض الصفحات: نص/وسائط + أزرار (روابط، صفحات، نسخ، تطبيق مصغّر) + متغيّرات
const tg = require('./telegram');
const { decrypt } = require('./crypto');

const main = () => process.env.MAIN_BOT_TOKEN;

// الألوان المدعومة في أزرار تيليجرام (حقل style)
const COLORS = {
  primary: '🔵 أزرق',
  success: '🟢 أخضر',
  danger: '🔴 أحمر',
  default: '⚪ افتراضي',
};

// أنواع الأزرار
const BTN_TYPES = {
  url: '🔗 رابط',
  page: '📄 صفحة داخل البوت',
  copy: '📋 نسخ نص',
  webapp: '🌐 تطبيق مصغّر',
};

// أنواع الوسائط المدعومة
const MEDIA = {
  photo: { method: 'sendPhoto', label: '🖼 صورة' },
  video: { method: 'sendVideo', label: '🎬 فيديو' },
  animation: { method: 'sendAnimation', label: '🎞 GIF' },
  document: { method: 'sendDocument', label: '📎 ملف' },
  audio: { method: 'sendAudio', label: '🎵 صوت' },
  voice: { method: 'sendVoice', label: '🎙 رسالة صوتية' },
};

const MAX_TEXT = 4096;
const MAX_CAPTION = 1024;
const MAX_FILE = 20 * 1024 * 1024; // حد getFile في Bot API

function styled(button, style) {
  if (style && style !== 'default') button.style = style;
  return button;
}

/* ------------------------------------------------------------------ */
/*  التحقق من المدخلات                                                  */
/* ------------------------------------------------------------------ */
const isHttp = (u) => /^https?:\/\/[^\s]+\.[^\s]+$/i.test(u);
const isTgLink = (u) => /^tg:\/\/[^\s]+$/i.test(u);
const isUrl = (u) => isHttp(u) || isTgLink(u);
const isHttps = (u) => /^https:\/\/[^\s]+\.[^\s]+$/i.test(u);

/* ------------------------------------------------------------------ */
/*  المتغيّرات داخل النص: {name} {first_name} {username} {id} {bot}     */
/*  تُستبدل مع إزاحة مواضع التنسيق (entities) تلقائيًا                  */
/* ------------------------------------------------------------------ */
function varsOf(user, bot) {
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'صديقي';
  return {
    name: full,
    first_name: user.first_name || full,
    username: user.username ? '@' + user.username : full,
    id: String(user.id),
    bot: bot && bot.username ? '@' + bot.username : '',
  };
}

function applyVars(text, entities, v) {
  const re = /\{(name|first_name|username|id|bot)\}/g;
  const reps = [];
  let m;
  while ((m = re.exec(text))) {
    reps.push({ start: m.index, end: m.index + m[0].length, val: v[m[1]] });
  }
  if (!reps.length) return { text, entities };
  let out = '';
  let last = 0;
  for (const r of reps) {
    out += text.slice(last, r.start) + r.val;
    last = r.end;
  }
  out += text.slice(last);
  const shift = (pos) => {
    let d = 0;
    for (const r of reps) if (r.end <= pos) d += r.val.length - (r.end - r.start);
    return d;
  };
  const ents = (entities || []).map((e) => {
    const s = e.offset + shift(e.offset);
    const en = e.offset + e.length + shift(e.offset + e.length);
    return Object.assign({}, e, { offset: s, length: Math.max(0, en - s) });
  });
  return { text: out, entities: ents };
}

/* ------------------------------------------------------------------ */
/*  بناء لوحة الأزرار                                                   */
/* ------------------------------------------------------------------ */
function toButton(b) {
  if (!b || !b.text) return null;
  const t = b.type || 'url';
  let k;
  if (t === 'url') {
    if (!b.url) return null;
    k = { text: b.text, url: b.url };
  } else if (t === 'page') {
    if (!b.page) return null;
    k = { text: b.text, callback_data: `g:${b.page}` };
  } else if (t === 'copy') {
    if (!b.value) return null;
    k = { text: b.text, copy_text: { text: String(b.value).slice(0, 256) } };
  } else if (t === 'webapp') {
    if (!b.url) return null;
    k = { text: b.text, web_app: { url: b.url } };
  } else return null;
  return styled(k, b.style);
}

// الأزرار المتجاورة (newRow === false) تُوضَع في نفس الصف بحد أقصى 3
function buildKeyboard(page) {
  const rows = [];
  (page.buttons || []).forEach((b) => {
    const k = toButton(b);
    if (!k) return;
    const lastRow = rows[rows.length - 1];
    if (b.newRow === false && lastRow && lastRow.length < 3) lastRow.push(k);
    else rows.push([k]);
  });
  return rows;
}

/* ------------------------------------------------------------------ */
/*  استخراج رسالة (نص/وسائط) من رسالة وصلت إلى بوت الصانع               */
/* ------------------------------------------------------------------ */
function extractMessage(msg) {
  for (const t of Object.keys(MEDIA)) {
    if (!msg[t]) continue;
    const raw = t === 'photo' ? msg.photo[msg.photo.length - 1] : msg[t];
    const cap = msg.caption || '';
    if (cap.length > MAX_CAPTION) return { error: `⚠️ الوصف أطول من ${MAX_CAPTION} حرفًا.` };
    if (raw.file_size && raw.file_size > MAX_FILE) return { error: '⚠️ الملف أكبر من 20MB.' };
    return {
      ok: { text: cap, entities: msg.caption_entities || [], media: { type: t, mainId: raw.file_id } },
    };
  }
  if (msg.text) {
    if (msg.text.length > MAX_TEXT) return { error: `⚠️ الرسالة أطول من ${MAX_TEXT} حرفًا.` };
    return { ok: { text: msg.text, entities: msg.entities || [] } };
  }
  return { error: '⚠️ نوع غير مدعوم. أرسل نصًا أو صورة أو فيديو أو GIF أو ملفًا أو صوتًا.' };
}

function fileIdOf(result, type) {
  if (!result) return null;
  if (type === 'photo') return result.photo && result.photo.length ? result.photo[result.photo.length - 1].file_id : null;
  return result[type] ? result[type].file_id : null;
}

/* ------------------------------------------------------------------ */
/*  الإرسال                                                            */
/* ------------------------------------------------------------------ */
// يعيد { result, cached } — cached=true تعني أن bot.pages تغيّرت (حُفظ file_id للبوت الابن) ويجب حفظ البوت
async function sendPage(token, chatId, bot, page, o = {}) {
  const m = page.message || { text: `📄 ${page.title}`, entities: [] };
  const v = o.user ? varsOf(o.user, bot) : null;
  const src = v ? applyVars(m.text || '', m.entities || [], v) : { text: m.text || '', entities: m.entities || [] };
  const kb = buildKeyboard(page);

  const base = { chat_id: chatId };
  if (bot.settings && bot.settings.protect && !o.preview) base.protect_content = true;
  if (kb.length) base.reply_markup = { inline_keyboard: kb };

  if (!m.media) {
    const p = Object.assign({}, base, {
      text: src.text || '‎',
      link_preview_options: { is_disabled: true },
    });
    if (src.entities.length) p.entities = src.entities;
    return { result: await tg.call(token, 'sendMessage', p), cached: false };
  }

  const def = MEDIA[m.media.type];
  const p = Object.assign({}, base);
  if (src.text) p.caption = src.text;
  if (src.entities.length) p.caption_entities = src.entities;
  const send = (file) => tg.call(token, def.method, Object.assign({}, p, { [m.media.type]: file }));

  // معاينة عبر بوت الصانع نفسه: file_id الخاص به صالح
  if (o.preview) {
    // وسائط ضُبطت من داخل البوت الابن: file_id خاص بذلك البوت، فنرفعها برابط الملف
    if (m.media.origin === 'child') {
      const ct = decrypt(bot.tokenEnc);
      const f = await tg.call(ct, 'getFile', { file_id: m.media.mainId });
      return { result: await send(`https://api.telegram.org/file/bot${ct}/${f.file_path}`), cached: false };
    }
    return { result: await send(m.media.mainId), cached: false };
  }

  // البوت الابن: استخدم file_id المخزّن له إن وُجد
  const fid = m.media.fids && m.media.fids[bot.id];
  if (fid) {
    try {
      return { result: await send(fid), cached: false };
    } catch (e) {
      if (/blocked|chat not found|deactivated|kicked/i.test(e.message)) throw e;
    }
  }
  // أول إرسال: رابط ملف مؤقت من تيليجرام ثم نخزّن file_id الجديد
  const f = await tg.call(main(), 'getFile', { file_id: m.media.mainId });
  const result = await send(`https://api.telegram.org/file/bot${main()}/${f.file_path}`);
  const nid = fileIdOf(result, m.media.type);
  if (nid) {
    m.media.fids = m.media.fids || {};
    m.media.fids[bot.id] = nid;
    return { result, cached: true };
  }
  return { result, cached: false };
}

// يعرض صفحة ردًّا على ضغطة زر: يعدّل الرسالة إن أمكن وإلا يحذفها ويرسل جديدة
async function showPage(token, chatId, srcMsg, bot, page, o = {}) {
  const m = page.message;
  const canEdit = srcMsg && srcMsg.text !== undefined && (!m || !m.media);
  if (canEdit) {
    const mm = m || { text: `📄 ${page.title}`, entities: [] };
    const v = o.user ? varsOf(o.user, bot) : null;
    const s = v ? applyVars(mm.text || '', mm.entities || [], v) : { text: mm.text || '', entities: mm.entities || [] };
    const p = {
      chat_id: chatId,
      message_id: srcMsg.message_id,
      text: s.text || '‎',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: buildKeyboard(page) },
    };
    if (s.entities.length) p.entities = s.entities;
    try {
      await tg.call(token, 'editMessageText', p);
      return { cached: false };
    } catch (e) {
      if (/not modified/i.test(e.message)) return { cached: false };
    }
  }
  if (srcMsg) tg.call(token, 'deleteMessage', { chat_id: chatId, message_id: srcMsg.message_id }).catch(() => {});
  const r = await sendPage(token, chatId, bot, page, o);
  return { cached: r.cached };
}

// ملخّص مختصر لصفحة (للوحات التحكم)
function pageSummary(page) {
  const m = page.message;
  const kind = !m ? '❌ بلا رسالة' : m.media ? MEDIA[m.media.type].label : '📝 نص';
  return `${kind} • 🔘 ${(page.buttons || []).length}`;
}

module.exports = {
  COLORS,
  BTN_TYPES,
  MEDIA,
  MAX_TEXT,
  MAX_CAPTION,
  styled,
  isUrl,
  isHttp,
  isHttps,
  varsOf,
  applyVars,
  toButton,
  buildKeyboard,
  extractMessage,
  sendPage,
  showPage,
  pageSummary,
  // توافق مع الكود القديم: إرسال الصفحة الرئيسية
  sendStored: (token, chatId, bot) => sendPage(token, chatId, bot, bot.pages.main),
};
