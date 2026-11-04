'use strict';
// المحفظة والمتجر: رصيد 💎 (جواهر) يُشحن بنجوم تيليجرام أو بالمكافأة اليومية والإحالات،
// ويُصرف على مساحات بوتات وترقيات لكل بوت (حدود أكبر).

const GEM = '💎';
const SLOT_PRICE = Number(process.env.SLOT_GEMS || 100);

// باقات شحن الجواهر بنجوم تيليجرام (كلما كبرت الباقة زادت الجواهر لكل نجمة)
const GEM_PACKS = [
  { gems: 50, stars: Number(process.env.STARS_G1 || 25) },
  { gems: 150, stars: Number(process.env.STARS_G2 || 65) },
  { gems: 500, stars: Number(process.env.STARS_G3 || 200) },
  { gems: 1200, stars: Number(process.env.STARS_G4 || 450) },
];

// الحدود الأساسية لكل بوت
const BASE = { pages: 30, buttons: 12, rkb: 20, vars: 20, force: 5, admins: 10 };

// ترقيات تُشترى مرة واحدة لكل بوت
const PERKS = {
  big: {
    icon: '🚀',
    name: 'بوت أكبر',
    price: Number(process.env.PERK_BIG || 120),
    desc: '60 صفحة • 24 زرًا لكل صفحة • 40 زرًا في الكيبورد السفلي • 40 متغيرًا',
    limits: { pages: 60, buttons: 24, rkb: 40, vars: 40 },
  },
  chan: {
    icon: '📡',
    name: 'قنوات إضافية',
    price: Number(process.env.PERK_CHAN || 60),
    desc: 'حتى 10 قنوات/مجموعات للاشتراك الإجباري',
    limits: { force: 10 },
  },
  team: {
    icon: '👮',
    name: 'فريق أكبر',
    price: Number(process.env.PERK_TEAM || 60),
    desc: 'حتى 25 مشرفًا داخل البوت',
    limits: { admins: 25 },
  },
};

// الحدود الفعلية لبوت معيّن بعد تطبيق ترقياته
function limitsOf(bot) {
  const out = Object.assign({}, BASE);
  const owned = (bot && bot.perks) || {};
  Object.keys(PERKS).forEach((k) => {
    if (owned[k]) Object.assign(out, PERKS[k].limits);
  });
  return out;
}

function planLabel(bot) {
  const owned = (bot && bot.perks) || {};
  const n = Object.keys(PERKS).filter((k) => owned[k]).length;
  return n ? `⭐ مطوّر (${n}/${Object.keys(PERKS).length} ترقيات)` : '🆓 أساسي';
}

module.exports = { GEM, SLOT_PRICE, GEM_PACKS, BASE, PERKS, limitsOf, planLabel };
