// مخزن المعرفة على Azure SQL: يتسع تلقائيًا ويُبحث فيه فورًا
const crypto = require("crypto");
const { getPool, sql } = require("./db");
const { tokens, chunk } = require("./text");

const SYN = (() => { try { return Object.entries(require("./synonyms-ar.json")).map(([k, v]) => [...new Set([k, ...v].flatMap(tokens))]); } catch { return []; } })();

const SCHEMA = [
`IF OBJECT_ID('dbo.KbChunks','U') IS NULL
CREATE TABLE dbo.KbChunks(
  ChunkId BIGINT IDENTITY(1,1) PRIMARY KEY,
  Source NVARCHAR(20) NOT NULL,            -- web | chat | verified | manual | import
  OwnerTelegramId BIGINT NULL,             -- NULL = معرفة عامة، وإلا خاصة بهذا المستخدم
  Title NVARCHAR(300) NOT NULL,
  BodyText NVARCHAR(MAX) NOT NULL,
  SearchText NVARCHAR(MAX) NOT NULL,       -- كلمات مطبّعة مسبقًا ومحاطة بمسافات
  Url NVARCHAR(1000) NULL,
  ContentHash CHAR(40) NOT NULL,
  CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);`,
`IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_KbChunks_Hash' AND object_id=OBJECT_ID('dbo.KbChunks'))
CREATE UNIQUE INDEX UX_KbChunks_Hash ON dbo.KbChunks(ContentHash, OwnerTelegramId);`,
`IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_KbChunks_Owner' AND object_id=OBJECT_ID('dbo.KbChunks'))
CREATE INDEX IX_KbChunks_Owner ON dbo.KbChunks(OwnerTelegramId, ChunkId DESC);`,
`IF OBJECT_ID('dbo.KbFeedback','U') IS NULL
CREATE TABLE dbo.KbFeedback(
  FeedbackId BIGINT IDENTITY(1,1) PRIMARY KEY,
  TelegramId BIGINT NOT NULL,
  ConversationId BIGINT NULL,
  Question NVARCHAR(MAX) NOT NULL,
  Answer NVARCHAR(MAX) NOT NULL,
  Rating SMALLINT NOT NULL,
  CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);`,
];

async function ensureSchema() {
  const pool = await getPool();
  for (const s of SCHEMA) await pool.request().query(s);
}

async function addDoc({ source, owner = null, title, text, url = null }) {
  const pool = await getPool();
  let n = 0;
  for (const c of chunk(text)) {
    const hash = crypto.createHash("sha1").update(c).digest("hex");
    try {
      const r = await pool.request()
        .input("src", sql.NVarChar(20), source)
        .input("owner", sql.BigInt, owner == null ? null : String(owner))
        .input("title", sql.NVarChar(300), String(title || "بدون عنوان").slice(0, 300))
        .input("body", sql.NVarChar(sql.MAX), c)
        .input("search", sql.NVarChar(sql.MAX), " " + tokens(title + " " + c).join(" ") + " ")
        .input("url", sql.NVarChar(1000), url ? String(url).slice(0, 1000) : null)
        .input("hash", sql.Char(40), hash)
        .query(`IF NOT EXISTS (SELECT 1 FROM dbo.KbChunks WHERE ContentHash=@hash AND ((OwnerTelegramId IS NULL AND @owner IS NULL) OR OwnerTelegramId=@owner))
          INSERT dbo.KbChunks(Source,OwnerTelegramId,Title,BodyText,SearchText,Url,ContentHash) VALUES(@src,@owner,@title,@body,@search,@url,@hash);`);
      n += r.rowsAffected?.[0] || 0;
    } catch (e) { if (e.number !== 2601 && e.number !== 2627) throw e; }   // تكرار متزامن: نتجاهله
  }
  return n;
}

async function search({ userId, question, k = 6 }) {
  const qt = tokens(question), terms = new Map();
  qt.forEach((t) => terms.set(t, 1));
  for (const g of SYN) if (g.some((x) => qt.includes(x))) g.forEach((x) => { if (!terms.has(x)) terms.set(x, 0.5); });
  const list = [...terms].slice(0, 12);
  if (!list.length) return [];
  const pool = await getPool();
  const req = pool.request().input("uid", sql.BigInt, String(userId)).input("k", sql.Int, k);
  const score = [], any = [];
  list.forEach(([t, w], i) => {
    req.input("t" + i, sql.NVarChar(120), `% ${t.replace(/_/g, "[_]")} %`);
    score.push(`(CASE WHEN SearchText LIKE @t${i} THEN ${w} ELSE 0 END)`);
    any.push(`SearchText LIKE @t${i}`);
  });
  const r = await req.query(`SELECT TOP (@k) ChunkId, Source, Title, BodyText, Url, (${score.join(" + ")}) AS Score
    FROM dbo.KbChunks WHERE (${any.join(" OR ")}) AND (OwnerTelegramId IS NULL OR OwnerTelegramId=@uid)
    ORDER BY Score DESC, ChunkId DESC`);
  return r.recordset;
}

async function listMine(userId, limit = 100) {
  const r = await (await getPool()).request().input("uid", sql.BigInt, String(userId)).input("k", sql.Int, limit)
    .query("SELECT TOP (@k) ChunkId, Source, Title, BodyText, CreatedAt FROM dbo.KbChunks WHERE OwnerTelegramId=@uid ORDER BY ChunkId DESC");
  return r.recordset;
}
async function deleteMine(userId, id) {
  const r = await (await getPool()).request().input("uid", sql.BigInt, String(userId)).input("id", sql.BigInt, String(id))
    .query("DELETE FROM dbo.KbChunks WHERE ChunkId=@id AND OwnerTelegramId=@uid");
  return r.rowsAffected?.[0] || 0;
}
async function deleteGlobal(id) {
  const r = await (await getPool()).request().input("id", sql.BigInt, String(id)).query("DELETE FROM dbo.KbChunks WHERE ChunkId=@id AND OwnerTelegramId IS NULL");
  return r.rowsAffected?.[0] || 0;
}
async function stats() {
  const r = await (await getPool()).request().query("SELECT Source, COUNT_BIG(*) AS N FROM dbo.KbChunks GROUP BY Source");
  return r.recordset.map((x) => ({ source: x.Source, count: Number(x.N) }));
}
async function addFeedback({ userId, conversationId, question, answer, rating }) {
  await (await getPool()).request().input("uid", sql.BigInt, String(userId)).input("cid", sql.BigInt, conversationId ? String(conversationId) : null)
    .input("q", sql.NVarChar(sql.MAX), question).input("a", sql.NVarChar(sql.MAX), answer).input("r", sql.SmallInt, rating)
    .query("INSERT dbo.KbFeedback(TelegramId,ConversationId,Question,Answer,Rating) VALUES(@uid,@cid,@q,@a,@r)");
}
async function goodFeedback() {
  const r = await (await getPool()).request().query("SELECT Question, Answer FROM dbo.KbFeedback WHERE Rating=1 ORDER BY FeedbackId");
  return r.recordset;
}

module.exports = { SCHEMA, ensureSchema, addDoc, search, listMine, deleteMine, deleteGlobal, stats, addFeedback, goodFeedback };
