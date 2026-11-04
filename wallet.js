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
const BASE = {
  pages: 30, buttons: 12, rkb: 20, vars: 20, force: 5, admins: 10,
  aiInfo: 6000, // أقصى طول لمعلومات النشاط للذكاء الاصطناعي
  aiDaily: Number(process.env.AI_DAILY_LIMIT || 30), // ردود الذكاء الاصطناعي لكل عميل يوميًا
  aiMem: 6, // أدوار المحادثة التي يتذكرها الذكاء الاصطناعي
};
const BUNDLE_DISCOUNT = Number(process.env.BUNDLE_DISCOUNT || 0.3); // خصم الباقة الكاملة

// ترقيات تُشترى مرة واحدة لكل بوت (tagline/features/best تُعرض في بطاقة الشرح قبل الشراء)
const PERKS = {
  big: {
    icon: '🚀',
    name: 'بوت أكبر',
    price: Number(process.env.PERK_BIG || 120),
    desc: '60 صفحة • 24 زرًا لكل صفحة • 40 زرًا في الكيبورد السفلي • 40 متغيرًا',
    limits: { pages: 60, buttons: 24, rkb: 40, vars: 40 },
    tagline: 'وسّع مشروعك دون سقف يوقف نموّك.',
    features: [
      '📄 60 صفحة بدل 30',
      '🔘 24 زرًا لكل صفحة بدل 12',
      '⌨️ 40 زرًا في الكيبورد السفلي بدل 20',
      '🗄 40 متغيرًا مخصصًا بدل 20',
    ],
    best: 'المتاجر والقوائم الكبيرة والبوتات متعددة الأقسام.',
  },
  chan: {
    icon: '📡',
    name: 'قنوات إضافية',
    price: Number(process.env.PERK_CHAN || 60),
    desc: 'حتى 10 قنوات/مجموعات للاشتراك الإجباري',
    limits: { force: 10 },
    tagline: 'حوّل جمهور قنواتك كلها إلى نمو مستمر.',
    features: ['📢 10 قنوات/مجموعات للاشتراك الإجباري بدل 5', '🔒 لا يصل المستخدم للمحتوى قبل الاشتراك في الكل', '✅ زر «تحققت من اشتراكي» تلقائي'],
    best: 'أصحاب الشبكات الإعلامية والقنوات المتعددة.',
  },
  team: {
    icon: '👮',
    name: 'فريق أكبر',
    price: Number(process.env.PERK_TEAM || 60),
    desc: 'حتى 25 مشرفًا داخل البوت',
    limits: { admins: 25 },
    tagline: 'وزّع العمل على فريق كامل بصلاحيات منفصلة.',
    features: ['👥 25 مشرفًا بدل 10', '🎚 صلاحيات مستقلة لكل مشرف (محتوى، بث، إحصائيات…)', '🛡 المالك وحده يدير المشرفين والمحفظة'],
    best: 'الفرق الكبيرة وخدمة العملاء على مدار الساعة.',
  },
  ai: {
    icon: '🧠',
    name: 'ذكاء Pro',
    price: Number(process.env.PERK_AI || 150),
    desc: 'ذكاء اصطناعي أقوى + صائد العملاء المحتملين',
    limits: { aiInfo: 20000, aiDaily: 150, aiMem: 12 },
    tagline: 'موظف مبيعات ودعم يعمل 24/7 ويصطاد لك العملاء.',
    features: [
      '📚 معلومات نشاط حتى 20,000 حرف بدل 6,000',
      '💬 150 ردًّا لكل عميل يوميًا بدل 30',
      '🧵 ذاكرة محادثة أطول (12 رسالة بدل 6) لردود أدقّ',
      '🔥 صائد العملاء: تنبيه فوري لك عندما يريد العميل الشراء أو الحجز أو يترك رقمه',
    ],
    best: 'المتاجر والعيادات والخدمات التي تتلقى أسئلة وطلبات كثيرة.',
  },
  stats: {
    icon: '📊',
    name: 'تحليلات Pro',
    price: Number(process.env.PERK_STATS || 90),
    desc: 'نمو يومي • أكثر الصفحات ضغطًا • معدل التفاعل',
    limits: {},
    tagline: 'قرارات مبنية على أرقام، لا على التخمين.',
    features: [
      '📈 نمو المشتركين آخر 7 أيام برسم بياني',
      '🏆 أكثر 5 صفحات ضغطًا',
      '🎯 معدل التفاعل (الضغطات ÷ المشاهدات)',
      '🚫 نسبة الحظر وصحة الجمهور',
      '🤖 عدد ردود الذكاء الاصطناعي والعملاء المحتملين',
    ],
    best: 'من يروّج لبوته ويريد معرفة ما ينجح فعلًا.',
  },
  brand: {
    icon: '🎨',
    name: 'هوية البوت',
    price: Number(process.env.PERK_BRAND || 80),
    desc: 'تغيير الاسم والوصف والنبذة من لوحة الإدارة',
    limits: {},
    tagline: 'هوية احترافية تُعدَّل بضغطة دون الرجوع إلى BotFather.',
    features: ['✏️ تغيير اسم البوت المعروض', '📝 تعديل الوصف الذي يراه العميل قبل البدء', '💬 تعديل النبذة القصيرة في صفحة البوت', '⚡ التطبيق فوري عبر واجهة تيليجرام الرسمية'],
    best: 'العلامات التجارية التي تغيّر عروضها وهويتها باستمرار.',
  },
};

// الباقة الكاملة: كل الترقيات غير المملوكة بخصم
function bundleOf(bot) {
  const owned = (bot && bot.perks) || {};
  const keys = Object.keys(PERKS).filter((k) => !owned[k]);
  const full = keys.reduce((a, k) => a + PERKS[k].price, 0);
  return { keys, full, price: Math.ceil(full * (1 - BUNDLE_DISCOUNT)) };
}

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

module.exports = { GEM, SLOT_PRICE, GEM_PACKS, BASE, PERKS, BUNDLE_DISCOUNT, bundleOf, limitsOf, planLabel };
