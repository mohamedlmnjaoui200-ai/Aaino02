'use strict';
const tg = require('./telegram');

// الألوان المدعومة في أزرار تيليجرام (حقل style)
const COLORS = {
  primary: '🔵 أزرق',
  success: '🟢 أخضر',
  danger: '🔴 أحمر',
  default: '⚪ افتراضي',
};

function styled(button, style) {
  if (style && style !== 'default') button.style = style;
  return button;
}

// يرسل الرسالة المحفوظة "كما هي" (نفس النص والتنسيق والروابط) مع الأزرار السفلية
async function sendStored(token, chatId, bot) {
  const params = {
    chat_id: chatId,
    text: bot.message.text,
    link_preview_options: { is_disabled: true },
  };
  if (bot.message.entities && bot.message.entities.length) params.entities = bot.message.entities;
  if (bot.buttons && bot.buttons.length) {
    params.reply_markup = {
      inline_keyboard: bot.buttons.map((b) => [styled({ text: b.text, url: b.url }, b.style)]),
    };
  }
  return tg.call(token, 'sendMessage', params);
}

module.exports = { COLORS, styled, sendStored };
