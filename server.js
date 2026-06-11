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
const authRoutes = require("./routes/auth");
const roomRoutes = require("./routes/rooms");
const adminRoutes = require("./routes/admin");
const uploadRoutes = require("./routes/upload");
const profileRoutes = require('./routes/profile');

app.use("/api/auth", authRoutes);
app.use("/api/rooms", roomRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/upload", uploadRoutes);
app.use('/api/messages', require('./routes/messages'));
app.use('/api/profile', profileRoutes);

// SPA fallback
app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Socket.io ────────────────────────────────────
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
    const snipeExt = (lot.snipeExt || 0) * 1000;
    if (snipeTrigger > 0 && snipeExt > 0 && endsAt - Date.now() < snipeTrigger) {
      const newEndsAt = new Date(Date.now() + snipeExt);
      await update("lots", { _id: lotId }, { $set: { endsAt: newEndsAt } });
      io.to(roomId).emit("lot:extended", { lotId, newEndsAt });
    }

    io.to(roomId).emit("bid:new", {
      lotId, bid,
      currentPrice: amount,
      highestBidder: user.name,
      highestBidderId: user.id,  // ← เพิ่มบรรทัดนี้
    });
  });

  // admin/seller broadcast อัปเดตข้อมูล lot
  socket.on("lot:update", async ({ roomId, lotId, changes }) => {
    if (!user || !["admin", "seller"].includes(user.role))
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

      // ดึงข้อมูลห้องมาใส่ในข้อความด้วย
      const room = await findOne('rooms', { _id: roomId });
      const roomTitle = room ? room.title : 'ไม่ระบุห้อง';

      // เพิ่ม ${roomTitle} เข้าไปใน text
      const text = `✅ สำเร็จ! คุณซื้อ "${lot.name}" จากห้อง "${roomTitle}" ด้วยราคาปิด ฿${Number(lot.binPrice).toLocaleString()} เรียบร้อยแล้ว`;

      const msg = { senderId: adminUser._id || 'system', receiverId: user.id, text, createdAt: Date.now() };
      const saved = await insert('messages', msg);
      const chatRoom = [msg.senderId, user.id].sort().join('_');
      io.to(`chat:${chatRoom}`).emit('chat:message', saved);
      io.to(`user:${user.id}`).emit('chat:notification', { fromId: msg.senderId, preview: saved.text.substring(0, 60) });
    } catch (e) {
      console.error('bin notify error', e);
    }
  });

  socket.on('chat:join', ({ myId, otherId }) => {
    const roomId = [myId, otherId].sort().join('_');
    console.log('chat:join', roomId, myId, otherId);
    socket.join(`chat:${roomId}`);
  });

  socket.on('chat:leave', ({ myId, otherId }) => {
    const roomId = [myId, otherId].sort().join('_');
    socket.leave(`chat:${roomId}`);
  });

  socket.on('user:join', (userId) => {
    console.log('user:join', userId);
    socket.join(`user:${userId}`);
  });

  socket.on('chat:send', async ({ senderId, receiverId, text }) => {
    console.log('chat:send', { senderId, receiverId, text });
    if (!text || !text.trim()) return;
    const msg = { senderId, receiverId, text: text.trim(), createdAt: Date.now() };
    try {
      const saved = await new Promise((resolve, reject) => {
        db.messages.insert(msg, (err, doc) => err ? reject(err) : resolve(doc));
      });
      const roomId = [senderId, receiverId].sort().join('_');
      io.to(`chat:${roomId}`).emit('chat:message', saved);
      io.to(`user:${receiverId}`).emit('chat:notification', {
        fromId: senderId,
        preview: saved.text.substring(0, 60)
      });
      console.log('chat:message emitted', { roomId, saved });
    } catch (err) {
      socket.emit('chat:error', { message: err.message });
    }
  });

});

app.get('/api/profile/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const user = await findOne('users', { _id: userId });
    if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });

    // ดึง bids ที่ user นี้ทำ (ฝั่ง buyer)
    const bids = await find('bids', { bidderId: userId }, { createdAt: -1 });

    // ดึง lots ที่ user นี้ชนะ (highestBidderId = userId)
    const wonLots = await find('lots', { highestBidderId: userId, isActive: false }, { createdAt: -1 });

    // ดึง rooms ที่ user นี้เป็น seller
    const sellerRooms = await find('rooms', { sellerId: userId }, { createdAt: -1 });

    // ดึง lots ทั้งหมดใน rooms ที่ user เป็น seller
    const sellerLots = [];
    for (const room of sellerRooms) {
      const lots = await find('lots', { roomId: room._id });
      sellerLots.push(...lots.map(l => ({ ...l, roomTitle: room.title, roomHouse: room.house })));
    }

    res.json({
      user: { ...user, password: undefined },
      stats: {
        buy: {
          totalBids: bids.length,
          totalWon: wonLots.length,
          totalSpent: wonLots.reduce((sum, l) => sum + (l.currentPrice || 0), 0),
          lots: wonLots.map(l => ({
            lotName: l.name,
            roomTitle: l.roomId, // ต้อง resolve เป็นชื่อห้อง
            price: l.currentPrice,
            paid: l.paid || false,
            endedAt: l.endsAt
          }))
        },
        sell: {
          totalRooms: sellerRooms.length,
          totalLots: sellerLots.length,
          totalRevenue: sellerLots.filter(l => !l.isActive).reduce((sum, l) => sum + (l.currentPrice || 0), 0),
          lots: sellerLots.map(l => ({
            lotName: l.name,
            roomTitle: l.roomTitle,
            currentPrice: l.currentPrice,
            isActive: l.isActive,
            bidderCount: l.bids?.length || 0
          }))
        }
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/profile/:userId — อัปเดต social links
app.patch('/api/profile/:userId', require('./middleware/auth').requireAuth, async (req, res) => {
  try {
    if (req.user.id !== req.params.userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์แก้ไข' });
    }
    const { facebook, instagram, discord } = req.body;
    await update('users', { _id: req.params.userId }, {
      $set: { facebook, instagram, discord }
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
          // ดึงข้อมูลห้องมาใส่ในข้อความด้วย
          const room = await findOne('rooms', { _id: lot.roomId });
          const roomTitle = room ? room.title : 'ไม่ระบุห้อง';

          const adminUser = await findOne('users', { role: 'admin' }) || { _id: 'system', name: 'ระบบ' };

          // เพิ่ม ${roomTitle} เข้าไปใน text
          const text = `🎉 ยินดีด้วย! คุณชนะการประมูล "${lot.name}" จากห้อง "${roomTitle}" ด้วยราคา ฿${Number(lot.currentPrice).toLocaleString()}`;

          const msg = {
            senderId: adminUser._id || adminUser.id || 'system',
            receiverId: winnerId,
            text,
            createdAt: Date.now(),
          };

          const saved = await insert('messages', msg);
          const roomId = [msg.senderId, winnerId].sort().join('_');
          io.to(`chat:${roomId}`).emit('chat:message', saved);
          io.to(`user:${winnerId}`).emit('chat:notification', { fromId: msg.senderId, preview: saved.text.substring(0, 60) });
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
server.listen(PORT, () => console.log(`🚀 Bidhaus running at http://localhost:${PORT}`));