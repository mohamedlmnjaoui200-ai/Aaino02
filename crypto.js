'use strict';
const crypto = require('crypto');

function key() {
  return crypto.createHash('sha256').update(String(process.env.ENCRYPTION_KEY)).digest();
}

// تشفير AES-256-GCM لتوكنات البوتات قبل تخزينها
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// سر خاص بكل webhook (يتحقق منه الخادم من ترويسة تيليجرام)
function secretFor(scope) {
  return crypto
    .createHmac('sha256', String(process.env.WEBHOOK_SECRET))
    .update(String(scope))
    .digest('hex');
}

module.exports = { encrypt, decrypt, secretFor };
