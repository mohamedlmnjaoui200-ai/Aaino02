const sql = require("mssql");
let poolPromise = null;

function getPool() {
  if (!poolPromise) {
    const cfg = {
      server: process.env.DB_SERVER,
      port: Number(process.env.DB_PORT || 1433),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      options: { encrypt: process.env.DB_ENCRYPT !== "false", trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === "true" },
      pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
      requestTimeout: 30000,
      connectionTimeout: 30000,
    };
    if (!cfg.server || !cfg.database || !cfg.user || !cfg.password) throw new Error("إعدادات قاعدة البيانات ناقصة: اضبط AZURE_SQL_CONNECTION_STRING");
    const pool = new sql.ConnectionPool(cfg);
    pool.on("error", (e) => { console.error("[DB]", e.message); poolPromise = null; });
    poolPromise = pool.connect().catch((e) => { poolPromise = null; throw e; });
  }
  return poolPromise;
}

module.exports = { getPool, sql };
