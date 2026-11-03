'use strict';

// غلاف بسيط لواجهة Telegram Bot API (بدون اعتماديات خارجية)
async function call(token, method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({ ok: false, description: 'Invalid response' }));
  if (!data.ok) {
    const err = new Error(data.description || 'Telegram API error');
    err.code = data.error_code;
    throw err;
  }
  return data.result;
}

module.exports = { call };
