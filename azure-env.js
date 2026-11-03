// نفس منطق loadAzureSqlConnectionString في server.js، لتستخدمه السكربتات خارج الخادم
module.exports = function loadAzureSqlConnectionString() {
  const raw = process.env.AZURE_SQL_CONNECTION_STRING;
  if (!raw) return;
  const v = {};
  for (const part of raw.split(";")) { const i = part.indexOf("="); if (i < 1) continue; v[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim(); }
  const server = v["server"] || v["data source"], db = v["initial catalog"] || v["database"], user = v["user id"] || v["uid"], pwd = v["password"] || v["pwd"];
  if (!server || !db || !user || !pwd) throw new Error("AZURE_SQL_CONNECTION_STRING is missing Server, Initial Catalog, User ID, or Password.");
  const s = server.replace(/^tcp:/i, ""), c = s.lastIndexOf(",");
  process.env.DB_SERVER = c >= 0 ? s.slice(0, c) : s; if (c >= 0) process.env.DB_PORT = s.slice(c + 1);
  process.env.DB_NAME = db; process.env.DB_USER = user; process.env.DB_PASSWORD = pwd;
  process.env.DB_ENCRYPT = "true"; process.env.DB_TRUST_SERVER_CERTIFICATE = "false";
};
