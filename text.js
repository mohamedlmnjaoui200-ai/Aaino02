const norm = (s) =>
  s.normalize("NFKC").replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").toLowerCase();
const PRE = ["وال", "بال", "كال", "فال", "لل", "ال", "و", "ف", "ب", "ل", "ك"];
const SUF = ["ات", "ان", "ون", "ين", "ها", "هم", "ه", "ي", "ك"];
function stem(w) {
  if (/^[a-z0-9_]+$/.test(w)) return w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w;
  for (const p of PRE) if (w.startsWith(p) && w.length - p.length >= (p.length > 1 ? 3 : 4)) { w = w.slice(p.length); break; }
  for (const s of SUF) if (w.endsWith(s) && w.length - s.length >= 3) { w = w.slice(0, -s.length); break; }
  return w;
}
const tokens = (s) => (norm(s).match(/[\p{L}\p{N}_]+/gu) ?? []).map(stem).filter((w) => w.length > 1);

function chunk(text, max = 1000) {
  const out = []; let cur = "";
  for (const p of String(text).split(/\n{2,}/)) {
    if (cur && cur.length + p.length > max) { out.push(cur); cur = ""; }
    cur = cur ? cur + "\n\n" + p : p;
    while (cur.length > 2000) { out.push(cur.slice(0, 2000)); cur = cur.slice(2000); }
  }
  if (cur.trim()) out.push(cur);
  return out.map((c) => c.trim()).filter((c) => c.length >= 20);
}

const ENT = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const htmlToText = (h) => h
  .replace(/<(script|style|nav|footer|header|aside|noscript)[\s\S]*?<\/\1>/gi, " ")
  .replace(/<\/(p|div|h[1-6]|li|tr|pre)>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (m) => ENT[m]).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();

module.exports = { norm, stem, tokens, chunk, htmlToText };
