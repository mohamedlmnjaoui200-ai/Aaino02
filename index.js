'use strict';
const tg = require('../src/telegram');
const store = require('../src/store');
const maker = require('../src/maker');
const child = require('../src/child');
const { decrypt, secretFor } = require('../src/crypto');

const REQUIRED = ['MAIN_BOT_TOKEN', 'ENCRYPTION_KEY', 'WEBHOOK_SECRET'];

const baseUrl = () =>
  String(process.env.BASE_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`).replace(/\/+$/, '');

function missingEnv() {
  const m = REQUIRED.filter((k) => !process.env[k]);
  if (!(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL)) m.push('UPSTASH_REDIS_REST_URL');
  if (!(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN)) m.push('UPSTASH_REDIS_REST_TOKEN');
  return m;
}

// يُستدعى مرة واحدة يدويًا: /setup?key=WEBHOOK_SECRET  (أضف &resync=1 لإعادة ربط كل البوتات)
async function setup(req, res) {
  if (req.query.key !== process.env.WEBHOOK_SECRET) return res.status(403).json({ ok: false, error: 'forbidden' });
  const main = process.env.MAIN_BOT_TOKEN;
  await tg.call(main, 'setWebhook', {
    url: `${baseUrl()}/webhook/main`,
    secret_token: secretFor('main'),
    allowed_updates: ['message', 'callback_query'],
  });
  await tg
    .call(main, 'setMyCommands', {
      commands: [
        { command: 'start', description: 'القائمة الرئيسية' },
        { command: 'menu', description: 'القائمة الرئيسية' },
      ],
    })
    .catch(() => {});
  const out = { ok: true, webhook: `${baseUrl()}/webhook/main` };
  if (req.query.resync === '1') {
    let done = 0;
    let failed = 0;
    for (const id of await store.allBotIds()) {
      try {
        const bot = await store.getBot(id);
        if (!bot) continue;
        await tg.call(decrypt(bot.tokenEnc), 'setWebhook', {
          url: `${baseUrl()}/webhook/child/${bot.id}`,
          secret_token: secretFor(`child:${bot.id}`),
          allowed_updates: ['message'],
        });
        done++;
      } catch (e) {
        failed++;
        console.error(`resync ${id} failed:`, e.message);
      }
    }
    out.resynced = done;
    out.failed = failed;
  }
  return res.status(200).json(out);
}

module.exports = async (req, res) => {
  const route = req.query.route || 'root';
  try {
    if (route === 'root') return res.status(200).send('Bot maker is running');
    if (route === 'health') return res.status(200).json({ ok: true });

    const missing = missingEnv();
    if (missing.length) {
      console.error('Missing environment variables:', missing.join(', '));
      return res.status(500).json({ ok: false, missing });
    }

    if (route === 'setup') return await setup(req, res);

    if (req.method !== 'POST') return res.status(405).end();
    const header = req.headers['x-telegram-bot-api-secret-token'];

    if (route === 'main') {
      if (header !== secretFor('main')) return res.status(403).end();
      // ننتظر انتهاء المعالجة قبل الرد (Vercel يجمّد التنفيذ بعد الرد)
      await maker.handle(req.body).catch((e) => console.error('maker error:', e.message));
      return res.status(200).end();
    }

    if (route === 'child') {
      const id = String(req.query.id || '');
      if (!/^\d+$/.test(id) || header !== secretFor(`child:${id}`)) return res.status(403).end();
      await child.handle(id, req.body).catch((e) => console.error(`child ${id} error:`, e.message));
      return res.status(200).end();
    }

    return res.status(404).end();
  } catch (e) {
    console.error('handler error:', e.message);
    // نرد 200 لتيليجرام حتى لا يعيد إرسال نفس التحديث بلا نهاية
    return res.status(route === 'main' || route === 'child' ? 200 : 500).end();
  }
};
