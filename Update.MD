# BidHod - Full Code Documentation

## ไฟล์ทั้งหมดของโปรเจค BidHod

---

## 1. BidHod/server.js

```javascript
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

// ensure dirs
fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
fs.mkdirSync(path.join(__dirname, "public/uploads"), { recursive: true });

const { find, findOne, insert, update } = require("./db");
const { authSocket } = require("./middleware/auth");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.set('io', io);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Routes ──────────────────────────────────────
const authRoutes   = require("./routes/auth");
const roomRoutes   = require("./routes/rooms");
const adminRoutes  = require("./routes/admin");
const uploadRoutes = require("./routes/upload");

app.use("/api/auth",   authRoutes);
app.use("/api/rooms",  roomRoutes);
app.use("/api/admin",  adminRoutes);
app.use("/api/upload", uploadRoutes);
app.use('/api/messages', require('./routes/messages'));

// SPA fallback
app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Socket.io ────────────────────────────────
io.on("connection", (socket) => {
  const token = socket.handshake.auth?.token;
  const user = authSocket(token); // null = ยังไม่ login
  let currentRoom = null;

  // เข้าห้อง
  socket.on("room:join", async (roomId) => {
    if (currentRoom) socket.leave(currentRoom);
    const room = await findOne("rooms", { _id: roomId });
    if (!room) return socket.emit("error", { message: "ไม่พบห้องนี้" });

    currentRoom = roomId;
    socket.join(roomId);

    const lots = await find("lots", { roomId }, { num: 1 });
    const lotsWithBids = await Promise.all(lots.map(async l => {
      const bids = await find("bids", { lotId: l._id }, { createdAt: -1 });
      return { ...l, bids: bids.slice(0, 20) };
    }));

    socket.emit("room:init", {
      ...room, lots: lotsWithBids,
      userId: user?.id || null,
      userName: user?.name || null,
      userRole: user?.role || "guest",
      serverTime: Date.now(),
    });

    const count = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    io.to(roomId).emit("room:viewers", { count });
  });

  // ออกจากห้อง
  socket.on("room:leave", () => {
    if (!currentRoom) return;
    socket.leave(currentRoom);
    const count = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
    io.to(currentRoom).emit("room:viewers", { count });
    currentRoom = null;
  });

  // วาง bid
  socket.on("bid:place", async ({ roomId, lotId, amount, bidderName }) => {
    // ต้อง login
    if (!user) return socket.emit("bid:error", { message: "กรุณา login ก่อนประมูล" });

    const lot = await findOne("lots", { _id: lotId });
    if (!lot) return socket.emit("bid:error", { message: "ไม่พบ lot นี้" });
    if (!lot.isActive) return socket.emit("bid:error", { message: "Lot นี้สิ้นสุดแล้ว" });
    if (Date.now() > new Date(lot.endsAt).getTime())
      return socket.emit("bid:error", { message: "หมดเวลาแล้ว" });
    if (amount <= lot.currentPrice)
      return socket.emit("bid:error", { message: `ต้องประมูลมากกว่า ฿${lot.currentPrice.toLocaleString()}` });

    const bid = await insert("bids", {
      lotId, roomId,
      bidderId: user.id,
      bidderName: user.name,
      amount,
      createdAt: new Date(),
    });

    await update("lots", { _id: lotId }, {
      $set: { currentPrice: amount, highestBidder: user.name, highestBidderId: user.id }
    });

    // anti-sniping — ใช้ค่าจาก room ถ้าไม่มีก็ไม่ต่อเวลา
    const endsAt = new Date(lot.endsAt).getTime();
    const snipeTrigger = (lot.snipeTrigger || 0) * 1000;
    const snipeExt     = (lot.snipeExt || 0) * 1000;
    if (snipeTrigger > 0 && snipeExt > 0 && endsAt - Date.now() < snipeTrigger) {
      const newEndsAt = new Date(Date.now() + snipeExt);
      await update("lots", { _id: lotId }, { $set: { endsAt: newEndsAt } });
      io.to(roomId).emit("lot:extended", { lotId, newEndsAt });
    }

    io.to(roomId).emit("bid:new", {
      lotId, bid,
      currentPrice: amount,
      highestBidder: user.name,
    });
  });

  // admin/seller broadcast อัปเดตข้อมูล lot
  socket.on("lot:update", async ({ roomId, lotId, changes }) => {
    if (!user || !["admin","seller"].includes(user.role))
      return socket.emit("error", { message: "ไม่มีสิทธิ์" });
    await update("lots", { _id: lotId }, { $set: changes });
    io.to(roomId).emit("lot:updated", { lotId, changes });
  });

  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const count = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
    io.to(currentRoom).emit("room:viewers", { count });
  });

  // BIN — ซื้อทันที
  socket.on('bin:place', async ({ roomId, lotId }) => {
    if (!user) return socket.emit('bid:error', { message: 'กรุณา login ก่อน', lotId });

    const lot = await findOne('lots', { _id: lotId });
    if (!lot) return socket.emit('bid:error', { message: 'ไม่พบ lot นี้', lotId });
    if (!lot.isActive) return socket.emit('bid:error', { message: 'Lot นี้สิ้นสุดแล้ว', lotId });
    if (!lot.binPrice) return socket.emit('bid:error', { message: 'Lot นี้ไม่มีราคาปิด', lotId });

    // บันทึก bid ในราคา BIN
    await insert('bids', {
      lotId, roomId,
      bidderId: user.id,
      bidderName: user.name,
      amount: lot.binPrice,
      isBin: true,
      createdAt: new Date(),
    });

    // ปิด lot ทันที
    await update('lots', { _id: lotId }, {
      $set: {
        isActive: false,
        currentPrice: lot.binPrice,
        highestBidder: user.name,
        highestBidderId: user.id,
      }
    });

    io.to(roomId).emit('lot:bin', {
      lotId,
      buyerName: user.name,
      finalPrice: lot.binPrice,
    });

    // แจ้งเตือนผู้ชนะผ่าน chat (เหมือน lot:ended)
    try {
      const adminUser = await findOne('users', { role: 'admin' }) || { _id: 'system', name: 'ระบบ' };
      const text = `คุณซื้อ Lot ${lot.name} ด้วยราคาปิด ฿${Number(lot.binPrice).toLocaleString()} เรียบร้อยแล้ว`;
      const msg = { senderId: adminUser._id || 'system', receiverId: user.id, text, createdAt: Date.now() };
      const saved = await insert('messages', msg);
      const chatRoom = [msg.senderId, user.id].sort().join('_');
      io.to(\`chat:\${chatRoom}\`).emit('chat:message', saved);
      io.to(\`user:\${user.id}\`).emit('chat:notification', { fromId: msg.senderId, preview: saved.text.substring(0, 60) });
    } catch (e) {
      console.error('bin notify error', e);
    }
  });

  socket.on('chat:join', ({ myId, otherId }) => {
    const roomId = [myId, otherId].sort().join('_');
    console.log('chat:join', roomId, myId, otherId);
    socket.join(\`chat:\${roomId}\`);
  });

  socket.on('chat:leave', ({ myId, otherId }) => {
    const roomId = [myId, otherId].sort().join('_');
    socket.leave(\`chat:\${roomId}\`);
  });

  socket.on('user:join', (userId) => {
    console.log('user:join', userId);
    socket.join(\`user:\${userId}\`);
  });

  socket.on('chat:send', async ({ senderId, receiverId, text }) => {
    console.log('chat:send', {senderId, receiverId, text});
    if (!text || !text.trim()) return;
    const msg = { senderId, receiverId, text: text.trim(), createdAt: Date.now() };
    try {
      const saved = await new Promise((resolve, reject) => {
        db.messages.insert(msg, (err, doc) => err ? reject(err) : resolve(doc));
      });
      const roomId = [senderId, receiverId].sort().join('_');
      io.to(\`chat:\${roomId}\`).emit('chat:message', saved);
      io.to(\`user:\${receiverId}\`).emit('chat:notification', {
        fromId: senderId,
        preview: saved.text.substring(0, 60)
      });
      console.log('chat:message emitted', { roomId, saved });
    } catch (err) {
      socket.emit('chat:error', { message: err.message });
    }
  });

});

// ── Timer ─────────────────────────────────────────
setInterval(async () => {
  const activeLots = await find("lots", { isActive: true });
  for (const lot of activeLots) {
    const endsAt = new Date(lot.endsAt).getTime();
    const timeLeft = endsAt - Date.now();
    if (timeLeft <= 0) {
      await update("lots", { _id: lot._id }, { $set: { isActive: false } });
      io.to(lot.roomId).emit("lot:ended", {
        lotId: lot._id,
        winner: lot.highestBidder,
        finalPrice: lot.currentPrice,
      });

      // Send chat notification to the winner only (persisted)
      try {
        const winnerId = lot.highestBidderId;
        if (winnerId) {
          const adminUser = await findOne('users', { role: 'admin' }) || { _id: 'system', name: 'ระบบ' };
          const text = \`การประมูลของ Lot \${lot.name} สิ้นสุดแล้ว — คุณเป็นผู้ชนะ ด้วยราคา ฿\${Number(lot.currentPrice).toLocaleString()}\`;
          const msg = {
            senderId: adminUser._id || adminUser.id || 'system',
            receiverId: winnerId,
            text,
            createdAt: Date.now(),
          };

          const saved = await insert('messages', msg);
          const roomId = [msg.senderId, winnerId].sort().join('_');
          io.to(\`chat:\${roomId}\`).emit('chat:message', saved);
          io.to(\`user:\${winnerId}\`).emit('chat:notification', { fromId: msg.senderId, preview: saved.text.substring(0,60) });
        }
      } catch (err) {
        console.error('error notifying winner on lot end', err);
      }
    } else {
      io.to(lot.roomId).emit("lot:tick", { lotId: lot._id, timeLeft, endsAt });
    }
  }
}, 1000);

// ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(\`🚀 Bidhaus running at http://localhost:\${PORT}\`));
```

---

## 2. BidHod/db.js

```javascript
const Datastore = require("@seald-io/nedb");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB_DIR = path.join(__dirname, "data");

const db = {
  users: new Datastore({ filename: path.join(DB_DIR, "users.db"), autoload: true }),
  rooms: new Datastore({ filename: path.join(DB_DIR, "rooms.db"), autoload: true }),
  lots:  new Datastore({ filename: path.join(DB_DIR, "lots.db"),  autoload: true }),
  bids:  new Datastore({ filename: path.join(DB_DIR, "bids.db"),  autoload: true }),
  messages: new Datastore({ filename: path.join(__dirname, 'data/messages.db'), autoload: true })
};

// indexes
db.users.ensureIndex({ fieldName: "email", unique: true });
db.rooms.ensureIndex({ fieldName: "createdAt" });
db.lots.ensureIndex({ fieldName: "roomId" });
db.bids.ensureIndex({ fieldName: "lotId" });

// seed admin ถ้ายังไม่มี
db.users.findOne({ role: "admin" }, (err, doc) => {
  if (!doc) {
    const hash = bcrypt.hashSync("admin1234", 10);
    db.users.insert({
      email: "admin@bidhaus.com",
      password: hash,
      name: "Admin",
      role: "admin",       // admin | seller | buyer
      status: "approved",  // approved | pending | rejected
      createdAt: new Date(),
    }, () => console.log("🔑 Admin created: admin@bidhaus.com / admin1234"));
  }
});

// promisify helpers
const find   = (col, q={}, sort={}) => new Promise((res,rej) => db[col].find(q).sort(sort).exec((e,d)=> e?rej(e):res(d)));
const findOne = (col, q)            => new Promise((res,rej) => db[col].findOne(q,(e,d)=> e?rej(e):res(d)));
const insert  = (col, doc)          => new Promise((res,rej) => db[col].insert(doc,(e,d)=> e?rej(e):res(d)));
const update  = (col, q, upd, opt={}) => new Promise((res,rej) => db[col].update(q,upd,opt,(e,n)=> e?rej(e):res(n)));
const remove  = (col, q, opt={})    => new Promise((res,rej) => db[col].remove(q,opt,(e,n)=> e?rej(e):res(n)));

module.exports = { db, find, findOne, insert, update, remove };
```

---

## 3. BidHod/package.json

```json
{
  "name": "bidhaus-full",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "npx nodemon server.js"
  },
  "dependencies": {
    "@seald-io/nedb": "^4.1.2",
    "bcryptjs": "^2.4.3",
    "express": "^4.18.2",
    "jsonwebtoken": "^9.0.2",
    "multer": "^2.1.1",
    "socket.io": "^4.7.2",
    "sql.js": "^1.10.3"
  },
  "overrides": {
    "uuid": "^11.1.1"
  }
}
```

---

## 4. BidHod/middleware/auth.js

```javascript
const jwt = require("jsonwebtoken");
const { findOne } = require("../db");

const SECRET = process.env.JWT_SECRET || "bidhaus_secret_change_in_prod";

function signToken(user) {
  return jwt.sign(
    { id: user._id, email: user.email, role: user.role, name: user.name },
    SECRET,
    { expiresIn: "7d" }
  );
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

// middleware: ต้อง login
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "กรุณา login ก่อน" });
  try {
    req.user = verifyToken(auth.slice(7));
    next();
  } catch {
    res.status(401).json({ error: "Token หมดอายุ กรุณา login ใหม่" });
  }
}

// middleware: ต้องเป็น admin
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
    next();
  });
}

// middleware: ต้องเป็น seller หรือ admin
function requireSeller(req, res, next) {
  requireAuth(req, res, () => {
    if (!["admin","seller"].includes(req.user.role))
      return res.status(403).json({ error: "Seller only" });
    next();
  });
}

// parse token จาก socket handshake
function authSocket(token) {
  if (!token) return null;
  try { return verifyToken(token); }
  catch { return null; }
}

module.exports = { signToken, requireAuth, requireAdmin, requireSeller, authSocket };
```

---

## 5. BidHod/routes/auth.js

```javascript
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const { findOne, insert } = require("../db");
const { signToken } = require("../middleware/auth");

// POST /api/auth/register
router.post("/register", async (req, res) => {
  try {
    const { email, password, name, role } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: "กรุณากรอกข้อมูลให้ครบ" });
    if (password.length < 6) return res.status(400).json({ error: "รหัสผ่านต้องมีอย่างน้อย 6 ตัว" });

    const existing = await findOne("users", { email });
    if (existing) return res.status(400).json({ error: "อีเมลนี้ถูกใช้แล้ว" });

    const allowedRoles = ["buyer", "seller"];
    const userRole = allowedRoles.includes(role) ? role : "buyer";
    // seller ต้องรออนุมัติ, buyer อนุมัติทันที
    const status = userRole === "seller" ? "pending" : "approved";

    const hash = bcrypt.hashSync(password, 10);
    const user = await insert("users", {
      email, password: hash, name,
      role: userRole, status,
      createdAt: new Date(),
    });

    if (status === "pending") {
      return res.json({ message: "สมัครสำเร็จ! รอ admin อนุมัติ seller account ของคุณ" });
    }
    res.json({ token: signToken(user), user: { id: user._id, email, name, role: userRole } });
  } catch (e) {
    if (e.errorType === "uniqueViolated") return res.status(400).json({ error: "อีเมลนี้ถูกใช้แล้ว" });
    res.status(500).json({ error: "เกิดข้อผิดพลาด" });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await findOne("users", { email });
    if (!user) return res.status(400).json({ error: "ไม่พบอีเมลนี้" });
    if (!bcrypt.compareSync(password, user.password))
      return res.status(400).json({ error: "รหัสผ่านไม่ถูกต้อง" });
    if (user.status === "pending")
      return res.status(403).json({ error: "บัญชีของคุณรอการอนุมัติจาก admin" });
    if (user.status === "rejected")
      return res.status(403).json({ error: "บัญชีของคุณถูกปฏิเสธ" });

    res.json({
      token: signToken(user),
      user: { id: user._id, email: user.email, name: user.name, role: user.role },
    });
  } catch {
    res.status(500).json({ error: "เกิดข้อผิดพลาด" });
  }
});

// GET /api/auth/me
router.get("/me", require("../middleware/auth").requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
```

---

## 6. BidHod/routes/admin.js

```javascript
const router = require("express").Router();
const { find, findOne, update, remove } = require("../db");
const { requireAdmin } = require("../middleware/auth");

// GET /api/admin/users — ดู users ทั้งหมด
router.get("/users", requireAdmin, async (req, res) => {
  const users = await find("users", {}, { createdAt: -1 });
  res.json(users.map(u => ({ ...u, password: undefined })));
});

// PATCH /api/admin/users/:id/status — อนุมัติ/ปฏิเสธ seller
router.patch("/users/:id/status", requireAdmin, async (req, res) => {
  const { status } = req.body; // approved | rejected
  if (!["approved","rejected"].includes(status))
    return res.status(400).json({ error: "status ไม่ถูกต้อง" });
  await update("users", { _id: req.params.id }, { $set: { status } });
  res.json({ ok: true });
});

// DELETE /api/admin/users/:id
router.delete("/users/:id", requireAdmin, async (req, res) => {
  await remove("users", { _id: req.params.id });
  res.json({ ok: true });
});

// GET /api/admin/rooms — ดูห้องทั้งหมด
router.get("/rooms", requireAdmin, async (req, res) => {
  const rooms = await find("rooms", {}, { createdAt: -1 });
  res.json(rooms);
});

// DELETE /api/admin/rooms/:id
router.delete("/rooms/:id", requireAdmin, async (req, res) => {
  await remove("rooms", { _id: req.params.id });
  await remove("lots", { roomId: req.params.id }, { multi: true });
  res.json({ ok: true });
});

// GET /api/admin/pending — seller ที่รออนุมัติ
router.get("/pending", requireAdmin, async (req, res) => {
  const users = await find("users", { role: "seller", status: "pending" }, { createdAt: 1 });
  res.json(users.map(u => ({ ...u, password: undefined })));
});

module.exports = router;
```

---

## 7. BidHod/routes/messages.js

```javascript
const express = require('express');
const router = express.Router();
const { requireAuth: auth } = require('../middleware/auth');
const { db } = require('../db');

// GET /api/messages/conversations — list all conversations for current user
router.get('/conversations', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Find all messages where user is sender or receiver
    const messages = await new Promise((resolve, reject) => {
      db.messages.find({
        $or: [{ senderId: userId }, { receiverId: userId }]
      }).sort({ createdAt: -1 }).exec((err, docs) => {
        if (err) reject(err);
        else resolve(docs);
      });
    });

    // Group by conversation partner
    const convMap = {};
    for (const msg of messages) {
      const partnerId = msg.senderId === userId ? msg.receiverId : msg.senderId;
      if (!convMap[partnerId]) {
        convMap[partnerId] = { lastMessage: msg, unread: 0 };
      }
      if (!msg.readAt && msg.receiverId === userId) {
        convMap[partnerId].unread++;
      }
    }

    // Fetch partner user info
    const partnerIds = Object.keys(convMap);
    const partners = await new Promise((resolve, reject) => {
      db.users.find({ _id: { $in: partnerIds } }, { password: 0 }, (err, docs) => {
        if (err) reject(err);
        else resolve(docs);
      });
    });

    const conversations = partners.map(partner => ({
      partner,
      lastMessage: convMap[partner._id].lastMessage,
      unread: convMap[partner._id].unread
    })).sort((a, b) => b.lastMessage.createdAt - a.lastMessage.createdAt);

    res.json(conversations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/admin — get admin contact info for chat
router.get('/admin', auth, async (req, res) => {
  try {
    db.users.findOne({ role: 'admin' }, { password: 0 }, (err, admin) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!admin) return res.status(404).json({ error: 'ไม่พบผู้ดูแลระบบ' });
      res.json({ admin });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/:userId — get messages between current user and userId
router.get('/:userId', auth, async (req, res) => {
  try {
    const myId = req.user.id;
    const otherId = req.params.userId;

    const messages = await new Promise((resolve, reject) => {
      db.messages.find({
        $or: [
          { senderId: myId, receiverId: otherId },
          { senderId: otherId, receiverId: myId }
        ]
      }).sort({ createdAt: 1 }).exec((err, docs) => {
        if (err) reject(err);
        else resolve(docs);
      });
    });

    // Mark messages as read
    await new Promise((resolve, reject) => {
      db.messages.update(
        { senderId: otherId, receiverId: myId, readAt: { $exists: false } },
        { $set: { readAt: Date.now() } },
        { multi: true },
        (err) => { if (err) reject(err); else resolve(); }
      );
    });

    // Fetch other user info
    let otherUser = await new Promise((resolve, reject) => {
      db.users.findOne({ _id: otherId }, { password: 0 }, (err, doc) => {
        if (err) reject(err);
        else resolve(doc);
      });
    });

    // If the target user ID no longer exists, but is attached to a room as seller, fallback to room seller metadata.
    if (!otherUser) {
      otherUser = await new Promise((resolve, reject) => {
        db.rooms.findOne({ sellerId: otherId }, (err, room) => {
          if (err) reject(err);
          else if (!room) resolve(null);
          else resolve({ _id: otherId, name: room.sellerName || 'ผู้ใช้', role: 'seller' });
        });
      });
    }

    if (!otherUser) {
      return res.status(404).json({ error: 'ไม่พบผู้ใช้ปลายทาง' });
    }

    res.json({ messages, otherUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/messages/:userId — send a message and persist it
router.post('/:userId', auth, async (req, res) => {
  try {
    const senderId = req.user.id;
    const receiverId = req.params.userId;
    const { text, roomId } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    const msg = {
      senderId,
      receiverId,
      text: text.trim(),
      createdAt: Date.now()
    };

    // If room context is provided, associate message with that room
    if (roomId) {
      msg.roomId = roomId;
    }

    const saved = await new Promise((resolve, reject) => {
      db.messages.insert(msg, (err, doc) => {
        if (err) reject(err);
        else resolve(doc);
      });
    });

    const io = req.app.get('io');
    if (io) {
      const chatRoomId = [senderId, receiverId].sort().join('_');
      io.to(\`chat:\${chatRoomId}\`).emit('chat:message', saved);
      io.to(\`user:\${receiverId}\`).emit('chat:notification', {
        fromId: senderId,
        preview: saved.text.substring(0, 60)
      });
    }

    res.status(201).json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

---

## 8. BidHod/routes/rooms.js

```javascript
const router = require("express").Router();
const { find, findOne, insert, update, remove } = require("../db");
const { requireAuth, requireSeller, requireAdmin } = require("../middleware/auth");

// GET /api/rooms
router.get("/", async (req, res) => {
  const rooms = await find("rooms", {}, { createdAt: -1 });
  const enriched = await Promise.all(rooms.map(async r => {
    const lots = await find("lots", { roomId: r._id });
    return {
      ...r,
      totalLots: lots.length,
      coverImage: lots[0]?.image || null,
      activeLots: lots.filter(l => l.isActive).length,
      lowestPrice: lots.length ? Math.min(...lots.map(l => l.currentPrice)) : 0,
    };
  }));
  res.json(enriched);
});

// GET /api/rooms/:id
router.get("/:id", async (req, res) => {
  const room = await findOne("rooms", { _id: req.params.id });
  if (!room) return res.status(404).json({ error: "ไม่พบห้องนี้" });
  const lots = await find("lots", { roomId: req.params.id }, { num: 1 });
  const lotsWithBids = await Promise.all(lots.map(async l => {
    const bids = await find("bids", { lotId: l._id }, { createdAt: -1 });
    return { ...l, bids: bids.slice(0, 20) };
  }));
  res.json({ ...room, lots: lotsWithBids });
});

// POST /api/rooms — seller/admin สร้างห้อง
router.post("/", requireSeller, async (req, res) => {
  const { title, house, lots: lotsData, snipeExt = 0, snipeTrigger = 0 } = req.body;
  if (!title || !house) return res.status(400).json({ error: "กรุณากรอก title และ house" });

  const room = await insert("rooms", {
    title, house,
    sellerId: req.user.id,
    sellerName: req.user.name,
    snipeExt,
    snipeTrigger,
    createdAt: new Date(),
  });

  if (lotsData?.length) {
    await Promise.all(lotsData.map((l, i) => insert("lots", {
      roomId: room._id,
      num: i + 1,
      name: l.name,
      desc: l.desc || "",
      image: l.image || "",
      startingPrice: l.startingPrice || 0,
      currentPrice: l.startingPrice || 0,
      binPrice: l.binPrice || null,
      highestBidder: null,
      highestBidderId: null,
      isActive: true,
      endsAt: new Date(Date.now() + (l.durationMin || 30) * 60 * 1000),
      snipeExt,
      snipeTrigger,
      createdAt: new Date(),
    })));
  }
  res.json({ ok: true, roomId: room._id });
});

// PATCH /api/rooms/:id — seller เจ้าของแก้ได้, admin แก้ได้ทั้งหมด
router.patch("/:id", requireSeller, async (req, res) => {
  const room = await findOne("rooms", { _id: req.params.id });
  if (!room) return res.status(404).json({ error: "ไม่พบห้องนี้" });
  if (req.user.role !== "admin" && room.sellerId !== req.user.id)
    return res.status(403).json({ error: "ไม่มีสิทธิ์แก้ไข" });
  const { title, house } = req.body;
  await update("rooms", { _id: req.params.id }, { $set: { title, house } });
  res.json({ ok: true });
});

// DELETE /api/rooms/:id
router.delete("/:id", requireSeller, async (req, res) => {
  const room = await findOne("rooms", { _id: req.params.id });
  if (!room) return res.status(404).json({ error: "ไม่พบห้องนี้" });
  if (req.user.role !== "admin" && room.sellerId !== req.user.id)
    return res.status(403).json({ error: "ไม่มีสิทธิ์ลบ" });
  await remove("rooms", { _id: req.params.id });
  await remove("lots", { roomId: req.params.id }, { multi: true });
  res.json({ ok: true });
});

module.exports = router;
```

---

## 9. BidHod/routes/upload.js

```javascript
const router = require("express").Router();
const multer = require("multer");
const path = require("path");
const { requireAuth } = require("../middleware/auth");

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, "../public/uploads")),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, \`\${Date.now()}-\${Math.random().toString(36).slice(2,7)}\${ext}\`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
    const ext = path.extname(file.originalname).toLowerCase();
    allowed.includes(ext) ? cb(null, true) : cb(new Error("รองรับเฉพาะไฟล์รูปเท่านั้น"));
  },
});

// POST /api/upload — อัปโหลดรูป 1 ไฟล์
router.post("/", requireAuth, upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ไม่พบไฟล์" });
  res.json({ url: \`/uploads/\${req.file.filename}\` });
});

module.exports = router;
```

---

## 10. BidHod/public/index.html

```html
<!DOCTYPE html>
<html lang="th">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bidmai</title>
  <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/style.css">
  <style>
    #toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: rgba(17, 17, 17, 0.95);
      color: #fff;
      padding: 12px 16px;
      border-radius: 14px;
      font-size: 13px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s ease;
      z-index: 999;
      max-width: 280px;
    }
    #toast.show { opacity: 1; }
    .nav-badge {
      margin-left: 8px;
      display: none;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      border-radius: 999px;
      background: #ef4444;
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      padding: 0 6px;
    }
  </style>
  <script src="/socket.io/socket.io.js"></script>
</head>

<body>
  <nav>
    <div class="logo">Bidmai</div>
    <div class="nav-right">
      <div class="live-pill">
        <div class="live-dot"></div><span id="live-count">0</span> live
      </div>
      <span style="font-size:12px;color:var(--ink3)" id="nav-user"></span>
      <button class="nav-btn" id="admin-btn" style="display:none" onclick="location.href='/admin.html'">Admin</button>
      <button class="nav-btn" id="messages-btn" style="display:none" onclick="location.href='/messages.html'">ข้อความ<span id="messages-badge" class="nav-badge"></span></button>
      <button class="nav-btn" id="contact-admin-btn" style="display:none" onclick="openAdminChat()">ติดต่อ Admin</button>
      <button class="nav-btn" id="sell-btn" style="display:none" onclick="location.href='/create-room.html'">+
        ลงของ</button>
      <button class="nav-btn" id="logout-btn" style="display:none" onclick="logout()">ออกจากระบบ</button>
      <button class="nav-btn primary" id="login-btn" onclick="location.href='/login.html'">เข้าสู่ระบบ</button>
    </div>
  </nav>

  <div class="container">
    <div class="page-label">Auctions</div>
    <h1>รายการประมูลทั้งหมด</h1>
    <div class="filter-bar">
      <button class="filter-btn on" onclick="filterRooms('all',this)">ทั้งหมด</button>
      <button class="filter-btn" onclick="filterRooms('live',this)">กำลัง Live</button>
      <button class="filter-btn" onclick="filterRooms('ended',this)">สิ้นสุดแล้ว</button>
    </div>
    <div class="feed-grid" id="rooms-grid">
      <div class="empty">กำลังโหลด...</div>
    </div>
    <div style="display:flex;justify-content:space-between;padding:12px 0;font-size:12px;color:var(--ink4)">
      <span>แสดง <span id="showing">0</span> รายการ</span>
      <span><span id="live-rooms">0</span> ห้อง live อยู่ตอนนี้</span>
    </div>
  </div>

  <script>
    let allRooms = [];
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    if (user) {
      document.getElementById('nav-user').textContent = user.name;
      document.getElementById('login-btn').style.display = 'none';
      document.getElementById('logout-btn').style.display = 'block';
      document.getElementById('messages-btn').style.display = 'inline-block';
      if (user.role === 'admin') {
        document.getElementById('admin-btn').style.display = 'block';
      } else {
        document.getElementById('contact-admin-btn').style.display = 'inline-block';
      }
      if (['admin', 'seller'].includes(user.role)) document.getElementById('sell-btn').style.display = 'block';
    }
    function logout() { localStorage.clear(); location.reload(); }

    let unreadMessages = 0;

    function showToast(msg) {
      let el = document.getElementById('toast');
      if (!el) return;
      el.textContent = msg;
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 3200);
    }

    function updateMessagesBadge() {
      const badge = document.getElementById('messages-badge');
      if (!badge) return;
      if (unreadMessages > 0) {
        badge.textContent = unreadMessages > 9 ? '9+' : unreadMessages;
        badge.style.display = 'inline-flex';
      } else {
        badge.style.display = 'none';
      }
    }

    async function loadUnreadCount() {
      if (!localStorage.getItem('token')) return;
      try {
        const res = await fetch('/api/messages/conversations', {
          headers: { Authorization: \`Bearer \${localStorage.getItem('token')}\` }
        });
        if (!res.ok) return;
        const conv = await res.json();
        unreadMessages = conv.reduce((sum, c) => sum + (c.unread || 0), 0);
        updateMessagesBadge();
      } catch (err) {
        console.warn('Unread load failed', err);
      }
    }

    function openAdminChat() {
      if (!localStorage.getItem('token')) return location.href = '/login.html';
      location.href = '/messages.html?with=admin';
    }

    async function initIndexNotifications() {
      if (!user || (!user.id && !user._id)) return;
      const socket = io();
      socket.on('connect', () => {
        socket.emit('user:join', user.id || user._id);
      });
      socket.on('chat:notification', ({ fromId, preview }) => {
        unreadMessages += 1;
        updateMessagesBadge();
        showToast(\`ข้อความใหม่: \${preview}\`);
      });
      socket.on('disconnect', () => {});
    }

    async function loadRooms() {
      try {
        const r = await fetch('/api/rooms');
        allRooms = await r.json();
        renderRooms(allRooms);
      } catch { document.getElementById('rooms-grid').innerHTML = '<div class="empty">โหลดไม่ได้</div>'; }
    }

    function renderRooms(rooms) {
      const live = rooms.filter(r => r.activeLots > 0).length;
      document.getElementById('live-count').textContent = live;
      document.getElementById('showing').textContent = rooms.length;
      document.getElementById('live-rooms').textContent = live;
      if (!rooms.length) { document.getElementById('rooms-grid').innerHTML = '<div class="empty">ไม่พบรายการ</div>'; return; }
      document.getElementById('rooms-grid').innerHTML = rooms.map(r => {
        const isLive = r.activeLots > 0;
        const thumb = r.coverImage ? '<img src="' + r.coverImage + '" alt="' + r.title + '">' : '🏛';
        return \`<a class="feed-card" href="/room.html?id=\${r._id}">
      <div class="feed-thumb">\${thumb}</div>
      <div class="feed-body">
        <div class="feed-top">
          <span class="badge \${isLive ? 'badge-live' : 'badge-ended'}">\${isLive ? '● LIVE' : 'สิ้นสุด'}</span>
          <span style="font-size:11px;color:var(--ink4)">\${r.totalLots} lots</span>
        </div>
        <div class="feed-house">\${r.house}</div>
        <div class="feed-title">\${r.title}</div>
        <div class="feed-bottom">
          <div><div class="price-label">ราคาเริ่มจาก</div><div class="price-val">฿\${(r.lowestPrice || 0).toLocaleString()}</div></div>
          <div style="font-size:11px;color:var(--ink4)">โดย \${r.sellerName || '—'}</div>
        </div>
      </div>
    </a>\`;
      }).join('');
    }

    function filterRooms(type, btn) {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      if (type === 'all') renderRooms(allRooms);
      else if (type === 'live') renderRooms(allRooms.filter(r => r.activeLots > 0));
      else renderRooms(allRooms.filter(r => r.activeLots === 0));
    }
    loadRooms();
    loadUnreadCount();
    initIndexNotifications();
    setInterval(loadRooms, 15000);
  </script>
  <div id="toast"></div>
</body>

</html>
```

---

## 11. BidHod/public/login.html

```html
<!DOCTYPE html>
<html lang="th">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bidmai — Login</title>
  <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/style.css">
  <style>
    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
      background: var(--bg2)
    }

    .card {
      background: var(--bg);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 28px;
      width: 100%;
      max-width: 360px
    }

    .tabs {
      display: flex;
      margin-bottom: 22px;
      border-bottom: 1px solid var(--line)
    }

    .tab {
      flex: 1;
      padding: 9px;
      text-align: center;
      font-size: 13px;
      color: var(--ink3);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all .15s
    }

    .tab.active {
      color: var(--ink);
      border-bottom-color: var(--ink)
    }

    .role-note {
      font-size: 11px;
      color: var(--ink4);
      margin-top: 4px;
      line-height: 1.5
    }
  </style>
</head>

<body>
  <div style="font-size:15px;font-weight:600;letter-spacing:3px;text-transform:uppercase;margin-bottom:28px">Bidmai
  </div>
  <div class="card">
    <div class="tabs">
      <div class="tab active" onclick="switchTab('login')">เข้าสู่ระบบ</div>
      <div class="tab" onclick="switchTab('register')">สมัครสมาชิก</div>
    </div>

    <div id="login-form">
      <div class="field"><label>อีเมล</label><input id="l-email" type="email" placeholder="your@email.com"></div>
      <div class="field"><label>รหัสผ่าน</label><input id="l-pass" type="password" placeholder="••••••••"></div>
      <button class="btn primary btn-full" onclick="doLogin()">เข้าสู่ระบบ</button>
      <div class="msg" id="login-msg"></div>
    </div>

    <div id="register-form" style="display:none">
      <div class="field"><label>ชื่อ</label><input id="r-name" type="text" placeholder="ชื่อของคุณ"></div>
      <div class="field"><label>อีเมล</label><input id="r-email" type="email" placeholder="your@email.com"></div>
      <div class="field"><label>รหัสผ่าน</label><input id="r-pass" type="password" placeholder="อย่างน้อย 6 ตัว"></div>
      <div class="field">
        <label>ประเภทบัญชี</label>
        <select id="r-role" onchange="updateNote()">
          <option value="buyer">Buyer — ผู้ประมูล</option>
          <option value="seller">Seller — ผู้ลงของ</option>
        </select>
        <div class="role-note" id="role-note">สมัครแล้วเข้าใช้งานได้ทันที</div>
      </div>
      <button class="btn primary btn-full" onclick="doRegister()">สมัครสมาชิก</button>
      <div class="msg" id="register-msg"></div>
    </div>
  </div>

  <script>
    if (localStorage.getItem('token')) location.href = '/';
    function switchTab(t) {
      document.querySelectorAll('.tab').forEach((el, i) => el.classList.toggle('active', (i === 0 && t === 'login') || (i === 1 && t === 'register')));
      document.getElementById('login-form').style.display = t === 'login' ? 'block' : 'none';
      document.getElementById('register-form').style.display = t === 'register' ? 'block' : 'none';
    }
    function updateNote() {
      document.getElementById('role-note').textContent = document.getElementById('r-role').value === 'seller'
        ? 'บัญชี Seller ต้องรอ admin อนุมัติก่อนถึงจะลงของได้' : 'สมัครแล้วเข้าใช้งานได้ทันที';
    }
    async function doLogin() {
      const email = document.getElementById('l-email').value.trim();
      const password = document.getElementById('l-pass').value;
      const msg = document.getElementById('login-msg');
      try {
        const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
        const d = await r.json();
        if (!r.ok) { msg.className = 'msg err'; msg.textContent = d.error; return; }
        localStorage.setItem('token', d.token);
        localStorage.setItem('user', JSON.stringify(d.user));
        location.href = new URLSearchParams(location.search).get('redirect') || '/';
      } catch { msg.className = 'msg err'; msg.textContent = 'เกิดข้อผิดพลาด'; }
    }
    async function doRegister() {
      const name = document.getElementById('r-name').value.trim();
      const email = document.getElementById('r-email').value.trim();
      const password = document.getElementById('r-pass').value;
      const role = document.getElementById('r-role').value;
      const msg = document.getElementById('register-msg');
      try {
        const r = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, password, role }) });
        const d = await r.json();
        if (!r.ok) { msg.className = 'msg err'; msg.textContent = d.error; return; }
        if (d.token) { localStorage.setItem('token', d.token); localStorage.setItem('user', JSON.stringify(d.user)); location.href = '/'; }
        else { msg.className = 'msg ok'; msg.textContent = d.message; }
      } catch { msg.className = 'msg err'; msg.textContent = 'เกิดข้อผิดพลาด'; }
    }
    document.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('login-form').style.display !== 'none' ? doLogin() : doRegister(); });
  </script>
</body>

</html>
```

---

## 12. BidHod/public/admin.html

```html
<!DOCTYPE html>
<html lang="th">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bidmai — Admin</title>
  <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/style.css">
  <style>
    .stat-row {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 10px;
      margin-bottom: 24px
    }

    .stat-card {
      background: var(--bg2);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 16px
    }

    .stat-card-label {
      font-size: 10px;
      letter-spacing: 1px;
      color: var(--ink4);
      text-transform: uppercase;
      margin-bottom: 4px
    }

    .stat-card-val {
      font-size: 24px;
      font-weight: 500;
      color: var(--ink)
    }

    .page-tabs {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--line);
      margin-bottom: 20px
    }

    .page-tab {
      padding: 10px 18px;
      font-size: 13px;
      color: var(--ink3);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all .15s
    }

    .page-tab.active {
      color: var(--ink);
      border-bottom-color: var(--ink)
    }

    .section {
      display: none
    }

    .section.active {
      display: block
    }

    .table-wrap {
      overflow-x: auto;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      overflow: hidden
    }

    .action-row {
      display: flex;
      gap: 4px
    }
  </style>
</head>

<body>
  <nav>
    <div style="display:flex;align-items:center;gap:12px">
      <a href="/" style="font-size:12px;color:var(--ink3)">← กลับ</a>
      <div class="logo">Admin</div>
    </div>
    <span style="font-size:12px;color:var(--ink3)" id="nav-name"></span>
  </nav>

  <div class="container">
    <div class="page-label">Dashboard</div>
    <h1>Admin Panel</h1>

    <div class="stat-row">
      <div class="stat-card">
        <div class="stat-card-label">Users ทั้งหมด</div>
        <div class="stat-card-val" id="s-users">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-label">รออนุมัติ</div>
        <div class="stat-card-val" id="s-pending" style="color:var(--red)">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-label">ห้องประมูล</div>
        <div class="stat-card-val" id="s-rooms">—</div>
      </div>
    </div>

    <div class="page-tabs">
      <div class="page-tab active" onclick="switchTab('sellers')">Seller รออนุมัติ</div>
      <div class="page-tab" onclick="switchTab('users')">Users ทั้งหมด</div>
      <div class="page-tab" onclick="switchTab('rooms')">ห้องประมูล</div>
    </div>

    <div class="section active" id="tab-sellers">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ชื่อ</th>
              <th>อีเมล</th>
              <th>วันที่สมัคร</th>
              <th>การจัดการ</th>
            </tr>
          </thead>
          <tbody id="pending-tbody">
            <tr>
              <td colspan="4" style="text-align:center;color:var(--ink4);padding:32px">กำลังโหลด...</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="section" id="tab-users">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ชื่อ</th>
              <th>อีเมล</th>
              <th>Role</th>
              <th>Status</th>
              <th>การจัดการ</th>
            </tr>
          </thead>
          <tbody id="users-tbody">
            <tr>
              <td colspan="5" style="text-align:center;color:var(--ink4);padding:32px">กำลังโหลด...</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="section" id="tab-rooms">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ชื่อห้อง</th>
              <th>House</th>
              <th>โดย</th>
              <th>การจัดการ</th>
            </tr>
          </thead>
          <tbody id="rooms-tbody">
            <tr>
              <td colspan="4" style="text-align:center;color:var(--ink4);padding:32px">กำลังโหลด...</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    const token = localStorage.getItem('token');
    if (!token || user?.role !== 'admin') location.href = '/';
    document.getElementById('nav-name').textContent = user?.name || '';
    const H = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };

    async function loadAll() {
      const [uR, pR, rR] = await Promise.all([fetch('/api/admin/users', { headers: H }), fetch('/api/admin/pending', { headers: H }), fetch('/api/admin/rooms', { headers: H })]);
      const users = await uR.json(), pending = await pR.json(), rooms = await rR.json();
      document.getElementById('s-users').textContent = users.length;
      document.getElementById('s-pending').textContent = pending.length;
      document.getElementById('s-rooms').textContent = rooms.length;

      document.getElementById('pending-tbody').innerHTML = pending.length
        ? pending.map(u => `<tr><td style="font-weight:500">${u.name}</td><td style="color:var(--ink3)">${u.email}</td><td style="color:var(--ink4);font-size:12px">${new Date(u.createdAt).toLocaleDateString('th')}</td><td><div class="action-row"><button class="btn success" onclick="setStatus('${u._id}','approved')">อนุมัติ</button><button class="btn danger" onclick="setStatus('${u._id}','rejected')">ปฏิเสธ</button></div></td></tr>`).join('')
        : '<tr><td colspan="4" style="text-align:center;color:var(--ink4);padding:32px">ไม่มี seller รออนุมัติ</td></tr>';

      document.getElementById('users-tbody').innerHTML = users.map(u => `<tr><td style="font-weight:500">${u.name}</td><td style="color:var(--ink3)">${u.email}</td><td><span class="badge badge-${u.role}">${u.role}</span></td><td><span class="badge badge-${u.status}">${u.status}</span></td><td><div class="action-row">${u.role === 'seller' && u.status === 'pending' ? `<button class="btn success" onclick="setStatus('${u._id}','approved')">อนุมัติ</button>` : ''}${u.role !== 'admin' ? `<button class="btn danger" onclick="deleteUser('${u._id}')">ลบ</button>` : ''}</div></td></tr>`).join('');

      document.getElementById('rooms-tbody').innerHTML = rooms.length
        ? rooms.map(r => `<tr><td style="font-weight:500">${r.title}</td><td style="color:var(--ink3)">${r.house}</td><td style="color:var(--ink4)">${r.sellerName || '—'}</td><td><button class="btn danger" onclick="deleteRoom('${r._id}')">ลบ</button></td></tr>`).join('')
        : '<tr><td colspan="4" style="text-align:center;color:var(--ink4);padding:32px">ยังไม่มีห้องประมูล</td></tr>';
    }

    async function setStatus(id, status) { await fetch(`/api/admin/users/${id}/status`, { method: 'PATCH', headers: H, body: JSON.stringify({ status }) }); loadAll(); }
    async function deleteUser(id) { if (!confirm('ลบ user นี้?')) return; await fetch(`/api/admin/users/${id}`, { method: 'DELETE', headers: H }); loadAll(); }
    async function deleteRoom(id) { if (!confirm('ลบห้องประมูลนี้?')) return; await fetch(`/api/admin/rooms/${id}`, { method: 'DELETE', headers: H }); loadAll(); }

    function switchTab(name) {
      const names = ['sellers', 'users', 'rooms'];
      document.querySelectorAll('.page-tab').forEach((t, i) => t.classList.toggle('active', names[i] === name));
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      document.getElementById('tab-' + name).classList.add('active');
    }
    loadAll();
  </script>
</body>

</html>
```

---

## 13. BidHod/public/create-room.html

```html
<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bidmai — สร้างห้องประมูล</title>
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
<style>
body{background:var(--bg2)}
.card{background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);padding:20px;margin-bottom:14px}
.card-title{font-size:10px;letter-spacing:2px;color:var(--ink4);text-transform:uppercase;margin-bottom:16px;font-weight:500}

/* ── Cover image upload ── */
.cover-upload{border:2px dashed var(--line2);border-radius:var(--radius);padding:32px;text-align:center;cursor:pointer;transition:all .15s;background:var(--bg2);position:relative}
.cover-upload:hover{border-color:var(--ink2);background:var(--bg3)}
.cover-upload.has-img{padding:0;border-style:solid;border-color:var(--line);overflow:hidden}
.cover-upload img{width:100%;max-height:320px;object-fit:contain;background:var(--bg2);display:block}
.cover-upload-icon{font-size:36px;margin-bottom:8px}
.cover-upload-label{font-size:13px;color:var(--ink2);font-weight:500;margin-bottom:4px}
.cover-upload-hint{font-size:11px;color:var(--ink4)}
.cover-change-btn{display:block;padding:8px;text-align:center;font-size:12px;color:var(--ink4);cursor:pointer;border-top:1px solid var(--line);background:var(--bg);transition:background .15s}
.cover-change-btn:hover{background:var(--bg2);color:var(--ink)}

/* ── Lot count & default price ── */
.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}

/* ── Lot table ── */
.lot-table-wrap{overflow-x:auto}
table.lot-table{width:100%;border-collapse:collapse;font-size:13px}
table.lot-table th{text-align:left;padding:8px 10px;font-size:10px;letter-spacing:1px;color:var(--ink4);text-transform:uppercase;border-bottom:1px solid var(--line);font-weight:500;white-space:nowrap}
table.lot-table td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
table.lot-table tr:last-child td{border-bottom:none}
table.lot-table tr:hover td{background:var(--bg2)}
.lot-num-cell{font-size:12px;font-weight:500;color:var(--ink2);width:50px;text-align:center}
.lot-price-input{width:100%;padding:6px 8px;font-size:12px;font-family:inherit;background:var(--bg);border:1px solid var(--line2);border-radius:var(--radius-sm);color:var(--ink);outline:none;transition:border-color .15s}
.lot-price-input:focus{border-color:var(--ink2)}
.lot-dur-input{width:70px;padding:6px 8px;font-size:12px;font-family:inherit;background:var(--bg);border:1px solid var(--line2);border-radius:var(--radius-sm);color:var(--ink);outline:none}
.lot-desc-input{width:100%;padding:6px 8px;font-size:12px;font-family:inherit;background:var(--bg);border:1px solid var(--line2);border-radius:var(--radius-sm);color:var(--ink);outline:none}

/* ── Bulk actions ── */
.bulk-row{display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.bulk-label{font-size:12px;color:var(--ink3)}
.bulk-input{padding:6px 10px;font-size:12px;font-family:inherit;background:var(--bg);border:1px solid var(--line2);border-radius:var(--radius-sm);color:var(--ink);outline:none;width:120px}
.bulk-input:focus{border-color:var(--ink2)}

/* ── Spinner ── */
.spinner{display:none;font-size:11px;color:var(--ink4);margin-top:6px}
.spinner.show{display:block}
</style>
</head>
<body>
<nav>
  <div style="display:flex;align-items:center;gap:12px">
    <a href="/" style="font-size:12px;color:var(--ink3)">← กลับ</a>
    <div class="logo">Bidmai</div>
  </div>
</nav>

<div class="container-narrow">
  <div class="page-label">Seller</div>
  <h1>สร้างห้องประมูล</h1>

  <!-- ข้อมูลห้อง -->
  <div class="card">
    <div class="card-title">ข้อมูลห้องประมูล</div>
    <div class="field"><label>ชื่อห้องประมูล</label><input id="room-title" type="text" placeholder="เช่น การ์ด Cardfight!! Vanguard Batch มีนา 2026"></div>
    <div class="field"><label>ชื่อ House / เจ้าของ</label><input id="room-house" type="text" placeholder="เช่น ร้าน CardShop TH"></div>
  </div>

  <!-- รูปหลัก -->
  <div class="card">
    <div class="card-title">รูปสินค้า (1 รูป ใช้กับทุกเบอร์)</div>
    <div class="cover-upload" id="cover-upload" onclick="document.getElementById('cover-input').click()">
      <div class="cover-upload-icon">🖼</div>
      <div class="cover-upload-label">คลิกเพื่ออัปโหลดรูป</div>
      <div class="cover-upload-hint">JPG, PNG, WEBP ขนาดไม่เกิน 5MB<br>ใช้รูปที่มีทุกชิ้นอยู่ในรูปเดียว</div>
    </div>
    <input type="file" id="cover-input" accept="image/*" style="display:none" onchange="uploadCover(this)">
    <div class="spinner" id="cover-spinner">⏳ กำลังอัปโหลด...</div>
    <input type="hidden" id="cover-img">
  </div>

  <!-- ตั้งค่าเบอร์ -->
  <div class="card">
    <div class="card-title">ตั้งค่าเบอร์และราคา</div>
    <div class="row3" style="margin-bottom:14px">
      <div class="field" style="margin:0">
        <label>จำนวนเบอร์ทั้งหมด</label>
        <input id="lot-count" type="number" min="1" max="200" placeholder="เช่น 12" oninput="generateTable()">
      </div>
      <div class="field" style="margin:0">
        <label>เบอร์เริ่มต้น</label>
        <input id="lot-start" type="number" min="1" value="1" oninput="generateTable()">
      </div>
      <div class="field" style="margin:0">
        <label>ระยะเวลา (นาที)</label>
        <input id="default-dur" type="number" value="30" oninput="applyDefaultDur()">
      </div>
    </div>
    <div class="row2" style="margin-bottom:14px">
      <div class="field" style="margin:0">
        <label>ต่อเวลา Anti-snipe (วินาที)</label>
        <input id="snipe-ext" type="number" min="0" placeholder="เช่น 30 (ไม่กรอก = ไม่ต่อเวลา)">
      </div>
    </div>

    <!-- Range price -->
    <div style="margin-bottom:12px">
      <div style="font-size:11px;letter-spacing:1px;color:var(--ink4);text-transform:uppercase;margin-bottom:8px;font-weight:500">กำหนดราคาเป็นกลุ่ม</div>
      <div class="bulk-row" id="range-rows">
        <div class="range-row" id="rr-0" style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap">
          <span class="bulk-label">เบอร์</span>
          <input class="bulk-input" style="width:70px" type="number" placeholder="จาก" id="rf-0" min="1">
          <span class="bulk-label">ถึง</span>
          <input class="bulk-input" style="width:70px" type="number" placeholder="ถึง" id="rt-0" min="1">
          <span class="bulk-label">ราคาเริ่ม ฿</span>
          <input class="bulk-input" style="width:110px" type="number" placeholder="ราคา" id="rp-0">
          <span class="bulk-label">BIN ฿</span>
          <input class="bulk-input" style="width:110px" type="number" placeholder="ไม่บังคับ" id="rb-0">
          <button class="btn" onclick="applyRange(0)">ใช้ราคานี้</button>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn" onclick="addRangeRow()">+ เพิ่มกลุ่ม</button>
        <button class="btn" onclick="clearAllPrices()" style="color:var(--ink4)">ล้างราคาทั้งหมด</button>
      </div>
    </div>

    <!-- Lot table -->
    <div class="lot-table-wrap" id="lot-table-wrap">
      <div style="text-align:center;padding:24px;font-size:13px;color:var(--ink4)">
        กรอกจำนวนเบอร์ด้านบนเพื่อสร้างตาราง
      </div>
    </div>
  </div>

  <button class="btn primary btn-full" onclick="createRoom()">สร้างห้องประมูล</button>
  <div class="msg" id="msg"></div>
  <div style="height:40px"></div>
</div>

<script>
const user = JSON.parse(localStorage.getItem('user') || 'null');
const token = localStorage.getItem('token');
if (!token || !user || !['admin','seller'].includes(user.role))
  location.href = '/login.html?redirect=/create-room.html';

let coverUrl = '';
let tableGenerated = false;

// ── Upload cover ─────────────────────────────
async function uploadCover(input) {
  const file = input.files[0];
  if (!file) return;
  const spinner = document.getElementById('cover-spinner');
  spinner.classList.add('show');
  try {
    const fd = new FormData();
    fd.append('image', file);
    const r = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: fd
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    coverUrl = d.url;
    document.getElementById('cover-img').value = d.url;

    const area = document.getElementById('cover-upload');
    area.classList.add('has-img');
    area.onclick = null;
    area.innerHTML = `
      <img src="${d.url}" alt="cover">
      <div class="cover-change-btn" onclick="document.getElementById('cover-input').click()">
        🔄 เปลี่ยนรูป
      </div>`;
  } catch(e) {
    showMsg(e.message || 'อัปโหลดไม่สำเร็จ', 'err');
  } finally {
    spinner.classList.remove('show');
  }
}

// ── Generate lot table ────────────────────────
function generateTable() {
  const count = parseInt(document.getElementById('lot-count').value) || 0;
  const start = parseInt(document.getElementById('lot-start').value) || 1;
  const defPrice = '';
  const defDur = document.getElementById('default-dur').value || 30;
  const wrap = document.getElementById('lot-table-wrap');

  if (!count || count < 1) {
    wrap.innerHTML = '<div style="text-align:center;padding:24px;font-size:13px;color:var(--ink4)">กรอกจำนวนเบอร์ด้านบนเพื่อสร้างตาราง</div>';
    return;
  }
  if (count > 200) {
    showMsg('จำนวนเบอร์สูงสุด 200 เบอร์', 'err');
    return;
  }

  const rows = Array.from({ length: count }, (_, i) => {
    const num = start + i;
    return `<tr>
      <td class="lot-num-cell">${num}</td>
      <td><input class="lot-price-input" id="p-${num}" type="number" placeholder="ราคาเริ่มต้น (฿)" value="${defPrice || ''}"></td>
      <td><input class="lot-price-input" id="bin-${num}" type="number" placeholder="ไม่บังคับ"></td>
      <td><input class="lot-desc-input" id="d-${num}" type="text" placeholder="หมายเหตุ (ถ้ามี)"></td>
      <td><input class="lot-dur-input" id="dur-${num}" type="number" value="${defDur}" min="1"></td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `<table class="lot-table">
    <thead><tr>
      <th style="text-align:center">เบอร์</th>
      <th>ราคาเริ่มต้น (฿)</th>
      <th>ราคาปิด BIN (฿)</th>
      <th>หมายเหตุ</th>
      <th>เวลา (นาที)</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
  tableGenerated = true;
}

// ── Bulk actions ──────────────────────────────
let rangeCount = 1;

function addRangeRow() {
  const id = rangeCount++;
  const div = document.createElement('div');
  div.className = 'range-row';
  div.id = 'rr-' + id;
  div.style = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap';
  div.innerHTML = `
    <span class="bulk-label">เบอร์</span>
    <input class="bulk-input" style="width:70px" type="number" placeholder="จาก" id="rf-${id}" min="1">
    <span class="bulk-label">ถึง</span>
    <input class="bulk-input" style="width:70px" type="number" placeholder="ถึง" id="rt-${id}" min="1">
    <span class="bulk-label">ราคาเริ่ม ฿</span>
    <input class="bulk-input" style="width:110px" type="number" placeholder="ราคา" id="rp-${id}">
    <span class="bulk-label">BIN ฿</span>
    <input class="bulk-input" style="width:110px" type="number" placeholder="ไม่บังคับ" id="rb-${id}">
    <button class="btn" onclick="applyRange(${id})">ใช้ราคานี้</button>
    <button class="btn" onclick="removeRange(${id})" style="color:var(--red);border-color:rgba(209,48,48,.2)">✕</button>
  `;
  document.getElementById('range-rows').appendChild(div);
}

function removeRange(id) {
  document.getElementById('rr-' + id)?.remove();
}

function applyRange(id) {
  const from  = parseInt(document.getElementById('rf-' + id)?.value);
  const to    = parseInt(document.getElementById('rt-' + id)?.value);
  const price = document.getElementById('rp-' + id)?.value;
  const bin   = document.getElementById('rb-' + id)?.value;
  if (!from || !to || !price) return;
  if (from > to) return showMsg('เบอร์เริ่มต้นต้องน้อยกว่าเบอร์สุดท้าย', 'err');
  for (let n = from; n <= to; n++) {
    const ep = document.getElementById('p-' + n);
    if (ep) ep.value = price;
    const eb = document.getElementById('bin-' + n);
    if (eb) eb.value = bin || '';
  }
}

function applyDefaultDur() {
  const dur = document.getElementById('default-dur').value;
  document.querySelectorAll('[id^="dur-"]').forEach(el => el.value = dur);
}

function clearAllPrices() {
  document.querySelectorAll('[id^="p-"]').forEach(el => el.value = '');
  document.querySelectorAll('[id^="bin-"]').forEach(el => el.value = '');
}

// ── Create room ───────────────────────────────
async function createRoom() {
  const title = document.getElementById('room-title').value.trim();
  const house = document.getElementById('room-house').value.trim();
  if (!title || !house) return showMsg('กรุณากรอกชื่อห้องและ house', 'err');
  if (!tableGenerated) return showMsg('กรุณากรอกจำนวนเบอร์', 'err');

  const count = parseInt(document.getElementById('lot-count').value) || 0;
  const start = parseInt(document.getElementById('lot-start').value) || 1;
  const img = document.getElementById('cover-img').value;

  const lots = [];
  for (let i = 0; i < count; i++) {
    const num = start + i;
    const price = parseInt(document.getElementById('p-' + num)?.value) || 0;
    const bin = parseInt(document.getElementById('bin-' + num)?.value) || null;
    const desc = document.getElementById('d-' + num)?.value.trim() || '';
    const dur = parseInt(document.getElementById('dur-' + num)?.value) || 30;
    lots.push({
      name: String(num),
      desc,
      image: img,
      startingPrice: price,
      binPrice: bin,
      durationMin: dur,
    });
  }

  if (!lots.length) return showMsg('ไม่พบรายการ', 'err');

  const snipeExt     = parseInt(document.getElementById('snipe-ext').value) || 0;
  const snipeTrigger = snipeExt; // trigger = ค่าเดียวกับ ext

  try {
    showMsg('กำลังสร้างห้อง...', 'ok');
    const r = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ title, house, lots, snipeExt, snipeTrigger })
    });
    const d = await r.json();
    if (!r.ok) return showMsg(d.error, 'err');
    showMsg('สร้างสำเร็จ! กำลังพาไป...', 'ok');
    setTimeout(() => location.href = '/room.html?id=' + d.roomId, 1200);
  } catch { showMsg('เกิดข้อผิดพลาด', 'err'); }
}

function showMsg(text, type) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.className = 'msg ' + type;
}
</script>
</body>
</html>
```

---

## 14. BidHod/public/messages.html

```html
<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Messages — Bidmai</title>
<link rel="stylesheet" href="/style.css" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .msg-layout { display: grid; grid-template-columns: 320px 1fr; height: calc(100vh - 60px); overflow: hidden; }
  .sidebar { border-right: 1px solid #e5e5e5; display: flex; flex-direction: column; overflow: hidden; }
  .sidebar-header { padding: 20px 16px 12px; border-bottom: 1px solid #e5e5e5; }
  .sidebar-header h2 { font-size: 18px; font-weight: 600; color: #111; }
  .search-box { margin-top: 10px; position: relative; }
  .search-box input { width: 100%; padding: 8px 12px 8px 36px; border: 1px solid #e0e0e0; border-radius: 20px; font-size: 13px; background: #f7f7f7; outline: none; transition: border 0.2s; }
  .search-box input:focus { border-color: #4f46e5; background: #fff; }
  .search-box .search-icon { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: #aaa; font-size: 15px; }
  .conv-list { flex: 1; overflow-y: auto; }
  .conv-item { display: flex; align-items: center; gap: 12px; padding: 12px 16px; cursor: pointer; transition: background 0.15s; border-bottom: 1px solid #f3f3f3; }
  .conv-item:hover, .conv-item.active { background: #f0efff; }
  .conv-item.active { border-left: 3px solid #4f46e5; }
  .avatar { width: 44px; height: 44px; border-radius: 50%; background: #e0e7ff; color: #4f46e5; font-weight: 600; font-size: 15px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .conv-info { flex: 1; min-width: 0; }
  .conv-name { font-size: 14px; font-weight: 600; color: #111; display: flex; align-items: center; justify-content: space-between; }
  .conv-time { font-size: 11px; color: #aaa; font-weight: 400; }
  .conv-preview { font-size: 12px; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; display: flex; align-items: center; justify-content: space-between; }
  .unread-badge { background: #4f46e5; color: #fff; border-radius: 999px; font-size: 11px; font-weight: 600; padding: 1px 7px; min-width: 20px; text-align: center; flex-shrink: 0; }
  .conv-empty { padding: 40px 16px; text-align: center; color: #aaa; font-size: 13px; }
  .chat-area { display: flex; flex-direction: column; overflow: hidden; }
  .chat-header { padding: 14px 20px 14px 56px; position: relative; border-bottom: 1px solid #e5e5e5; display: flex; align-items: center; gap: 12px; background: #fff; }
  .chat-header .avatar { width: 38px; height: 38px; font-size: 13px; }
  .chat-header-info h3 { font-size: 15px; font-weight: 600; color: #111; }
  .back-btn { position: absolute; left: 14px; top: 8px; background: transparent; border: none; color: var(--ink); font-size: 14px; cursor: pointer; padding: 6px 8px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; z-index: 10; }
  .back-btn:hover { background: rgba(79,70,229,0.06); color: #4f46e5; }
  #navbar-back-btn { position: absolute; left: 12px; top: 10px; background: transparent; border: none; font-size: 14px; cursor: pointer; padding: 6px 8px; border-radius: 6px; display: none; align-items: center; z-index: 50; }
  #navbar-back-btn.show { display: inline-flex; background: rgba(79,70,229,0.06); color: #4f46e5; }
  .messages-container { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; background: #fafafa; }
  .msg-row { display: flex; align-items: flex-end; gap: 8px; }
  .msg-row.me { flex-direction: row-reverse; }
  .msg-avatar { width: 28px; height: 28px; border-radius: 50%; background: #e0e7ff; color: #4f46e5; font-size: 11px; font-weight: 600; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .msg-row.me .msg-avatar { background: #4f46e5; color: #fff; }
  .bubble { display: inline-block; width: auto; max-width: 150%; min-width: 160px; max-height: 80px; padding: 5px 14px; border-radius: 18px; font-size: 16px; line-height: 1.5; position: relative; white-space: pre-line; overflow-wrap: break-word; word-wrap: break-word; word-break: normal; vertical-align: top; }
  .msg-row.them .bubble { background: #fff; color: #111; border: 1px solid #e5e5e5; border-bottom-left-radius: 4px; }
  .msg-row.me .bubble { background: #4f46e5; color: #fff; border-bottom-right-radius: 4px; }
  .bubble-time { font-size: 10px; color: #bbb; margin-top: 2px; text-align: right; }
  .msg-row.me .bubble-time { color: rgba(255,255,255,0.6); }
  .date-divider { text-align: center; font-size: 11px; color: #bbb; margin: 8px 0; position: relative; }
  .date-divider::before, .date-divider::after { content: ''; position: absolute; top: 50%; width: calc(50% - 50px); height: 1px; background: #e5e5e5; }
  .date-divider::before { left: 0; }
  .date-divider::after { right: 0; }
  .chat-input-area { padding: 12px 16px; border-top: 1px solid #e5e5e5; background: #fff; display: flex; align-items: flex-end; gap: 10px; }
  .chat-input-area textarea { flex: 1; border: 1px solid #e0e0e0; border-radius: 20px; padding: 10px 16px; font-size: 14px; resize: none; outline: none; max-height: 120px; overflow-y: auto; line-height: 1.5; font-family: inherit; transition: border 0.2s; }
  .chat-input-area textarea:focus { border-color: #4f46e5; }
  .send-btn { width: 40px; height: 40px; border-radius: 50%; background: #4f46e5; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.2s, transform 0.1s; flex-shrink: 0; color: #fff; font-size: 18px; }
  .send-btn:hover { background: #4338ca; }
  .send-btn:active { transform: scale(0.94); }
  .send-btn:disabled { background: #ccc; cursor: not-allowed; }
  .chat-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #aaa; gap: 12px; background: #fafafa; }
  .chat-empty-icon { font-size: 48px; opacity: 0.3; }
  .chat-empty p { font-size: 14px; }
  @media (max-width: 640px) { .msg-layout { grid-template-columns: 1fr; } .sidebar { display: none; } .sidebar.show { display: flex; position: fixed; inset: 0; z-index: 100; background: #fff; } .chat-area { display: flex; } }
  #toast { position: fixed; bottom: 24px; right: 24px; background: #111; color: #fff; padding: 12px 18px; border-radius: 12px; font-size: 13px; opacity: 0; pointer-events: none; transition: opacity 0.3s; z-index: 999; max-width: 280px; }
  #toast.show { opacity: 1; }
</style>
</head>
<body>
<nav id="navbar"></nav>
<div class="msg-layout">
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <h2>ข้อความ</h2>
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" id="searchInput" placeholder="ค้นหาการสนทนา..." />
      </div>
    </div>
    <div class="conv-list" id="convList">
      <div class="conv-empty">กำลังโหลด...</div>
    </div>
  </div>
  <div class="chat-area" id="chatArea">
    <div class="chat-empty" id="chatEmpty">
      <div class="chat-empty-icon">💬</div>
      <p>เลือกการสนทนาเพื่อเริ่มพูดคุย</p>
    </div>
  </div>
</div>
<div id="toast"></div>
<script src="/socket.io/socket.io.js"></script>
<script>
let me = null;
let socket = null;
let currentPartnerId = null;
let currentRoomId = null;
let conversations = [];
const token = localStorage.getItem('token');
if (!token) { location.href = '/login.html'; }
async function init() {
  const auth = await fetchJSON('/api/auth/me');
  me = auth.user;
  if (!me || !me.id) { localStorage.removeItem('token'); return location.href = '/login.html'; }
  socket = io();
  socket.on('connect_error', (err) => showToast(`Socket error: ${err.message}`));
  socket.on('chat:error', ({ message }) => showToast(message));
  socket.on('disconnect', () => showToast('Disconnected from server'));
  socket.emit('user:join', me.id);
  socket.on('chat:message', (msg) => {
    if ((msg.senderId === currentPartnerId && msg.receiverId === me.id) || (msg.senderId === me.id && msg.receiverId === currentPartnerId)) {
      appendMessage(msg);
      scrollToBottom();
    }
    loadConversations();
  });
  socket.on('chat:notification', ({ fromId, preview }) => {
    if (fromId !== currentPartnerId) { showToast(`ข้อความใหม่: ${preview}`); loadConversations(); }
  });
  await loadConversations();
  ensureNavbarBack();
  const params = new URLSearchParams(location.search);
  let withId = params.get('with');
  const roomId = params.get('room');
  if (roomId) { currentRoomId = roomId; }
  if (roomId && !withId) {
    try { const roomData = await fetchJSON(`/api/rooms/${roomId}`); if (roomData?.sellerId) { withId = roomData.sellerId; } }
    catch (err) { console.error('Cannot resolve room:', err); }
  }
  if (withId === 'admin') {
    try { const adminPayload = await fetchJSON('/api/messages/admin'); withId = adminPayload.admin?._id; }
    catch (err) { showToast('ไม่สามารถติดต่อ admin ได้'); }
  }
  if (withId) { openChat(withId, roomId ? true : false); }
}
async function loadConversations() {
  const data = await fetchJSON('/api/messages/conversations');
  conversations = data;
  renderConversations(data);
}
function renderConversations(list) {
  const el = document.getElementById('convList');
  if (!list.length) { el.innerHTML = '<div class="conv-empty">ยังไม่มีการสนทนา</div>'; return; }
  const q = document.getElementById('searchInput').value.toLowerCase();
  const filtered = q ? list.filter(c => { const name = (c.partner?.name || '').toLowerCase(); const email = (c.partner?.email || '').toLowerCase(); return name.includes(q) || email.includes(q); }) : list;
  el.innerHTML = filtered.map(c => {
    const partnerName = c.partner?.name || 'ไม่ทราบ';
    const partnerId = c.partner?._id || '';
    return `<div class="conv-item ${partnerId === currentPartnerId ? 'active' : ''}" onclick="openChat('${partnerId}')"><div class="avatar">${initials(partnerName)}</div><div class="conv-info"><div class="conv-name"><span>${esc(partnerName)}</span><span class="conv-time">${relativeTime(c.lastMessage.createdAt)}</span></div><div class="conv-preview"><span>${c.lastMessage.senderId === me.id ? 'คุณ: ' : ''}${esc(c.lastMessage.text.substring(0, 40))}</span>${c.unread > 0 ? `<span class="unread-badge">${c.unread}</span>` : ''}</div></div></div>`;
  }).join('');
}
document.getElementById('searchInput').addEventListener('input', () => { renderConversations(conversations); });
async function openChat(partnerId, preserveRoomContext = false) {
  if (!partnerId) { showToast('ไม่พบผู้ใช้สำหรับการสนทนานี้'); return; }
  if (currentPartnerId) { socket.emit('chat:leave', { myId: me.id, otherId: currentPartnerId }); }
  if (!preserveRoomContext) { currentRoomId = null; }
  currentPartnerId = partnerId;
  const historyUrl = currentRoomId ? `?room=${currentRoomId}&with=${partnerId}` : `?with=${partnerId}`;
  history.replaceState(null, '', historyUrl);
  document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.conv-item').forEach(el => { if (el.onclick.toString().includes(partnerId)) el.classList.add('active'); });
  const chatArea = document.getElementById('chatArea');
  chatArea.innerHTML = `<div class="chat-header" id="chatHeader"><div class="avatar" id="partnerAvatar">...</div><div class="chat-header-info"><h3 id="partnerName">กำลังโหลด...</h3></div></div><div class="messages-container" id="messagesContainer"></div><div class="chat-input-area"><textarea id="msgInput" placeholder="พิมพ์ข้อความ..." rows="1" onkeydown="handleKey(event)"></textarea><button class="send-btn" onclick="sendMessage()" id="sendBtn">➤</button></div>`;
  let messages = [];
  let otherUser = null;
  try {
    ({ messages, otherUser } = await fetchJSON(`/api/messages/${partnerId}`));
    if (!otherUser || !otherUser.name) { throw new Error('ไม่พบผู้ใช้ปลายทาง'); }
  } catch (err) {
    showToast(err.message || 'ไม่สามารถโหลดการสนทนาได้');
    currentPartnerId = null;
    history.replaceState(null, '', location.pathname);
    showNavbarBack(false);
    chatArea.innerHTML = `<div class="chat-empty" id="chatEmpty"><div class="chat-empty-icon">💬</div><p>ไม่สามารถโหลดการสนทนาได้ โปรดลองอีกครั้ง</p></div>`;
    renderConversations(conversations);
    return;
  }
  socket.emit('chat:join', { myId: me.id, otherId: partnerId });
  document.getElementById('partnerAvatar').textContent = initials(otherUser.name);
  document.getElementById('partnerName').textContent = otherUser.name;
  showNavbarBack(true);
  const container = document.getElementById('messagesContainer');
  container.innerHTML = '';
  if (!messages.length) {
    container.innerHTML = '<div style="text-align:center;color:#ccc;font-size:13px;margin-top:40px;">เริ่มการสนทนา 👋</div>';
  } else {
    let lastDate = null;
    for (const msg of messages) {
      const d = new Date(msg.createdAt).toLocaleDateString('th-TH');
      if (d !== lastDate) { container.innerHTML += `<div class="date-divider">${d}</div>`; lastDate = d; }
      container.innerHTML += renderBubble(msg);
    }
  }
  scrollToBottom();
  const ta = document.getElementById('msgInput');
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; });
  loadConversations();
}
async function sendMessage() {
  const ta = document.getElementById('msgInput');
  const text = ta.value.trim();
  if (!text || !currentPartnerId) return;
  try {
    const payload = { text };
    if (currentRoomId) { payload.roomId = currentRoomId; }
    await fetchJSON(`/api/messages/${currentPartnerId}`, { method: 'POST', body: JSON.stringify(payload) });
    scrollToBottom();
    loadConversations();
  } catch (err) { showToast('ไม่สามารถส่งข้อความได้'); }
  ta.value = '';
  ta.style.height = 'auto';
}
function handleKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }
function goBack() { if (currentRoomId) { window.location.href = `/room.html?id=${currentRoomId}`; return; } if (window.history.length > 1) { window.history.back(); } else { window.location.href = '/'; } }
function ensureNavbarBack() { const nav = document.getElementById('navbar'); if (!nav) return null; let btn = document.getElementById('navbar-back-btn'); if (!btn) { btn = document.createElement('button'); btn.id = 'navbar-back-btn'; btn.textContent = '← ย้อนกลับ'; btn.addEventListener('click', goBack); nav.appendChild(btn); } return btn; }
function showNavbarBack(show) { const btn = ensureNavbarBack(); if (!btn) return; if (show) btn.classList.add('show'); else btn.classList.remove('show'); }
function renderBubble(msg) {
  const isMe = msg.senderId === me.id;
  const time = new Date(msg.createdAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  const text = String(msg.text || '');
  const minPx = 80;
  const maxPx = Math.floor(window.innerWidth * 0.6);
  const perChar = 8;
  const lines = text.split(/\r?\n/).length;
  const estimated = Math.round(text.length * perChar / Math.max(1, lines));
  const width = Math.min(maxPx, Math.max(minPx, estimated + (lines > 1 ? 20 : 0)));
  return `<div class="msg-row ${isMe ? 'me' : 'them'}" data-msgid="${msg._id}"><div class="msg-avatar">${isMe ? initials(me.name) : '?'}</div><div><div class="bubble" style="width: ${width}px">${esc(msg.text)}<div class="bubble-time">${time}</div></div></div></div>`;
}
function appendMessage(msg) { const container = document.getElementById('messagesContainer'); if (!container) return; if (container.querySelector(`[data-msgid="${msg._id}"]`)) return; const placeholder = container.querySelector('[style*="เริ่มการสนทนา"]'); if (placeholder) placeholder.remove(); container.insertAdjacentHTML('beforeend', renderBubble(msg)); }
function scrollToBottom() { const c = document.getElementById('messagesContainer'); if (c) c.scrollTop = c.scrollHeight; }
function initials(name = '') { return name.split(' ').map(w => w[0]).join('').toUpperCase().substring(0, 2) || '?'; }
function esc(str = '') { return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function relativeTime(ts) { const diff = Date.now() - ts; const m = Math.floor(diff / 60000); if (m < 1) return 'เมื่อกี้'; if (m < 60) return `${m} นาที`; const h = Math.floor(m / 60); if (h < 24) return `${h} ชั่วโมง`; const d = Math.floor(h / 24); return `${d} วัน`; }
async function fetchJSON(url, options = {}) { const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers }, ...options }); if (!res.ok) { const payload = await res.text(); throw new Error(`HTTP ${res.status}: ${payload}`); } return res.json(); }
function showToast(msg) { const el = document.getElementById('toast'); el.textContent = msg; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 3500); }
init().catch(console.error);
</script>
</body>
</html>
```

---

## 15. BidHod/public/room.html

```html
<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bidmai — Auction Room</title>
  <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/style.css">
  <script src="/socket.io/socket.io.js"></script>
  <style>
    .room-header { padding: 14px 20px 0; border-bottom: 1px solid var(--line) }
    .room-house { font-size: 11px; color: var(--ink4); letter-spacing: 1px; text-transform: uppercase; margin-bottom: 3px }
    .room-title { font-size: 16px; font-weight: 500; color: var(--ink); margin-bottom: 12px }
    .layout { display: grid; grid-template-columns: 1fr 280px; min-height: calc(100vh - 148px) }
    .main { padding: 20px; border-right: 1px solid var(--line) }
    .lot-thumb { width: 100%; max-height: 340px; aspect-ratio: 16/9; background: var(--bg2); border: 1px solid var(--line); border-radius: var(--radius); display: flex; align-items: center; justify-content: center; font-size: 56px; margin-bottom: 16px; overflow: hidden }
    .lot-badge-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px }
    .lot-num-label { font-size: 10px; letter-spacing: 2px; color: var(--ink4); text-transform: uppercase }
    .lot-name { font-size: 16px; font-weight: 500; color: var(--ink); line-height: 1.4; margin-bottom: 5px }
    .lot-desc { font-size: 12px; color: var(--ink3); line-height: 1.7; margin-bottom: 16px }
    .sidebar { padding: 16px; display: flex; flex-direction: column; gap: 10px; background: var(--bg2) }
    .price-big { font-size: 24px; font-weight: 500; color: var(--ink); transition: color .3s }
    .price-leader { font-size: 11px; color: var(--ink4); margin-top: 3px }
    .price-leader span { color: var(--green); font-weight: 500 }
    .ended-block { background: var(--bg2); border: 1px solid var(--line); border-radius: var(--radius); padding: 20px; text-align: center }
    .ended-title { font-size: 18px; font-weight: 500; color: var(--ink); margin-bottom: 6px }
    .ended-sub { font-size: 13px; color: var(--ink3) }
    .ended-sub strong { color: var(--green) }
    .login-prompt { width: 100%; padding: 10px; font-size: 13px; font-family: inherit; background: var(--bg); border: 1px solid var(--line2); border-radius: var(--radius-sm); color: var(--ink); cursor: pointer; transition: background .15s; text-align: center }
    .login-prompt:hover { background: var(--bg2) }
    .bid-error { font-size: 12px; color: var(--red); min-height: 16px; margin-top: 4px }
    .h-list { display: flex; flex-direction: column; max-height: 180px; overflow-y: auto }
    .bin-btn { width: 100%; padding: 10px; margin-top: 8px; font-size: 13px; font-family: inherit; font-weight: 500; background: var(--green, #16a34a); color: #fff; border: none; border-radius: var(--radius-sm); cursor: pointer; transition: opacity .15s; }
    .bin-btn:hover { opacity: .85; }
    .bin-price-hint { font-size: 11px; color: var(--ink4); text-align: center; margin-top: 4px; }
    @media(max-width:680px) { .layout { grid-template-columns: 1fr } }
  </style>
</head>
<body>
  <nav>
    <div style="display:flex;align-items:center;gap:12px">
      <a href="/" style="font-size:12px;color:var(--ink3)">← กลับ</a>
      <div class="logo">Bidmai</div>
    </div>
    <div style="display:flex;align-items:center;gap:10px">
      <div class="live-pill"><div class="live-dot"></div>Live</div>
      <span style="font-size:12px;color:var(--ink4)"><span id="viewer-count">0</span> คน</span>
      <span style="font-size:12px;color:var(--ink3)" id="nav-user"></span>
      <a href="/messages.html" style="font-size:13px;color:var(--ink3);text-decoration:none;position:relative" id="msg-btn">💬<span id="msg-badge" style="display:none;position:absolute;top:-4px;right:-6px;background:#ef4444;color:#fff;border-radius:999px;font-size:9px;padding:1px 4px;font-weight:600">!</span></a>
    </div>
  </nav>
  <div class="room-header">
    <div class="room-house" id="room-house">กำลังโหลด...</div>
    <div class="room-title" id="room-title"></div>
    <div class="lot-tabs" id="lot-tabs"></div>
  </div>
  <div class="layout">
    <div class="main" id="main"></div>
    <div class="sidebar">
      <div class="s-block">
        <div class="s-block-label">เวลาที่เหลือ</div>
        <div class="timer-val" id="timer">--:--</div>
        <div class="timer-bar-wrap"><div class="timer-bar" id="timer-bar" style="width:100%"></div></div>
      </div>
      <div class="notice" id="ext-notice">⏱ ขยายเวลาเพิ่ม 30 วินาที!</div>
      <div class="s-block">
        <div class="s-block-label">ราคาปัจจุบัน</div>
        <div class="price-big" id="price-val">฿—</div>
        <div class="price-leader" id="price-leader">ยังไม่มีการประมูล</div>
      </div>
      <div id="bid-section"></div>
      <div class="s-block">
        <div class="s-block-label">ประวัติ</div>
        <div class="h-list" id="history-list"><div class="h-empty">ยังไม่มีการประมูล</div></div>
      </div>
      <div class="viewer-row"><div class="viewer-dot"></div><span id="viewer-count2">0</span> คนดูอยู่</div>
    </div>
  </div>
  <script>
    const ROOM_ID = new URLSearchParams(location.search).get('id');
    if (!ROOM_ID) location.href = '/';
    const token = localStorage.getItem('token');
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    if (user) document.getElementById('nav-user').textContent = user.name;
    const socket = io({ auth: { token: token || '' } });
    let roomData = null, activeLotId = null;
    const LOT_DUR = 30 * 60 * 1000;
    socket.on('connect', () => socket.emit('room:join', ROOM_ID));
    socket.on('room:init', d => { roomData = d; document.getElementById('room-house').textContent = d.house; document.getElementById('room-title').textContent = d.title; renderTabs(d.lots); const first = d.lots.find(l => l.isActive) || d.lots[0]; if (first) switchLot(first._id); });
    socket.on('room:viewers', ({ count }) => { document.getElementById('viewer-count').textContent = count; document.getElementById('viewer-count2').textContent = count; });
    socket.on('bid:new', ({ lotId, bid, currentPrice, highestBidder }) => { const lot = roomData?.lots.find(l => l._id === lotId); if (lot) { lot.currentPrice = currentPrice; lot.highestBidder = highestBidder; lot.bids.unshift(bid); } if (lotId === activeLotId) { updatePrice(currentPrice, highestBidder); updateQuickBids(currentPrice); prependHistory(bid); flashPrice(); updateStats(); } });
    socket.on('lot:tick', ({ lotId, timeLeft }) => { if (lotId === activeLotId) renderTimer(timeLeft); });
    socket.on('lot:extended', ({ lotId }) => { if (lotId !== activeLotId) return; const n = document.getElementById('ext-notice'); n.classList.add('show'); setTimeout(() => n.classList.remove('show'), 4000); });
    socket.on('lot:ended', ({ lotId, winner, finalPrice }) => { const lot = roomData?.lots.find(l => l._id === lotId); if (lot) lot.isActive = false; renderTabs(roomData?.lots || []); if (lotId === activeLotId) showEnded(winner, finalPrice); });
    socket.on('bid:error', ({ message }) => showError(message));
    function renderTabs(lots) { document.getElementById('lot-tabs').innerHTML = lots.map(l => `<div class="lot-tab${l._id === activeLotId ? ' active' : ''}" onclick="switchLot('${l._id}')"><span class="dot"></span>Lot ${l.num}</div>`).join(''); }
    function switchLot(lotId) {
      activeLotId = lotId;
      const lot = roomData?.lots.find(l => l._id === lotId);
      if (!lot) return;
      renderTabs(roomData.lots);
      document.getElementById('main').innerHTML = `<div class="lot-thumb">${lot.image ? `<img src="${lot.image}" alt="${lot.name}">` : lotIcon(lot.name)}</div><div class="lot-badge-row"><span class="lot-num-label">Lot ${String(lot.num).padStart(3, '0')}</span><span class="badge ${lot.isActive ? 'badge-live' : 'badge-ended'}">${lot.isActive ? '● กำลัง Live' : 'สิ้นสุดแล้ว'}</span></div><div class="lot-name">${lot.name}</div><div class="lot-desc">${lot.desc || ''}</div>${roomData.sellerId ? `<a href="/messages.html?room=${roomData._id}&with=${roomData.sellerId}" style="display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--ink3);text-decoration:none;margin-bottom:16px;padding:6px 12px;border:1px solid var(--line);border-radius:var(--radius-sm)">💬 ติดต่อ Seller</a>` : ''}<div class="stat-grid"><div class="stat-box"><div class="stat-label">ราคาปัจจุบัน</div><div class="stat-val" id="s-price">฿${lot.currentPrice.toLocaleString()}</div></div><div class="stat-box"><div class="stat-label">Bids</div><div class="stat-val muted" id="s-bids">${lot.bids?.length || 0}</div></div><div class="stat-box"><div class="stat-label">ผู้นำ</div><div class="stat-val muted" id="s-leader">${lot.highestBidder ? mask(lot.highestBidder) : '—'}</div></div></div>`;
      updatePrice(lot.currentPrice, lot.highestBidder);
      updateQuickBids(lot.currentPrice);
      renderHistoryFull(lot.bids || []);
      lot.isActive ? renderBidSection() : showEnded(lot.highestBidder, lot.currentPrice);
    }
    function renderBidSection() {
      const sec = document.getElementById('bid-section');
      if (!token) { sec.innerHTML = `<button class="login-prompt" onclick="location.href='/login.html?redirect=/room.html?id=${ROOM_ID}'">เข้าสู่ระบบเพื่อประมูล →</button>`; return; }
      const lot = roomData?.lots.find(l => l._id === activeLotId);
      const binHTML = lot?.binPrice ? `<button class="bin-btn" onclick="buyNow()">⚡ ซื้อทันที ฿${lot.binPrice.toLocaleString()}</button><div class="bin-price-hint">กดเพื่อปิด lot ทันที</div>` : '';
      sec.innerHTML = `<div class="s-block"><div class="s-block-label">ประมูล</div><div class="quick-grid" id="quick-grid"></div><input class="bid-amount-input" id="bid-amount" type="number" placeholder="ระบุจำนวนเงิน (฿)" style="width:100%;margin-bottom:6px"><button class="btn primary btn-full" onclick="placeBid()">ประมูลเลย</button>${binHTML}<div class="bid-error" id="bid-error"></div></div>`;
      if (lot) updateQuickBids(lot.currentPrice);
    }
    function updateQuickBids(price) { const g = document.getElementById('quick-grid'); if (!g) return; g.innerHTML = [1000, 5000, 10000, 50000].map(inc => { const val = price + inc; return `<button class="quick-btn" onclick="setAmount(${val})">+฿${inc.toLocaleString()}<br><span style="font-size:10px;color:var(--ink4)">฿${val.toLocaleString()}</span></button>`; }).join(''); }
    function setAmount(val) { const el = document.getElementById('bid-amount'); if (el) { el.value = val; const e = document.getElementById('bid-error'); if (e) e.textContent = ''; } }
    function updatePrice(price, bidder) {
      document.getElementById('price-val').textContent = '฿' + price.toLocaleString();
      const isMe = user && bidder === user.name;
      document.getElementById('price-leader').innerHTML = bidder ? `ผู้นำ: <span>${mask(bidder)}${isMe ? ' <span class="you-badge">คุณ</span>' : ''}</span>` : 'ยังไม่มีการประมูล';
      const sp = document.getElementById('s-price'); if (sp) sp.textContent = '฿' + price.toLocaleString();
    }
    function updateStats() { const lot = roomData?.lots.find(l => l._id === activeLotId); if (!lot) return; const sb = document.getElementById('s-bids'); const sl = document.getElementById('s-leader'); if (sb) sb.textContent = lot.bids?.length || 0; if (sl) sl.textContent = lot.highestBidder ? mask(lot.highestBidder) : '—'; }
    function flashPrice() { const el = document.getElementById('price-val'); el.style.color = 'var(--green)'; setTimeout(() => el.style.color = '', 500); }
    function renderTimer(ms) {
      const s = Math.max(0, Math.ceil(ms / 1000));
      const tv = document.getElementById('timer'); const tb = document.getElementById('timer-bar');
      const days = Math.floor(s / 86400);
      const hrs = Math.floor((s % 86400) / 3600);
      const min = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      if (days > 0) { tv.textContent = days + ':' + hrs.toString().padStart(2, '0') + ':' + min.toString().padStart(2, '0') + ':' + sec.toString().padStart(2, '0'); }
      else if (hrs > 0) { tv.textContent = hrs.toString().padStart(2, '0') + ':' + min.toString().padStart(2, '0') + ':' + sec.toString().padStart(2, '0'); }
      else { tv.textContent = min.toString().padStart(2, '0') + ':' + sec.toString().padStart(2, '0'); }
      tb.style.width = Math.min(100, (ms / LOT_DUR) * 100) + '%';
      const u = ms < 30000; tv.className = 'timer-val' + (u ? ' urgent' : ''); tb.className = 'timer-bar' + (u ? ' urgent' : '');
    }
    function mask(name) { if (!name || name.length < 3) return name; return name[0] + '***' + name.slice(-1); }
    function lotIcon(name) { const n = name.toLowerCase(); if (n.includes('rolex') || n.includes('patek') || n.includes('นาฬิกา')) return '⌚'; if (n.includes('nike') || n.includes('jordan')) return '👟'; if (n.includes('ภาพ') || n.includes('ศิลป')) return '🖼'; if (n.includes('hoodie') || n.includes('supreme')) return '👕'; return '📦'; }
    function prependHistory(bid) {
      const list = document.getElementById('history-list');
      const empty = list.querySelector('.h-empty'); if (empty) empty.remove();
      const isMe = user && bid.bidderName === user.name;
      const t = new Date(bid.createdAt || bid.timestamp || Date.now());
      const div = document.createElement('div'); div.className = 'h-item';
      div.innerHTML = `<div><div class="h-name">${mask(bid.bidderName)}${isMe ? '<span class="you-badge">คุณ</span>' : ''}</div><div class="h-time">${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}</div></div><div class="h-amount">฿${bid.amount.toLocaleString()}</div>`;
      list.prepend(div);
    }
    function renderHistoryFull(bids) {
      const list = document.getElementById('history-list');
      if (!bids.length) { list.innerHTML = '<div class="h-empty">ยังไม่มีการประมูล</div>'; return; }
      list.innerHTML = '';[...bids].reverse().forEach(b => prependHistory(b));
    }
    function showEnded(winner, price, isBin = false) {
      const label = isBin ? '⚡ ซื้อทันที' : 'Lot สิ้นสุดแล้ว';
      document.getElementById('bid-section').innerHTML = `<div class="ended-block"><div class="ended-title">${label}</div><div class="ended-sub">ผู้ชนะ: <strong>${winner ? mask(winner) : 'ไม่มีผู้ประมูล'}</strong><br>฿${price.toLocaleString()}</div></div>`;
      document.getElementById('timer').textContent = '00:00';
    }
    function showError(msg) { const el = document.getElementById('bid-error'); if (el) { el.textContent = msg; setTimeout(() => el.textContent = '', 3000); } }
    function placeBid() {
      const amount = parseInt(document.getElementById('bid-amount')?.value, 10);
      if (!amount || isNaN(amount)) return showError('กรุณาระบุจำนวนเงิน');
      socket.emit('bid:place', { roomId: ROOM_ID, lotId: activeLotId, amount });
      document.getElementById('bid-amount').value = '';
    }
    function buyNow() {
      const lot = roomData?.lots.find(l => l._id === activeLotId);
      if (!lot?.binPrice) return;
      if (!confirm(`ยืนยันซื้อทันที ฿${lot.binPrice.toLocaleString()}?`)) return;
      socket.emit('bin:place', { roomId: ROOM_ID, lotId: activeLotId });
    }
    socket.on('lot:bin', ({ lotId, buyerName, finalPrice }) => {
      const lot = roomData?.lots.find(l => l._id === lotId);
      if (lot) lot.isActive = false;
      renderTabs(roomData?.lots || []);
      if (lotId === activeLotId) showEnded(buyerName, finalPrice, true);
    });
    document.addEventListener('keydown', e => { if (e.key === 'Enter') placeBid(); });
    if (token && user) {
      socket.emit('user:join', user._id);
      socket.on('chat:notification', () => { document.getElementById('msg-badge').style.display = 'block'; });
    }
  </script>
</body>
</html>
```

---

## 16. BidHod/public/style.css

```css
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

:root {
  --bg: #ffffff;
  --bg2: #f8f8f7;
  --bg3: #f0f0ee;
  --ink: #141413;
  --ink2: #3d3d3b;
  --ink3: #7a7a78;
  --ink4: #b0b0ae;
  --line: rgba(0, 0, 0, 0.08);
  --line2: rgba(0, 0, 0, 0.14);
  --red: #d13030;
  --red-bg: #fdf1f1;
  --green: #1a7a4a;
  --green-bg: #f0faf4;
  --blue: #1a5fa8;
  --blue-bg: #f0f5fd;
  --radius: 6px;
  --radius-sm: 4px;
}

html,
body {
  height: 100%;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Sarabun', sans-serif;
  background: var(--bg);
  color: var(--ink);
  min-height: 100vh;
  font-size: 14px;
  line-height: 1.5;
}

a {
  text-decoration: none;
  color: inherit;
}

/* ── Nav ── */
nav {
  background: var(--bg);
  border-bottom: 1px solid var(--line);
  padding: 0 20px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: sticky;
  top: 0;
  z-index: 100;
}

.logo {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 3px;
  color: var(--ink);
  text-transform: uppercase;
}

.nav-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.nav-user {
  font-size: 12px;
  color: var(--ink3);
}

.nav-btn {
  font-size: 12px;
  font-family: inherit;
  padding: 5px 14px;
  border-radius: 20px;
  border: 1px solid var(--line2);
  background: transparent;
  color: var(--ink3);
  cursor: pointer;
  transition: all .15s;
}

.nav-btn:hover {
  background: var(--bg2);
  color: var(--ink);
}

.nav-btn.primary {
  background: var(--ink);
  color: #fff;
  border-color: transparent;
}

.nav-btn.primary:hover {
  opacity: .85;
}

.live-pill {
  display: flex;
  align-items: center;
  gap: 5px;
  background: var(--red-bg);
  border: 1px solid rgba(209, 48, 48, .2);
  border-radius: 20px;
  padding: 4px 10px;
  font-size: 11px;
  color: var(--red);
  font-weight: 500;
}

.live-dot {
  width: 6px;
  height: 6px;
  background: var(--red);
  border-radius: 50%;
  animation: blink 1.2s infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1 }
  50% { opacity: .3 }
}

/* ── Layout — full width ── */
.container {
  max-width: 100%;
  padding: 24px 28px;
}

.container-narrow {
  max-width: 680px;
  margin: 0 auto;
  padding: 24px 20px;
}

/* ── Badges ── */
.badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: .5px;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid;
}

.badge-live {
  background: var(--red-bg);
  color: var(--red);
  border-color: rgba(209, 48, 48, .2);
}

.badge-ended {
  background: var(--bg2);
  color: var(--ink4);
  border-color: var(--line);
}

.badge-soon {
  background: var(--blue-bg);
  color: var(--blue);
  border-color: rgba(26, 95, 168, .2);
}

.badge-pending {
  background: #fffbf0;
  color: #9a6800;
  border-color: rgba(154, 104, 0, .2);
}

.badge-approved {
  background: var(--green-bg);
  color: var(--green);
  border-color: rgba(26, 122, 74, .2);
}

.badge-rejected {
  background: var(--red-bg);
  color: var(--red);
  border-color: rgba(209, 48, 48, .2);
}

.badge-buyer {
  background: var(--bg2);
  color: var(--ink3);
  border-color: var(--line);
}

.badge-seller {
  background: var(--blue-bg);
  color: var(--blue);
  border-color: rgba(26, 95, 168, .2);
}

.badge-admin {
  background: var(--ink);
  color: #fff;
  border-color: transparent;
}

/* ── Form ── */
.field {
  margin-bottom: 14px;
}

.field label {
  display: block;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .5px;
  color: var(--ink3);
  text-transform: uppercase;
  margin-bottom: 5px;
}

input[type=text],
input[type=email],
input[type=password],
input[type=number],
input[type=tel],
textarea,
select {
  width: 100%;
  padding: 9px 11px;
  font-size: 13px;
  font-family: inherit;
  background: var(--bg);
  border: 1px solid var(--line2);
  border-radius: var(--radius-sm);
  color: var(--ink);
  outline: none;
  transition: border-color .15s;
  resize: vertical;
}

input:focus,
textarea:focus,
select:focus {
  border-color: var(--ink2);
}

select {
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%237a7a78' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  padding-right: 28px;
}

.btn {
  display: inline-block;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line2);
  background: var(--bg);
  color: var(--ink);
  cursor: pointer;
  transition: all .15s;
}

.btn:hover {
  background: var(--bg2);
}

.btn.primary {
  background: var(--ink);
  color: #fff;
  border-color: transparent;
}

.btn.primary:hover {
  opacity: .85;
}

.btn.danger {
  background: var(--red-bg);
  color: var(--red);
  border-color: rgba(209, 48, 48, .2);
}

.btn.success {
  background: var(--green-bg);
  color: var(--green);
  border-color: rgba(26, 122, 74, .2);
}

.btn:disabled {
  opacity: .4;
  cursor: not-allowed;
}

.btn-full {
  width: 100%;
  text-align: center;
  display: block;
  padding: 11px;
}

/* ── Stat box ── */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  background: var(--line);
  border-radius: var(--radius);
  overflow: hidden;
}

.stat-box {
  background: var(--bg2);
  padding: 12px 14px;
}

.stat-label {
  font-size: 10px;
  letter-spacing: 1px;
  color: var(--ink4);
  text-transform: uppercase;
  margin-bottom: 4px;
}

.stat-val {
  font-size: 14px;
  font-weight: 500;
  color: var(--ink);
}

.stat-val.muted {
  color: var(--ink3);
  font-size: 12px;
}

/* ── Timer ── */
.timer-val {
  font-size: 28px;
  font-weight: 500;
  color: var(--ink);
  letter-spacing: 2px;
  text-align: center;
  line-height: 1;
}

.timer-val.urgent {
  color: var(--red);
}

.timer-bar-wrap {
  margin-top: 6px;
  height: 2px;
  background: var(--line);
  border-radius: 1px;
}

.timer-bar {
  height: 100%;
  background: var(--ink);
  border-radius: 1px;
  transition: width 1s linear;
}

.timer-bar.urgent {
  background: var(--red);
}

/* ── History ── */
.h-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 7px 0;
  border-bottom: 1px solid var(--line);
}

.h-item:first-child .h-amount {
  color: var(--green);
}

.h-name {
  font-size: 12px;
  color: var(--ink2);
}

.h-time {
  font-size: 10px;
  color: var(--ink4);
}

.h-amount {
  font-size: 12px;
  font-weight: 500;
  color: var(--ink3);
}

.h-empty {
  font-size: 12px;
  color: var(--ink4);
  padding: 8px 0;
}

/* ── Sidebar block ── */
.s-block {
  background: var(--bg2);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 14px;
}

.s-block-label {
  font-size: 10px;
  letter-spacing: 1.5px;
  color: var(--ink4);
  text-transform: uppercase;
  margin-bottom: 8px;
}

/* ── Quick bid ── */
.quick-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  margin-bottom: 8px;
}

.quick-btn {
  padding: 7px 4px;
  font-size: 11px;
  font-family: inherit;
  background: var(--bg);
  border: 1px solid var(--line2);
  border-radius: var(--radius-sm);
  color: var(--ink3);
  cursor: pointer;
  text-align: center;
  transition: all .15s;
}

.quick-btn:hover {
  border-color: var(--ink2);
  color: var(--ink);
}

/* ── Lot tabs ── */
.lot-tabs {
  display: flex;
  overflow-x: auto;
}

.lot-tab {
  padding: 9px 16px;
  font-size: 12px;
  color: var(--ink3);
  border-bottom: 2px solid transparent;
  cursor: pointer;
  white-space: nowrap;
  transition: all .15s;
}

.lot-tab.active {
  color: var(--ink);
  border-bottom-color: var(--ink);
  font-weight: 500;
}

.lot-tab .dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--red);
  margin-right: 5px;
  animation: blink 1.2s infinite;
}

.lot-tab .dot.ended {
  background: var(--ink4);
  animation: none;
}

/* ── Messages ── */
.msg {
  font-size: 12px;
  margin-top: 10px;
  text-align: center;
  min-height: 16px;
}

.msg.err {
  color: var(--red);
}

.msg.ok {
  color: var(--green);
}

/* ── Notice ── */
.notice {
  background: #fffbf0;
  border: 1px solid rgba(154, 104, 0, .2);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  font-size: 12px;
  color: #9a6800;
  display: none;
}

.notice.show {
  display: block;
}

/* ── Viewer row ── */
.viewer-row {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--ink4);
}

.viewer-dot {
  width: 5px;
  height: 5px;
  background: var(--green);
  border-radius: 50%;
}

/* ── Table ── */
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

th {
  text-align: left;
  padding: 10px 14px;
  font-size: 10px;
  letter-spacing: 1.5px;
  color: var(--ink4);
  text-transform: uppercase;
  border-bottom: 1px solid var(--line);
  font-weight: 500;
}

td {
  padding: 11px 14px;
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
  color: var(--ink2);
}

tr:hover td {
  background: var(--bg2);
}

/* ── Feed grid — full width ── */
.feed-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 1px;
  background: var(--line);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
}

.feed-card {
  background: var(--bg);
  cursor: pointer;
  transition: background .15s;
}

.feed-card:hover {
  background: var(--bg2);
}

.feed-thumb {
  width: 100%;
  aspect-ratio: 4/3;
  background: var(--bg2);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 40px;
  overflow: hidden;
  position: relative;
}

.feed-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  display: block;
}

.feed-body {
  padding: 12px 14px;
}

.feed-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.feed-house {
  font-size: 11px;
  color: var(--ink4);
  margin-bottom: 3px;
}

.feed-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
  line-height: 1.4;
  margin-bottom: 10px;
}

.feed-bottom {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
}

.price-label {
  font-size: 10px;
  color: var(--ink4);
  margin-bottom: 2px;
  letter-spacing: .5px;
  text-transform: uppercase;
}

.price-val {
  font-size: 14px;
  font-weight: 500;
  color: var(--ink);
}

/* ── Filter ── */
.filter-bar {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.filter-btn {
  padding: 5px 14px;
  font-size: 12px;
  font-family: inherit;
  border-radius: 20px;
  border: 1px solid var(--line2);
  background: transparent;
  color: var(--ink3);
  cursor: pointer;
  transition: all .15s;
}

.filter-btn.on {
  background: var(--ink);
  color: #fff;
  border-color: transparent;
}

/* ── Image upload ── */
.img-upload-area {
  border: 2px dashed var(--line2);
  border-radius: var(--radius);
  padding: 20px;
  text-align: center;
  cursor: pointer;
  transition: all .15s;
  background: var(--bg2);
}

.img-upload-area:hover {
  border-color: var(--ink2);
  background: var(--bg3);
}

.img-upload-area.has-img {
  padding: 0;
  border-style: solid;
  overflow: hidden;
}

.img-upload-area img {
  width: 100%;
  aspect-ratio: 4/3;
  object-fit: cover;
  display: block;
}

.img-upload-label {
  font-size: 12px;
  color: var(--ink4);
  margin-top: 6px;
}

.img-upload-hint {
  font-size: 11px;
  color: var(--ink4);
  margin-top: 3px;
}

/* ── Misc ── */
.page-label {
  font-size: 10px;
  letter-spacing: 2px;
  color: var(--ink4);
  text-transform: uppercase;
  margin-bottom: 5px;
}

h1 {
  font-size: 20px;
  font-weight: 500;
  margin-bottom: 18px;
}

.empty {
  padding: 48px;
  text-align: center;
  font-size: 13px;
  color: var(--ink4);
}

.you-badge {
  font-size: 10px;
  background: var(--green-bg);
  color: var(--green);
  border: 1px solid rgba(26, 122, 74, .2);
  border-radius: 3px;
  padding: 1px 5px;
  margin-left: 4px;
}

.divider {
  border: none;
  border-top: 1px solid var(--line);
  margin: 0;
}

/* ── Responsive ── */
@media (max-width: 600px) {
  .container {
    padding: 16px;
  }

  nav {
    padding: 0 14px;
  }

  .feed-grid {
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  }
}

.lot-thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center;
  display: block;
  background: var(--bg2);
}
```

---

**สร้างเมื่อ:** 2026-06-05
**โปรเจค:** BidHod - Auction Bidding Platform
