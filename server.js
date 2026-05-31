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

    // anti-sniping
    const endsAt = new Date(lot.endsAt).getTime();
    if (endsAt - Date.now() < 60_000) {
      const newEndsAt = new Date(Date.now() + 30_000);
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
    } else {
      io.to(lot.roomId).emit("lot:tick", { lotId: lot._id, timeLeft, endsAt });
    }
  }
}, 1000);

// ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Bidhaus running at http://localhost:${PORT}`));