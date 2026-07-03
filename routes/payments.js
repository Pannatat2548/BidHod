const router = require("express").Router();
const { db, find, findOne, insert, update } = require("../db");
const { requireAuth } = require("../middleware/auth");

// ─────────────────────────────────────────────────────────────────
// GET /api/payments/my-unpaid
// คืน [{ roomId, roomTitle, count }] — lot ที่ user ชนะแต่ยังไม่ได้จ่าย
// ใช้แสดง badge บน index.html
// ─────────────────────────────────────────────────────────────────
router.get("/my-unpaid", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // lot ที่ชนะ (isActive=false) และยังไม่จ่าย
    const unpaidLots = await find("lots", {
      highestBidderId: userId,
      isActive: false,
      paid: { $ne: true },
    });

    if (!unpaidLots.length) return res.json([]);

    // group by roomId
    const roomMap = {};
    for (const lot of unpaidLots) {
      if (!roomMap[lot.roomId]) roomMap[lot.roomId] = [];
      roomMap[lot.roomId].push(lot._id);
    }

    // ดึงชื่อห้อง
    const result = await Promise.all(
      Object.entries(roomMap).map(async ([roomId, lotIds]) => {
        const room = await findOne("rooms", { _id: roomId });
        return {
          roomId,
          roomTitle: room ? room.title : "ไม่ระบุห้อง",
          count: lotIds.length,
        };
      })
    );

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/payments
// Buyer ส่ง payload:
// { roomId, lotIds[], shippingOption: { name, price }, slipUrls[], totalAmount }
// → อัปเดต lot ทุกตัวใน lotIds ให้ paid=true + บันทึก payment record
// ─────────────────────────────────────────────────────────────────
router.post("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { roomId, lotIds, shippingOption, slipUrls, totalAmount } = req.body;

    // ── validation ──
    if (!roomId)                        return res.status(400).json({ error: "ไม่มี roomId" });
    if (!Array.isArray(lotIds) || !lotIds.length)
                                        return res.status(400).json({ error: "ไม่มี lotIds" });
    if (!Array.isArray(slipUrls) || !slipUrls.length)
                                        return res.status(400).json({ error: "กรุณาแนบสลิปอย่างน้อย 1 รูป" });

    // ── ตรวจว่า lot ทุกตัว user เป็นผู้ชนะจริง ──
    for (const lotId of lotIds) {
      const lot = await findOne("lots", { _id: lotId });
      if (!lot)
        return res.status(404).json({ error: `ไม่พบ lot: ${lotId}` });
      if (lot.highestBidderId !== userId)
        return res.status(403).json({ error: `lot ${lotId}: คุณไม่ใช่ผู้ชนะ` });
      if (lot.isActive)
        return res.status(400).json({ error: `lot ${lotId}: การประมูลยังไม่สิ้นสุด` });
    }

    const now = new Date();

    // ── อัปเดต lot ทุกตัว ──
    await Promise.all(
      lotIds.map((lotId) =>
        update("lots", { _id: lotId }, {
          $set: {
            paid: true,
            paidAt: now,
            paymentSlip: slipUrls[0],      // รูปแรกเก็บไว้ใน field เดิม (backward compat)
            paymentSlips: slipUrls,         // เก็บทุกรูปใน array ใหม่
            slipConfirmed: false,
            slipRejected: false,
            slipRejectReason: null,
            shippingOption: shippingOption || null,
          },
        })
      )
    );

    // ── บันทึก payment record ──
    const payment = await insert("payments", {
      roomId,
      buyerId: userId,
      buyerName: req.user.name,
      lotIds,
      shippingOption: shippingOption || null,
      slipUrls,
      totalAmount: totalAmount || 0,
      status: "pending",   // pending | confirmed | rejected
      createdAt: now,
    });

    // ── แจ้ง seller ผ่าน chat ──
    try {
      const room = await findOne("rooms", { _id: roomId });
      if (room?.sellerId) {
        const adminUser = await findOne("users", { role: "admin" }) || { _id: "system", name: "ระบบ" };
        const lotCount = lotIds.length;
        const text =
          `💳 ${req.user.name} ชำระเงินสำหรับ ${lotCount} lot ` +
          `จากห้อง "${room.title}" รวม ฿${Number(totalAmount).toLocaleString()} ` +
          `— กรุณาตรวจสอบสลิปในหน้า Admin/Profile`;

        const msg = {
          senderId: adminUser._id || "system",
          receiverId: room.sellerId,
          text,
          createdAt: Date.now(),
        };
        const saved = await insert("messages", msg);
        const io = req.app.get("io");
        if (io) {
          const chatRoom = [msg.senderId, room.sellerId].sort().join("_");
          io.to(`chat:${chatRoom}`).emit("chat:message", saved);
          io.to(`user:${room.sellerId}`).emit("chat:notification", {
            fromId: msg.senderId,
            preview: saved.text.substring(0, 80),
          });
        }
      }
    } catch (notifyErr) {
      console.error("payment notify error:", notifyErr);
    }

    res.json({ ok: true, paymentId: payment._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/payments/room/:roomId
// Seller/Admin ดู payment ทั้งหมดในห้อง
// ─────────────────────────────────────────────────────────────────
router.get("/room/:roomId", requireAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    let sellerId;

    const room = await findOne("rooms", { _id: roomId });
    if (room) {
      sellerId = room.sellerId;
    } else {
      // ห้องถูกลบ — หา sellerId จาก lot ที่มี roomDeleted: true
      const anyLot = await findOne("lots", { roomId, roomDeleted: true });
      if (!anyLot) return res.status(404).json({ error: "ไม่พบห้อง" });
      sellerId = anyLot.sellerId;
    }

    if (sellerId !== req.user.id && req.user.role !== "admin")
      return res.status(403).json({ error: "ไม่มีสิทธิ์" });

    const payments = await find("payments", { roomId }, { createdAt: -1 });
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;