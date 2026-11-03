// node scripts/import-kb.js ./مجلد-الملفات   → يضيف ملفات md/txt/html (معرفة عامة) إلى Azure SQL
require("dotenv").config();
require("../backend/azure-env")();
const fs = require("fs"), path = require("path");
const kb = require("../backend/kb");
const { htmlToText } = require("../backend/text");

const dir = process.argv[2];
if (!dir) { console.error("الاستخدام: node scripts/import-kb.js <مجلد>"); process.exit(1); }
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.(md|txt|html?)$/i.test(e.name) ? [path.join(d, e.name)] : []);
(async () => {
  await kb.ensureSchema();
  let files = 0, chunks = 0;
  for (const f of walk(dir)) {
    let t = fs.readFileSync(f, "utf8"); if (/\.html?$/i.test(f)) t = htmlToText(t);
    const title = t.match(/^#\s+(.+)$/m)?.[1] || path.basename(f, path.extname(f));
    chunks += await kb.addDoc({ source: "import", title, text: t }); files++;
    if (files % 20 === 0) console.log(`${files} ملف، ${chunks} مقطع`);
  }
  console.log(`اكتمل: ${files} ملف، ${chunks} مقطع جديد`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
