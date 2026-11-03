'use strict';
const express = require('express');
const tg = require('./src/telegram');
const store = require('./src/store');
const maker = require('./src/maker');
const child = require('./src/child');
const { decrypt, secretFor } = require('./src/crypto');

const REQUIRED = ['MAIN_BOT_TOKEN', 'BASE_URL', 'ENCRYPTION_KEY', 'WEBHOOK_SECRET'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('Missing environment variables:', missing.join(', '));
  process.exit(1);
}

const BASE_URL = process.env.BASE_URL.replace(/\/+$/, '');
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => res.send('Bot maker is running'));
app.get('/health', (_req, res) => res.json({ ok: true }));

const header = (req) => req.get('x-telegram-bot-api-secret-token');

app.post('/webhook/main', (req, res) => {
  if (header(req) !== secretFor('main')) return res.sendStatus(403);
  res.sendStatus(200);
  maker.handle(req.body).catch((e) => console.error('maker error:', e.message));
});

app.post('/webhook/child/:id', (req, res) => {
  const id = req.params.id;
  if (header(req) !== secretFor(`child:${id}`)) return res.sendStatus(403);
  res.sendStatus(200);
  child.handle(id, req.body).catch((e) => console.error(`child ${id} error:`, e.message));
});

async function setupWebhooks() {
  const main = process.env.MAIN_BOT_TOKEN;
  await tg.call(main, 'setWebhook', {
    url: `${BASE_URL}/webhook/main`,
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
  console.log('Main webhook set:', `${BASE_URL}/webhook/main`);

  // إعادة ربط البوتات الفرعية بعد تغيير النطاق (RESYNC_WEBHOOKS=true)
  if (process.env.RESYNC_WEBHOOKS === 'true') {
    for (const bot of Object.values(store.db.bots)) {
      try {
        await tg.call(decrypt(bot.tokenEnc), 'setWebhook', {
          url: `${BASE_URL}/webhook/child/${bot.id}`,
          secret_token: secretFor(`child:${bot.id}`),
          allowed_updates: ['message'],
        });
      } catch (e) {
        console.error(`resync ${bot.id} failed:`, e.message);
      }
    }
    console.log('Child webhooks resynced');
  }
}

const port = process.env.PORT || 8080;
const server = app.listen(port, () => {
  console.log(`Listening on ${port}`);
  setupWebhooks().catch((e) => console.error('Webhook setup failed:', e.message));
});

function shutdown() {
  try {
    store.flush();
  } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
