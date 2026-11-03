'use strict';
const tg = require('./telegram');
const store = require('./store');
const { decrypt } = require('./crypto');
const { sendStored } = require('./render');

// معالجة تحديثات البوتات التي أنشأها المستخدمون
async function handle(botId, update) {
  const bot = store.db.bots[botId];
  if (!bot) return;
  const msg = update.message;
  if (!msg || !msg.text) return;

  // استخراج الأمر (مع إزالة @username)
  const m = msg.text.trim().match(/^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s|$)/);
  if (!m) return;
  const cmd = m[1].toLowerCase();
  if (cmd !== 'ms' && cmd !== 'start') return;

  const token = decrypt(bot.tokenEnc);
  if (!bot.message) {
    await tg.call(token, 'sendMessage', {
      chat_id: msg.chat.id,
      text: 'لم يتم إعداد رسالة هذا البوت بعد.',
    });
    return;
  }
  await sendStored(token, msg.chat.id, bot);
}

module.exports = { handle };
