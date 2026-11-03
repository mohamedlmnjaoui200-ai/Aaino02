const dns = require("node:dns/promises");
const net = require("node:net");
const { htmlToText } = require("./text");

// حماية SSRF: لا نجلب عناوين داخلية (مهم على Azure: يمنع الوصول إلى خدمة بيانات الآلة 169.254.169.254)
const isPrivate = (ip) => {
  ip = ip.replace(/^::ffff:/i, "");
  return net.isIPv4(ip)
    ? /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip)
    : ip === "::" || /^(::1$|f[cd]|fe80)/i.test(ip);
};
async function assertPublic(u) {
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol)) throw new Error("رابط غير صالح");
  if (process.env.ALLOW_PRIVATE_FETCH === "1") return;
  const addrs = await dns.lookup(url.hostname, { all: true });
  if (addrs.some((a) => isPrivate(a.address))) throw new Error("blocked: عنوان داخلي");
}

async function fetchPage(u) {
  let url = u;
  for (let i = 0; i < 5; i++) {
    await assertPublic(url);
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000), headers: { "User-Agent": "Mozilla/5.0 (compatible; dakos-ai)", Accept: "text/html,text/plain" } });
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url).href; continue; }
    if (!r.ok) throw new Error("HTTP " + r.status);
    const ct = r.headers.get("content-type") || "";
    if (!/text\/(html|plain)|xml/.test(ct)) throw new Error("نوع غير مدعوم: " + ct);
    const raw = (await r.text()).slice(0, 600000);
    const html = ct.includes("html") || ct.includes("xml");
    return { url, title: raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || url, text: html ? htmlToText(raw) : raw };
  }
  throw new Error("تحويلات كثيرة");
}

const E = process.env, enc = encodeURIComponent;
const J = async (url, opt = {}) => { const r = await fetch(url, { signal: AbortSignal.timeout(12000), ...opt }); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); };
const providers = {
  searxng: (q) => E.SEARXNG_URL && J(`${E.SEARXNG_URL}/search?format=json&q=${enc(q)}`).then((d) => (d.results ?? []).map((x) => ({ title: x.title, url: x.url, snippet: x.content }))),
  brave: (q) => E.BRAVE_API_KEY && J(`https://api.search.brave.com/res/v1/web/search?q=${enc(q)}&count=8`, { headers: { "X-Subscription-Token": E.BRAVE_API_KEY, Accept: "application/json" } }).then((d) => (d.web?.results ?? []).map((x) => ({ title: x.title, url: x.url, snippet: x.description }))),
  tavily: (q) => E.TAVILY_API_KEY && J("https://api.tavily.com/search", { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${E.TAVILY_API_KEY}` }, body: JSON.stringify({ query: q, max_results: 8 }) }).then((d) => (d.results ?? []).map((x) => ({ title: x.title, url: x.url, snippet: x.content }))),
  google: (q) => E.GOOGLE_CSE_KEY && E.GOOGLE_CSE_CX && J(`https://www.googleapis.com/customsearch/v1?key=${enc(E.GOOGLE_CSE_KEY)}&cx=${enc(E.GOOGLE_CSE_CX)}&q=${enc(q)}`).then((d) => (d.items ?? []).map((x) => ({ title: x.title, url: x.link, snippet: x.snippet }))),
};
const webConfigured = () => !!(E.SEARXNG_URL || E.BRAVE_API_KEY || E.TAVILY_API_KEY || (E.GOOGLE_CSE_KEY && E.GOOGLE_CSE_CX));

async function webSearch(q, max = 8) {
  const names = Object.keys(providers);
  const res = await Promise.allSettled(Object.values(providers).map((f) => Promise.resolve(f(q) || [])));
  const lists = res.map((r, i) => { if (r.status === "rejected") console.error(`[WEB] ${names[i]}:`, r.reason?.message); return r.status === "fulfilled" ? r.value : []; });
  const seen = new Set(), out = [];
  for (let k = 0; out.length < max && lists.some((l) => k < l.length); k++)
    for (const l of lists) { const x = l[k]; if (!x?.url) continue; const key = x.url.replace(/#.*$/, "").replace(/\/$/, ""); if (!seen.has(key)) { seen.add(key); out.push(x); } }
  return out.slice(0, max);
}

module.exports = { fetchPage, webSearch, webConfigured };
