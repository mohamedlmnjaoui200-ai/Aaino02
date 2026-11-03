'use strict';
// تخزين دائم عبر MongoDB (Atlas)
const { MongoClient } = require('mongodb');

let clientPromise = global._mongoClientPromise;

function db() {
  if (!clientPromise) {
    const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 5 });
    clientPromise = global._mongoClientPromise = client.connect();
  }
  return clientPromise.then((c) => c.db(process.env.MONGODB_DB || 'botmaker'));
}
const col = async (name) => (await db()).collection(name);

async function getUser(uid) {
  const d = await (await col('users')).findOne({ _id: String(uid) });
  return d ? d.data : { state: null, createdAt: Date.now() };
}
async function saveUser(uid, u) {
  await (await col('users')).updateOne({ _id: String(uid) }, { $set: { data: u } }, { upsert: true });
}

async function getBot(id) {
  const d = await (await col('bots')).findOne({ _id: String(id) });
  return d ? d.data : null;
}
async function saveBot(bot) {
  await (await col('bots')).updateOne(
    { _id: String(bot.id) },
    { $set: { data: bot, owner: String(bot.owner) } },
    { upsert: true }
  );
}
async function delBot(bot) {
  await (await col('bots')).deleteOne({ _id: String(bot.id) });
}
async function botsOf(uid) {
  const docs = await (await col('bots')).find({ owner: String(uid) }).toArray();
  return docs.map((d) => d.data).filter(Boolean);
}
async function allBotIds() {
  const docs = await (await col('bots')).find({}, { projection: { _id: 1 } }).toArray();
  return docs.map((d) => d._id);
}
async function counts() {
  const [users, bots] = await Promise.all([
    (await col('users')).countDocuments(),
    (await col('bots')).countDocuments(),
  ]);
  return { users, bots };
}

module.exports = { getUser, saveUser, getBot, saveBot, delBot, botsOf, allBotIds, counts };
