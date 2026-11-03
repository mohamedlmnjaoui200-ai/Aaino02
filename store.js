'use strict';
// تخزين دائم عبر Upstash Redis (REST) - بدون أي اعتماديات
const endpoint = () => process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const authToken = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

async function cmd(...args) {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const data = await res.json();
  if (data.error) throw new Error('Redis: ' + data.error);
  return data.result;
}

const parse = (v) => (v ? JSON.parse(v) : null);

async function getUser(uid) {
  return parse(await cmd('GET', `u:${uid}`)) || { state: null, createdAt: Date.now() };
}
async function saveUser(uid, u) {
  await Promise.all([cmd('SET', `u:${uid}`, JSON.stringify(u)), cmd('SADD', 'users', String(uid))]);
}

async function getBot(id) {
  return parse(await cmd('GET', `b:${id}`));
}
async function saveBot(bot) {
  await Promise.all([
    cmd('SET', `b:${bot.id}`, JSON.stringify(bot)),
    cmd('SADD', 'bots', bot.id),
    cmd('SADD', `ub:${bot.owner}`, bot.id),
  ]);
}
async function delBot(bot) {
  await Promise.all([
    cmd('DEL', `b:${bot.id}`),
    cmd('SREM', 'bots', bot.id),
    cmd('SREM', `ub:${bot.owner}`, bot.id),
  ]);
}
async function botsOf(uid) {
  const ids = await cmd('SMEMBERS', `ub:${uid}`);
  if (!ids || !ids.length) return [];
  const vals = await cmd('MGET', ...ids.map((i) => `b:${i}`));
  return vals.map(parse).filter(Boolean);
}
async function allBotIds() {
  return (await cmd('SMEMBERS', 'bots')) || [];
}
async function counts() {
  const [users, bots] = await Promise.all([cmd('SCARD', 'users'), cmd('SCARD', 'bots')]);
  return { users, bots };
}

module.exports = { getUser, saveUser, getBot, saveBot, delBot, botsOf, allBotIds, counts };
