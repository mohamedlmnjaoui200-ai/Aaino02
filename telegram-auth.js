const crypto = require("crypto");

function fail(msg) { const e = new Error(msg); e.status = 401; return e; }

// يتحقق من initData القادم من Telegram Mini App ويعيد كائن المستخدم
function verifyTelegramInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || typeof initData !== "string") throw fail("افتح التطبيق من داخل تيليجرام.");
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw fail("بيانات تيليجرام غير صالحة.");
  params.delete("hash");
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = crypto.createHmac("sha256", secret).update(check).digest("hex");
  const a = Buffer.from(calc, "hex"), b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw fail("فشل التحقق من تيليجرام.");
  const age = Math.floor(Date.now() / 1000) - Number(params.get("auth_date") || 0);
  if (!(age >= 0 && age <= maxAgeSeconds)) throw fail("انتهت الجلسة. أعد فتح التطبيق.");
  let user;
  try { user = JSON.parse(params.get("user") || ""); } catch { throw fail("بيانات المستخدم غير صالحة."); }
  if (!user?.id) throw fail("بيانات المستخدم غير صالحة.");
  return user;
}

module.exports = { verifyTelegramInitData };
