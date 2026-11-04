'use strict';
// المحفظة والمتجر داخل لوحة الإدارة في بوت المستخدم نفسه (للمالك فقط):
// الرصيد، المكافأة اليومية، شحن الجواهر بالنجوم، شراء ترقيات هذا البوت، وشراء مساحة بوت جديدة.
// الدفع بالنجوم: تُرسَل الفاتورة من بوت الصانع إلى محادثة المالك، فتذهب النجوم لحساب المنصة،
// ويعالجها maker.js كما هو (payload: gems:<الجواهر>:<آيدي المالك>).
const tg = require('./telegram');
const store = require('./store');
const W = require('./wallet');

const BASE_BOTS = Number(process.env.MAX_BOTS_PER_USER || 10);
const BOTS_CAP = 100;
const REF_SLOTS = Number(process.env.REF_SLOTS || 1);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ib = (text, data) => ({ text, callback_data: data });

let makerName = null;
async function makerUsername() {
  if (makerName) return makerName;
  try {
    const me = await tg.call(process.env.MAIN_BOT_TOKEN, 'getMe', {});
    makerName = me.username;
  } catch (_) {}
  return makerName;
}

async function slotLimit(uid) {
  const [u, w, refs] = await Promise.all([store.getUser(uid), store.getWallet(uid), store.refCount(uid)]);
  return Math.min(BOTS_CAP, BASE_BOTS + (u.extraSlots || 0) + (w.slots || 0) + refs * REF_SLOTS);
}

async function panel(bot) {
  const fresh = (await store.getBot(bot.id)) || bot;
  const uid = fresh.owner;
  const [w, lim, mine] = await Promise.all([store.getWallet(uid), slotLimit(uid), store.botsOf(uid)]);
  const L = W.limitsOf(fresh);
  const owned = fresh.perks || {};
  const keys = Object.keys(W.PERKS);
  const perks = keys
    .map((k) => {
      const pk = W.PERKS[k];
      return `${owned[k] ? '✅' : pk.icon} <b>${pk.name}</b> — ${owned[k] ? 'مفعّلة' : `${pk.price} ${W.GEM}`}\n   ${pk.tagline}`;
    })
    .join('\n');
  const kb = keys.map((k) => {
    const pk = W.PERKS[k];
    return owned[k] ? [ib(`✅ ${pk.icon} ${pk.name}`, 'a:wn')] : [ib(`${pk.icon} ${pk.name} — ${pk.price} ${W.GEM}`, `a:wi:${k}`)];
  });
  const bd = W.bundleOf(fresh);
  if (bd.keys.length >= 2) kb.push([ib(`🌟 الباقة الكاملة — ${bd.price} ${W.GEM} (وفّر ${bd.full - bd.price})`, 'a:wi:all')]);
  kb.push([ib('💳 شحن الجواهر ⭐', 'a:wc'), ib('🎁 المكافأة اليومية', 'a:wd')]);
  kb.push([ib(`➕ مساحة بوت جديدة — ${W.SLOT_PRICE} ${W.GEM}`, 'a:ws')]);
  kb.push([ib('إغلاق', 'a:cx')]);
  return {
    text:
      `${W.GEM} <b>المحفظة والمتجر</b>\n\n💰 رصيدك: <b>${w.gems || 0}</b> ${W.GEM}\n` +
      `🤖 بوتاتك: <b>${mine.length}/${lim}</b>\n` +
      `🏷 خطة @${esc(fresh.username)}: ${W.planLabel(fresh)}\n` +
      `📏 الحدود: ${L.pages} صفحة • ${L.buttons} زرًا/صفحة • ${L.rkb} زر كيبورد • ${L.vars} متغيرًا • ${L.force} قنوات • ${L.admins} مشرفًا\n\n` +
      `<b>ترقيات هذا البوت</b> (اضغط أي ترقية لعرض مزاياها):\n${perks}`,
    kb,
  };
}

// بطاقة شرح احترافية لترقية (أو للباقة الكاملة) قبل الشراء
async function detailPanel(bot, key) {
  const fresh = (await store.getBot(bot.id)) || bot;
  const w = await store.getWallet(fresh.owner);
  const owned = fresh.perks || {};
  const bal = `💰 رصيدك: <b>${w.gems || 0}</b> ${W.GEM}`;
  if (key === 'all') {
    const bd = W.bundleOf(fresh);
    if (!bd.keys.length) return null;
    return {
      text:
        `🌟 <b>الباقة الكاملة</b>\n<i>كل الترقيات في صفقة واحدة بخصم ${Math.round(W.BUNDLE_DISCOUNT * 100)}%.</i>\n\n` +
        bd.keys.map((k) => `${W.PERKS[k].icon} ${W.PERKS[k].name} — ${W.PERKS[k].price} ${W.GEM}`).join('\n') +
        `\n\n💵 المجموع: <s>${bd.full}</s> → <b>${bd.price}</b> ${W.GEM} (توفّر ${bd.full - bd.price})\n${bal}`,
      kb: [[ib(`✅ تفعيل الباقة — ${bd.price} ${W.GEM}`, 'a:wp:all')], [ib('💳 شحن الجواهر', 'a:wc'), ib('🔙 رجوع', 'a:wl')]],
    };
  }
  const pk = W.PERKS[key];
  if (!pk) return null;
  if (owned[key]) return { text: `✅ <b>${pk.icon} ${pk.name}</b> مفعّلة على @${esc(fresh.username)}.`, kb: [[ib('🔙 رجوع', 'a:wl')]] };
  return {
    text:
      `${pk.icon} <b>${pk.name}</b> — ${pk.price} ${W.GEM}\n<i>${pk.tagline}</i>\n\n` +
      `<b>ما ستحصل عليه:</b>\n${pk.features.map((f) => `• ${f}`).join('\n')}\n\n` +
      `🎯 <b>مناسبة لـ:</b> ${pk.best}\n\n♾ تُشترى مرة واحدة لهذا البوت ولا تنتهي.\n${bal}`,
    kb: [[ib(`✅ تفعيل الآن — ${pk.price} ${W.GEM}`, `a:wp:${key}`)], [ib('💳 شحن الجواهر', 'a:wc'), ib('🔙 رجوع', 'a:wl')]],
  };
}

function chargePanel(w) {
  return {
    text:
      `💳 <b>شحن الجواهر</b>\n\nرصيدك الحالي: <b>${w.gems || 0}</b> ${W.GEM}\n` +
      'الدفع بنجوم تيليجرام ⭐ وتُضاف الجواهر فورًا. تصلك الفاتورة في محادثة بوت الصانع.',
    kb: [...W.GEM_PACKS.map((p, i) => [ib(`${p.gems} ${W.GEM} — ${p.stars} ⭐`, `a:wb:${i}`)]), [ib('🔙 رجوع', 'a:wl')]],
  };
}

const lowFunds = (need, have) => `❌ رصيدك غير كافٍ.\nتحتاج ${need} ${W.GEM} ولديك ${have || 0}.`;

// ctx = { answer, edit }؛ يُستدعى من admin.onCallback بعد التحقق أن المستخدم هو المالك
async function onCallback(bot, token, q, op, arg, ctx) {
  const uid = String(bot.owner);
  const { answer, edit } = ctx;
  const back = async (prefix) => {
    const p = await panel(bot);
    return edit((prefix ? prefix + '\n\n' : '') + p.text, p.kb);
  };

  switch (op) {
    case 'wn':
      return answer({ text: 'هذه الترقية مفعّلة بالفعل.' });

    case 'wl':
      await answer();
      return back();

    case 'wi': {
      const p = await detailPanel(bot, arg);
      if (!p) return answer({ text: 'لا توجد ترقيات متاحة.', show_alert: true });
      await answer();
      return edit(p.text, p.kb);
    }

    case 'wc': {
      await answer();
      const p = chargePanel(await store.getWallet(uid));
      return edit(p.text, p.kb);
    }

    case 'wb': {
      const pack = W.GEM_PACKS[Number(arg)];
      if (!pack) return answer();
      try {
        await tg.call(process.env.MAIN_BOT_TOKEN, 'sendInvoice', {
          chat_id: uid,
          title: `${pack.gems} جوهرة 💎`,
          description: `شحن ${pack.gems} جوهرة تُصرف على ترقيات البوتات ومساحاتها`,
          payload: `gems:${pack.gems}:${uid}`,
          currency: 'XTR',
          prices: [{ label: `${pack.gems} جوهرة`, amount: pack.stars }],
        });
      } catch (_) {
        const mk = await makerUsername();
        return answer({
          text: `تعذّر إرسال الفاتورة. افتح بوت الصانع${mk ? ' @' + mk : ''} وأرسل /start ثم أعد المحاولة.`,
          show_alert: true,
        });
      }
      const mk = await makerUsername();
      return answer({
        text: `📨 أُرسلت فاتورة الدفع في محادثة${mk ? ' @' + mk : ' بوت الصانع'}. بعد الدفع تُضاف الجواهر وتعود هنا.`,
        show_alert: true,
      });
    }

    case 'wd': {
      const r = await store.claimDaily(uid);
      if (!r.ok) {
        const t = Math.ceil(r.wait / 60000);
        return answer({ text: `⏳ تستلم مكافأتك التالية بعد ${Math.floor(t / 60)} ساعة و${t % 60} دقيقة.`, show_alert: true });
      }
      await answer();
      return back(`🎁 <b>مكافأة اليوم</b>: +${r.gems} ${W.GEM} • 🔥 ${r.streak} أيام متتالية`);
    }

    case 'wp': {
      // الباقة الكاملة: نحجز كل الترقيات غير المملوكة ثم نخصم السعر مرة واحدة
      const fresh = (await store.getBot(bot.id)) || bot;
      const keys = arg === 'all' ? W.bundleOf(fresh).keys : W.PERKS[arg] ? [arg] : [];
      if (!keys.length) return answer({ text: 'هذه الترقية مفعّلة بالفعل.', show_alert: true });
      const price = arg === 'all' ? W.bundleOf(fresh).price : W.PERKS[arg].price;
      const claimed = [];
      for (const k of keys) if (await store.claimPerk(bot.id, k)) claimed.push(k);
      if (!claimed.length) return answer({ text: 'هذه الترقية مفعّلة بالفعل.', show_alert: true });
      if (!(await store.spendGems(uid, price))) {
        for (const k of claimed) await store.releasePerk(bot.id, k);
        const w = await store.getWallet(uid);
        return answer({ text: lowFunds(price, w.gems), show_alert: true });
      }
      await answer({ text: 'تم التفعيل ✅' });
      const title = arg === 'all' ? '🌟 <b>الباقة الكاملة</b>' : `${W.PERKS[arg].icon} <b>${W.PERKS[arg].name}</b>`;
      return back(`✅ تم تفعيل ${title}!`);
    }

    case 'ws': {
      const [lim, mine] = await Promise.all([slotLimit(uid), store.botsOf(uid)]);
      if (lim >= BOTS_CAP) return answer({ text: `وصلت للسقف الأقصى (${BOTS_CAP} بوت).`, show_alert: true });
      if (!(await store.spendGems(uid, W.SLOT_PRICE, { slots: 1 }))) {
        const w = await store.getWallet(uid);
        return answer({ text: lowFunds(W.SLOT_PRICE, w.gems), show_alert: true });
      }
      await answer({ text: 'تمت إضافة مساحة ✅' });
      return back(`✅ تمت إضافة مساحة بوت جديدة (لديك الآن ${mine.length}/${lim + 1}).`);
    }
  }
  return answer();
}

module.exports = { panel, onCallback };
