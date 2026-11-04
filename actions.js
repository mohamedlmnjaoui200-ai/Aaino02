'use strict';
// إجراءات الأزرار: تغيّر المتغيرات عند ضغط زر الكيبورد السفلي (إضافة رصيد، شراء، مكافأة يومية...)
// الإجراء: { id, var, op: 'add'|'set', value, limit: 'always'|'once'|'daily', min? }
const store = require('./store');

const MAX_ACTIONS = 5;
const DAY = 24 * 3600 * 1000;
const round = (n) => Math.round(n * 1e6) / 1e6;
const LIMITS = { always: '🔁 دائمًا', once: '1️⃣ مرة واحدة لكل مستخدم', daily: '📅 كل 24 ساعة' };

function describe(a) {
  const v = a.op === 'add' ? `${a.value >= 0 ? '+' : ''}${a.value}` : `= ${a.value}`;
  const min = a.min !== undefined ? ` • يتطلب ≥ ${a.min}` : '';
  return `{${a.var}} ${v} • ${LIMITS[a.limit] || LIMITS.always}${min}`;
}

// ينفّذ إجراءات الزر للمستخدم. يعيد { ok: true } أو { ok: false, text }
async function run(bot, user, button) {
  const acts = (button.actions || []).filter((a) => bot.vars && bot.vars[a.var]);
  if (!acts.length) return { ok: true };

  const uv = await store.getUVars(bot.id, user.id);
  const now = Date.now();
  const pu = {}; // تغييرات متغيرات المستخدم المعلّقة: مفتاح (vid) -> قيمة
  const pg = {}; // تغييرات المتغيرات العامة المعلّقة: اسم -> قيمة
  const read = (name) => {
    const d = bot.vars[name];
    if (d.scope === 'user') return d.id in pu ? pu[d.id] : uv[d.id] !== undefined ? uv[d.id] : d.value;
    return name in pg ? pg[name] : d.value;
  };

  // مرحلة التحقق ثم التطبيق في الذاكرة (الكل أو لا شيء)
  for (const a of acts) {
    const key = `act_${a.id}`;
    const last = uv[key];
    if (a.limit === 'once' && last) return { ok: false, text: '⚠️ لا يمكنك تنفيذ هذا الإجراء أكثر من مرة.' };
    if (a.limit === 'daily' && last && now - last < DAY) {
      const left = DAY - (now - last);
      const total = Math.ceil(left / 60000);
      const h = Math.floor(total / 60);
      const m = total % 60;
      return { ok: false, text: `⏳ متاح بعد ${h} ساعة و${m} دقيقة.` };
    }
    const d = bot.vars[a.var];
    const cur = read(a.var);
    if (a.min !== undefined && (Number(cur) || 0) < a.min) {
      return { ok: false, text: `⚠️ رصيدك غير كافٍ. تحتاج ${a.min} على الأقل (لديك ${Number(cur) || 0}).` };
    }
    const next = a.op === 'add' ? round((Number(cur) || 0) + a.value) : a.value;
    if (d.scope === 'user') pu[d.id] = next;
    else pg[a.var] = next;
  }

  // حجز ذرّي لإجراءات «مرة واحدة/كل 24 ساعة» (يمنع تجاوز الحد بضغطتين متزامنتين)
  for (const a of acts) {
    if (!a.limit || a.limit === 'always') continue;
    const ok = await store.claimAction(bot.id, user.id, `act_${a.id}`, a.limit === 'once' ? Infinity : DAY, now);
    if (!ok) {
      return {
        ok: false,
        text: a.limit === 'once' ? '⚠️ لا يمكنك تنفيذ هذا الإجراء أكثر من مرة.' : '⏳ لقد نفّذت هذا الإجراء قبل قليل. حاول لاحقًا.',
      };
    }
  }

  // الحفظ
  for (const k of Object.keys(pu)) await store.setUVar(bot.id, user.id, k, pu[k]);
  for (const n of Object.keys(pg)) {
    await store.setGlobalVar(bot.id, n, pg[n]);
    bot.vars[n].value = pg[n];
  }
  return { ok: true };
}

module.exports = { MAX_ACTIONS, LIMITS, describe, run };
