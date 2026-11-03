require("dotenv").config();

// Azure SQL: set AZURE_SQL_CONNECTION_STRING in the hosting provider's
// Environment Variables. Never commit the real connection string to GitHub.
function loadAzureSqlConnectionString() {
  const raw = process.env.AZURE_SQL_CONNECTION_STRING;
  if (!raw) return;

  const values = {};
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    const value = part.slice(index + 1).trim();
    values[key] = value;
  }

  const serverValue = values["server"] || values["data source"];
  const database = values["initial catalog"] || values["database"];
  const user = values["user id"] || values["uid"];
  const password = values["password"] || values["pwd"];

  if (!serverValue || !database || !user || !password) {
    throw new Error("AZURE_SQL_CONNECTION_STRING is missing Server, Initial Catalog, User ID, or Password.");
  }

  // mssql expects the hostname separately; Azure's "tcp:" prefix and port
  // suffix are handled here. The default SQL Server port is 1433.
  const normalizedServer = serverValue.replace(/^tcp:/i, "");
  const comma = normalizedServer.lastIndexOf(",");
  process.env.DB_SERVER = comma >= 0 ? normalizedServer.slice(0, comma) : normalizedServer;
  if (comma >= 0) process.env.DB_PORT = normalizedServer.slice(comma + 1);
  process.env.DB_NAME = database;
  process.env.DB_USER = user;
  process.env.DB_PASSWORD = password;
  process.env.DB_ENCRYPT = "true";
  process.env.DB_TRUST_SERVER_CERTIFICATE = "false";
}

loadAzureSqlConnectionString();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { z } = require("zod");
const { getPool, sql } = require("./db");
const { verifyTelegramInitData } = require("./telegram-auth");
const { generateAnswer, researchWeb, learnFrom, webEnabled } = require("./ai");
const kb = require("./kb");

const app = express();
app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
const allowedOrigins = (process.env.FRONTEND_ORIGIN || "").split(",").map(x => x.trim()).filter(Boolean);
app.use(cors({ origin(origin, cb) { if (!origin || allowedOrigins.includes(origin)) return cb(null, true); cb(Object.assign(new Error("Origin not allowed"), { status: 403 })); } }));
app.use(express.json({ limit: "1mb" }));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

const requiredEnv = ["BOT_TOKEN", "JWT_SECRET", "ADMIN_TELEGRAM_ID"];
function assertEnv() {
  const missing = requiredEnv.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  if (process.env.JWT_SECRET.length < 32) throw new Error("JWT_SECRET must be at least 32 characters.");
  if (!/^\d+$/.test(process.env.ADMIN_TELEGRAM_ID)) throw new Error("ADMIN_TELEGRAM_ID must be a numeric Telegram user ID.");
}
const adminId = String(process.env.ADMIN_TELEGRAM_ID || "");
function signUser(user) {
  return jwt.sign({ telegramId: String(user.id), isAdmin: String(user.id) === adminId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "12h", issuer: "dakos-ai" });
}
function auth(req, res, next) {
  try {
    const raw = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const payload = jwt.verify(raw, process.env.JWT_SECRET, { issuer: "dakos-ai" });
    req.auth = payload; next();
  } catch { res.status(401).json({ error: "يلزم تسجيل الدخول مجدداً." }); }
}
function admin(req, res, next) {
  if (!req.auth?.isAdmin || req.auth.telegramId !== adminId) return res.status(403).json({ error: "غير مصرح." });
  next();
}
async function getUser(telegramId) {
  const pool = await getPool();
  return pool.request().input("id", sql.BigInt, telegramId).query("SELECT TOP 1 * FROM dbo.Users WHERE TelegramId=@id");
}
async function ensureUser(tgUser) {
  const pool = await getPool();
  const id = String(tgUser.id);
  await pool.request()
    .input("id", sql.BigInt, id).input("username", sql.NVarChar(100), tgUser.username || null)
    .input("first", sql.NVarChar(150), tgUser.first_name || null).input("last", sql.NVarChar(150), tgUser.last_name || null)
    .query(`MERGE dbo.Users AS t USING (SELECT @id AS TelegramId) s ON t.TelegramId=s.TelegramId
      WHEN MATCHED THEN UPDATE SET Username=@username, FirstName=@first, LastName=@last, LastSeenAt=SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT(TelegramId,Username,FirstName,LastName,IsAllowed,CreatedAt,LastSeenAt)
      VALUES(@id,@username,@first,@last,CASE WHEN @id=${adminId || "0"} THEN 1 ELSE 0 END,SYSUTCDATETIME(),SYSUTCDATETIME());`);
  const result = await getUser(id);
  return result.recordset[0];
}
function publicUser(row) {
  return { telegramId: String(row.TelegramId), username: row.Username, firstName: row.FirstName, isAdmin: String(row.TelegramId) === adminId, allowed: !!row.IsAllowed };
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "dakos-ai-api" }));
app.post("/api/auth/telegram", async (req, res, next) => {
  try {
    const user = verifyTelegramInitData(req.body?.initData, process.env.BOT_TOKEN, Number(process.env.TELEGRAM_AUTH_MAX_AGE_SECONDS || 86400));
    const row = await ensureUser(user);
    const result = publicUser(row);
    res.json({ token: signUser(user), user: result });
  } catch (e) { next(e); }
});
app.get("/api/me", auth, async (req, res, next) => {
  try {
    const r = await getUser(req.auth.telegramId);
    if (!r.recordset[0]) return res.status(404).json({ error: "المستخدم غير موجود." });
    res.json({ user: publicUser(r.recordset[0]) });
  } catch (e) { next(e); }
});
app.post("/api/invites/redeem", auth, async (req, res, next) => {
  try {
    const parsed = z.object({ code: z.string().min(8).max(100) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "رمز الدعوة غير صالح." });
    const pool = await getPool();
    const result = await pool.request().input("codeHash", sql.VarChar(64), crypto.createHash("sha256").update(parsed.data.code).digest("hex"))
      .input("id", sql.BigInt, req.auth.telegramId)
      .query(`BEGIN TRANSACTION;
        DECLARE @inviteId BIGINT;
        SELECT TOP 1 @inviteId=InviteId FROM dbo.Invites WITH (UPDLOCK,ROWLOCK)
        WHERE CodeHash=@codeHash AND IsRevoked=0 AND ExpiresAt>SYSUTCDATETIME() AND UsesCount<MaxUses;
        IF @inviteId IS NULL BEGIN ROLLBACK; THROW 50001,'Invalid or expired invite',1; END;
        UPDATE dbo.Invites SET UsesCount=UsesCount+1 WHERE InviteId=@inviteId;
        UPDATE dbo.Users SET IsAllowed=1, InvitedAt=SYSUTCDATETIME() WHERE TelegramId=@id;
        COMMIT;
        SELECT TOP 1 * FROM dbo.Users WHERE TelegramId=@id;`);
    const row = result.recordset[0];
    if (!row) return res.status(403).json({ error: "تعذر تفعيل الدعوة." });
    const user = { id: req.auth.telegramId };
    res.json({ token: signUser(user), user: publicUser(row) });
  } catch (e) { if (e.number === 50001) return res.status(400).json({ error: "رمز الدعوة غير صالح أو منتهي أو استُخدم بالكامل." }); next(e); }
});
app.post("/api/chat", auth, rateLimit({ windowMs: 60_000, limit: Number(process.env.CHAT_RATE_LIMIT || 20), standardHeaders: true, legacyHeaders: false }), async (req, res, next) => {
  try {
    const userResult = await getUser(req.auth.telegramId);
    const user = userResult.recordset[0];
    if (!user?.IsAllowed) return res.status(403).json({ error: "حسابك غير مفعل. تحتاج إلى دعوة." });
    const parsed = z.object({ message: z.string().trim().min(1).max(Number(process.env.MAX_MESSAGE_CHARS || 12000)), conversationId: z.number().int().positive().nullable().optional(), web: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "الرسالة غير صالحة أو طويلة جداً." });
    const pool = await getPool();
    let conversationId = parsed.data.conversationId || null;
    let history = [];
    if (conversationId) {
      const owned = await pool.request().input("cid", sql.BigInt, conversationId).input("uid", sql.BigInt, req.auth.telegramId)
        .query("SELECT ConversationId FROM dbo.Conversations WHERE ConversationId=@cid AND TelegramId=@uid AND IsDeleted=0");
      if (!owned.recordset.length) return res.status(404).json({ error: "المحادثة غير موجودة." });
      // آخر الرسائل تُعطى للنموذج كسياق للمحادثة (قبل إدراج الرسالة الحالية)
      const prev = await pool.request().input("cid", sql.BigInt, conversationId)
        .query("SELECT TOP 10 Role, Content FROM dbo.Messages WHERE ConversationId=@cid ORDER BY CreatedAt DESC");
      history = prev.recordset.reverse().map(m => ({ role: m.Role, content: m.Content }));
    } else {
      const created = await pool.request().input("uid", sql.BigInt, req.auth.telegramId).input("title", sql.NVarChar(180), parsed.data.message.slice(0, 80))
        .query("INSERT dbo.Conversations(TelegramId,Title,CreatedAt,UpdatedAt) OUTPUT INSERTED.ConversationId VALUES(@uid,@title,SYSUTCDATETIME(),SYSUTCDATETIME())");
      conversationId = Number(created.recordset[0].ConversationId);
    }
    await pool.request().input("cid", sql.BigInt, conversationId).input("role", sql.VarChar(20), "user").input("content", sql.NVarChar(sql.MAX), parsed.data.message)
      .query("INSERT dbo.Messages(ConversationId,Role,Content,CreatedAt) VALUES(@cid,@role,@content,SYSUTCDATETIME())");
    const found = await pool.request().input("q", sql.NVarChar(400), parsed.data.message.slice(0, 400))
      .query(`SELECT TOP 4 Language, BodyText FROM dbo.CodeSnippets
        WHERE IsApproved=1 AND BodyText IS NOT NULL AND SearchText LIKE '%' + REPLACE(REPLACE(@q,'%','[%]'),'_','[_]') + '%'
        ORDER BY QualityScore DESC, SnippetId DESC`);
    // معرفتك المخزنة على Azure SQL: عامة + خاصة بهذا المستخدم
    let chunks = await kb.search({ userId: req.auth.telegramId, question: parsed.data.message, k: 6 });
    const webMode = process.env.WEB_SEARCH || "auto";   // auto | always | off
    if (webMode !== "off" && webEnabled() && (webMode === "always" || parsed.data.web || found.recordset.length + chunks.length < 3)) {
      try { await researchWeb(parsed.data.message); chunks = await kb.search({ userId: req.auth.telegramId, question: parsed.data.message, k: 6 }); }
      catch (e) { console.error("[WEB]", e.message); }
    }
    const answer = await generateAnswer({ message: parsed.data.message, history, snippets: found.recordset, chunks });
    await pool.request().input("cid", sql.BigInt, conversationId).input("role", sql.VarChar(20), "assistant").input("content", sql.NVarChar(sql.MAX), answer)
      .query("INSERT dbo.Messages(ConversationId,Role,Content,CreatedAt) VALUES(@cid,@role,@content,SYSUTCDATETIME())");
    await pool.request().input("cid", sql.BigInt, conversationId).query("UPDATE dbo.Conversations SET UpdatedAt=SYSUTCDATETIME() WHERE ConversationId=@cid");
    learnFrom({ userId: req.auth.telegramId, message: parsed.data.message }).catch(e => console.error("[LEARN]", e.message));   // تعلّم تلقائي بعد الرد
    res.json({ conversationId, answer, retrievedSnippets: found.recordset.length, retrievedChunks: chunks.length,
      sources: chunks.filter(c => c.Url).map(c => ({ title: c.Title, url: c.Url })) });
  } catch (e) { next(e); }
});
app.get("/api/admin/overview", auth, admin, async (_req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(`SELECT
      (SELECT COUNT_BIG(*) FROM dbo.Users) AS Users,
      (SELECT COUNT_BIG(*) FROM dbo.Invites WHERE IsRevoked=0 AND ExpiresAt>SYSUTCDATETIME() AND UsesCount<MaxUses) AS Invites,
      (SELECT COUNT_BIG(*) FROM dbo.Conversations WHERE IsDeleted=0) AS Conversations,
      (SELECT COUNT_BIG(*) FROM dbo.CodeSnippets) AS Snippets`);
    const x = r.recordset[0]; res.json({ users:Number(x.Users), invites:Number(x.Invites), conversations:Number(x.Conversations), snippets:Number(x.Snippets) });
  } catch (e) { next(e); }
});
app.get("/api/admin/users", auth, admin, async (_req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query("SELECT TOP 200 TelegramId,Username,FirstName,IsAllowed FROM dbo.Users ORDER BY CreatedAt DESC");
    res.json({ items:r.recordset.map(x => ({telegramId:String(x.TelegramId),username:x.Username,firstName:x.FirstName,isAllowed:!!x.IsAllowed})) });
  } catch (e) { next(e); }
});
app.patch("/api/admin/users/:id/access", auth, admin, async (req, res, next) => {
  try {
    const parsed = z.object({allowed:z.boolean()}).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({error:"Invalid access value"});
    if (String(req.params.id) === adminId) return res.status(400).json({error:"لا يمكن حظر المالك."});
    const pool = await getPool();
    await pool.request().input("id",sql.BigInt,req.params.id).input("allowed",sql.Bit,parsed.data.allowed)
      .query("UPDATE dbo.Users SET IsAllowed=@allowed WHERE TelegramId=@id");
    res.json({ok:true});
  } catch(e){next(e);}
});
app.post("/api/admin/invites", auth, admin, async (req, res, next) => {
  try {
    const parsed = z.object({uses:z.number().int().min(1).max(100).default(1),hours:z.number().int().min(1).max(720).default(72)}).safeParse(req.body);
    if(!parsed.success) return res.status(400).json({error:"إعدادات الدعوة غير صالحة."});
    const code = crypto.randomBytes(18).toString("base64url");
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    const pool = await getPool();
    await pool.request().input("hash",sql.VarChar(64),codeHash).input("creator",sql.BigInt,req.auth.telegramId)
      .input("uses",sql.Int,parsed.data.uses).input("hours",sql.Int,parsed.data.hours)
      .query("INSERT dbo.Invites(CodeHash,CreatedBy,MaxUses,UsesCount,ExpiresAt,IsRevoked,CreatedAt) VALUES(@hash,@creator,@uses,0,DATEADD(hour,@hours,SYSUTCDATETIME()),0,SYSUTCDATETIME())");
    res.json({code});
  }catch(e){next(e);}
});

// ---------- تقييم الإجابات + إدارة الذاكرة + إضافة المعرفة ----------
app.post("/api/feedback", auth, async (req, res, next) => {
  try {
    const parsed = z.object({ conversationId: z.number().int().positive(), rating: z.union([z.literal(1), z.literal(-1)]) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "طلب غير صالح." });
    const pool = await getPool();
    const owned = await pool.request().input("cid", sql.BigInt, parsed.data.conversationId).input("uid", sql.BigInt, req.auth.telegramId)
      .query("SELECT ConversationId FROM dbo.Conversations WHERE ConversationId=@cid AND TelegramId=@uid AND IsDeleted=0");
    if (!owned.recordset.length) return res.status(404).json({ error: "المحادثة غير موجودة." });
    const last = await pool.request().input("cid", sql.BigInt, parsed.data.conversationId)
      .query("SELECT TOP 2 Role, Content FROM dbo.Messages WHERE ConversationId=@cid ORDER BY CreatedAt DESC");
    const a = last.recordset.find(m => m.Role === "assistant"), q = last.recordset.find(m => m.Role === "user");
    if (!a || !q) return res.status(400).json({ error: "لا توجد إجابة لتقييمها." });
    await kb.addFeedback({ userId: req.auth.telegramId, conversationId: parsed.data.conversationId, question: q.Content, answer: a.Content, rating: parsed.data.rating });
    if (parsed.data.rating === 1)   // الجواب المعتمد يصبح معرفة خاصة بصاحبه
      await kb.addDoc({ source: "verified", owner: req.auth.telegramId, title: q.Content.slice(0, 120), text: `السؤال: ${q.Content}\n\nالجواب المعتمد:\n${a.Content}` });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.get("/api/kb/mine", auth, async (req, res, next) => {
  try { res.json({ items: (await kb.listMine(req.auth.telegramId)).map(x => ({ id: String(x.ChunkId), source: x.Source, title: x.Title, text: x.BodyText })) }); } catch (e) { next(e); }
});
app.delete("/api/kb/mine/:id", auth, async (req, res, next) => {
  try { res.json({ deleted: await kb.deleteMine(req.auth.telegramId, req.params.id) }); } catch (e) { next(e); }
});
app.get("/api/admin/kb", auth, admin, async (_req, res, next) => {
  try { res.json({ bySource: await kb.stats() }); } catch (e) { next(e); }
});
app.post("/api/admin/kb", auth, admin, async (req, res, next) => {
  try {
    const parsed = z.object({ title: z.string().trim().min(1).max(300), text: z.string().min(20).max(500000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "بيانات غير صالحة." });
    res.json({ added: await kb.addDoc({ source: "manual", title: parsed.data.title, text: parsed.data.text }) });
  } catch (e) { next(e); }
});
app.post("/api/admin/kb/url", auth, admin, async (req, res, next) => {
  try {
    const parsed = z.object({ url: z.string().url() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "رابط غير صالح." });
    const p = await require("./web").fetchPage(parsed.data.url);
    res.json({ added: await kb.addDoc({ source: "web", title: p.title, text: p.text.slice(0, 200000), url: p.url }) });
  } catch (e) { next(e); }
});
app.delete("/api/admin/kb/:id", auth, admin, async (req, res, next) => {
  try { res.json({ deleted: await kb.deleteGlobal(req.params.id) }); } catch (e) { next(e); }
});
app.get("/api/admin/export", auth, admin, async (_req, res, next) => {   // بيانات التدريب الشهري: الأجوبة المقيّمة "جيدة" فقط
  try {
    const rows = await kb.goodFeedback();
    res.type("application/x-ndjson").send(rows.map(r => JSON.stringify({ messages: [{ role: "user", content: r.Question }, { role: "assistant", content: r.Answer }] })).join("\n"));
  } catch (e) { next(e); }
});
app.use((err, _req, res, _next) => {
  console.error("[DAKOS API]", err.message);
  const status = err.status || 500;
  res.status(status).json({error: status < 500 || process.env.NODE_ENV !== "production" ? err.message : "حدث خطأ داخلي. حاول لاحقاً."});
});
assertEnv();
kb.ensureSchema().catch(e => console.error("[KB] تعذّر إنشاء الجداول تلقائيًا، شغّل sql/kb-schema.sql يدويًا:", e.message));
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`DAKOS AI API listening on ${port}`));
