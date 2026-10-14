const { MongoClient } = require('mongodb');
(async () => {
  const port = process.env.RS_PORT || 28017;
  const client = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const admin = client.db('admin');
  try {
    const st = await admin.command({ replSetGetStatus: 1 });
    if (st.set) { console.log('already=' + st.set); await client.close(); process.exit(0); }
  } catch {}
  await admin.command({ replSetInitiate: { _id: `test-rs`, members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
  console.log('initiated');
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const s = await admin.command({ replSetGetStatus: 1 });
      if (s.members && s.members.some(m => m.stateStr === 'PRIMARY')) { console.log('PRIMARY'); break; }
    } catch {}
  }
  const coll = client.db('e2e').collection('t');
  const session = client.startSession();
  session.startTransaction();
  await coll.insertOne({ k: 1 }, { session });
  await session.commitTransaction();
  const n = await coll.countDocuments({});
  console.log('TX_COMMIT_OK count=' + n);
  await client.close();
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });