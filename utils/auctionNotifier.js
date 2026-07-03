/**
 * utils/auctionNotifier.js
 * 
 * แจ้งเตือนประมูลใกล้ปิด (30m / 10m / 5m / 2m / 1m / 30s)
 * ผ่าน Socket.IO emit ไปยังทุกคนในห้อง
 * 
 * วิธีใช้: เพิ่ม 2 บรรทัดใน server.js (ดูด้านล่าง)
 */

let _io = null;

// timers ต่อห้อง: Map<roomId, timeoutId[]>
const timers = new Map();

const CHECKPOINTS = [
  { ms: 30 * 60 * 1000, label: '30 นาที' },
  { ms: 10 * 60 * 1000, label: '10 นาที' },
  { ms:  5 * 60 * 1000, label: '5 นาที'  },
  { ms:  2 * 60 * 1000, label: '2 นาที'  },
  { ms:      60 * 1000, label: '1 นาที'  },
  { ms:      30 * 1000, label: '30 วินาที' },
];

function initAuctionNotifier(io) {
  _io = io;
}

/**
 * เรียกเมื่อสร้างห้องหรือต่อเวลา
 * room ต้องมี: { _id, endsAt: Date|string, title }
 */
function scheduleRoomNotifications(room) {
  if (!_io) return;
  const roomId  = String(room._id);
  const endsAt  = new Date(room.endsAt).getTime();
  const now     = Date.now();

  cancelRoomNotifications(roomId);

  const ids = [];

  for (const cp of CHECKPOINTS) {
    const delay = endsAt - cp.ms - now;
    if (delay <= 0) continue;
    ids.push(setTimeout(() => {
      _io.to(roomId).emit('auction:warning', {
        roomId,
        roomTitle: room.title,
        label: cp.label,
        message: `⚠️ ประมูลห้อง "${room.title}" จะปิดใน ${cp.label}!`,
      });
    }, delay));
  }

  if (ids.length) {
    timers.set(roomId, ids);
    console.log(`⏰ Scheduled ${ids.length} notifications → room ${roomId}`);
  }
}

function cancelRoomNotifications(roomId) {
  const id = String(roomId);
  if (timers.has(id)) {
    timers.get(id).forEach(clearTimeout);
    timers.delete(id);
  }
}

module.exports = { initAuctionNotifier, scheduleRoomNotifications, cancelRoomNotifications };

/* ─────────────────────────────────────────────────────────────────────────
   PATCH: server.js — เพิ่ม 3 ส่วน
 
   1) ตอน import (บนสุด ต่อจาก require อื่นๆ):
      const { initAuctionNotifier, scheduleRoomNotifications, cancelRoomNotifications } = require('./utils/auctionNotifier');
 
   2) หลัง `const io = new Server(...)` (บรรทัดประมาณ 14):
      initAuctionNotifier(io);
 
   3) ใน setInterval ที่มีอยู่แล้ว (บรรทัด ~220):
      ตรงที่ timeLeft <= 0 → lot หมดเวลา → เพิ่ม:
         cancelRoomNotifications(lot.roomId);
 
      และใน routes/rooms.js ตอน POST /api/rooms (สร้างห้อง) เพิ่ม:
         scheduleRoomNotifications(room);
──────────────────────────────────────────────────────────────────────── */
