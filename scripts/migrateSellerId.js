/**
 * scripts/migrateSellerId.js
 * 
 * Backfill sellerId บน lots เก่าที่ไม่มี field นี้
 * 
 * รัน: node scripts/migrateSellerId.js
 *       node scripts/migrateSellerId.js --dry-run
 * 
 * DB: NeDB (@seald-io/nedb) — ไม่ใช่ MongoDB
 */

const Datastore = require('@seald-io/nedb');
const path = require('path');

const DB_DIR = path.join(__dirname, '..', 'data');
const isDryRun = process.argv.includes('--dry-run');

const rooms = new Datastore({ filename: path.join(DB_DIR, 'rooms.db'), autoload: true });
const lots  = new Datastore({ filename: path.join(DB_DIR, 'lots.db'),  autoload: true });

// promisify
const find    = (ds, q) => new Promise((res, rej) => ds.find(q, (e, d) => e ? rej(e) : res(d)));
const findOne = (ds, q) => new Promise((res, rej) => ds.findOne(q, (e, d) => e ? rej(e) : res(d)));
const updateN = (ds, q, upd) => new Promise((res, rej) => ds.update(q, upd, { multi: false }, (e, n) => e ? rej(e) : res(n)));

async function run() {
  if (isDryRun) console.log('🔍 DRY RUN — ไม่มีการบันทึกจริง\n');

  // หา lots ที่ไม่มี sellerId
  const lotsWithout = await find(lots, {
    $or: [
      { sellerId: { $exists: false } },
      { sellerId: null },
      { sellerId: '' },
    ]
  });

  console.log(`📦 พบ lot ที่ไม่มี sellerId: ${lotsWithout.length} รายการ`);
  if (!lotsWithout.length) {
    console.log('✨ ไม่มีอะไรต้องแก้ไข');
    return;
  }

  // จัดกลุ่มตาม roomId
  const byRoom = {};
  for (const lot of lotsWithout) {
    const key = lot.roomId;
    if (!byRoom[key]) byRoom[key] = [];
    byRoom[key].push(lot);
  }

  let updated = 0, skipped = 0;

  for (const [roomId, roomLots] of Object.entries(byRoom)) {
    const room = await findOne(rooms, { _id: roomId });

    if (!room || !room.sellerId) {
      console.warn(`  ⚠️  roomId ${roomId} — ไม่พบห้องหรือไม่มี sellerId (ข้าม ${roomLots.length} lots)`);
      skipped += roomLots.length;
      continue;
    }

    for (const lot of roomLots) {
      console.log(`  ✏️  lot "${lot.name}" (${lot._id}) → sellerId: ${room.sellerId}`);
      if (!isDryRun) {
        await updateN(lots, { _id: lot._id }, { $set: { sellerId: room.sellerId } });
      }
      updated++;
    }
  }

  console.log(`\n📊 สรุป:`);
  console.log(`   อัปเดต : ${updated} lots`);
  console.log(`   ข้าม   : ${skipped} lots`);
  if (isDryRun) console.log(`   ⚠️  DRY RUN — ไม่มีอะไรถูกบันทึกจริง`);
  else console.log('✅ เสร็จสิ้น');
}

run().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
