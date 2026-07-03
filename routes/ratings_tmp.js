const router = require("express").Router();
const { find, findOne, insert } = require("../db");
const { requireAuth } = require("../middleware/auth");

// ── ใครเรตใครได้ในแต่ละ lot ──
// lot ต้องจบแล้ว (received = true) buyer = highestBidderId, seller = room.sellerId
async function resolveLotParties(lotId) {
  const lot = await findOne("lots", { _id: lotId });
  if (!lot) return null;
  const room = await findOne("rooms", { _id: lot.roomId });
  if (!room) return null;
  return { lot, room, buyerId: lot.highestBidderId, sellerId: room.sellerId };
}

// GET /api/ratings/user/:userId — ดู rating ทั้งหมดของ user (public)
router.get("/user/:userId", async (req, res) => {
  try {
    const ratings = await find("ratings", { targetId: req.params.userId }, { createdAt: -1 });
    const avg = ratings.length
      ? Math.round((ratings.reduce((s, r) => s + r.score, 0) / ratings.length) * 10) / 10
      : null;
    res.json({ count: ratings.length, average: avg, ratings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ratings/lot/:lotId/can-rate — ใครที่ login อยู่ rate lot นี้ได้ไหม
router.get("/lot/:lotId/can-rate", requireAuth, async (req, res) => {
  try {
    const parties = await resolveLotParties(req.params.lotId);
    if (!parties) return res.status(404).json({ error: "ไม่พบ lot" });
    const { lot, buyerId, sellerId } = parties;

    if (!lot.received) return res.json({ canRate: false, reason: "ยังไม่ได้รับของ" });

    let role = null, targetId = null;
    if (req.user.id === buyerId) { role = "buyer"; targetId = sellerId; }
    else if (req.user.id === sellerId) { role = "seller"; targetId = buyerId; }
    else return res.json({ canRate: false, reason: "ไม่เกี่ยวข้องกับ lot นี้" });

    const existing = await findOne("ratings", { lotId: req.params.lotId, raterId: req.user.id });
    res.json({ canRate: !existing, role, targetId, existing: existing || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ratings — ให้ rating (buyer→seller หรือ seller→buyer)
router.post("/", requireAuth, async (req, res) => {
  try {
    const { lotId, score, comment } = req.body;
    if (!lotId) return res.status(400).json({ error: "ไม่ระบุ lot" });
    const s = Number(score);
    if (!s || s < 1 || s > 5) return res.status(400).json({ error: "คะแนนต้องเป็น 1-5" });

    const parties = await resolveLotParties(lotId);
    if (!parties) return res.status(404).json({ error: "ไม่พบ lot" });
    const { lot, room, buyerId, sellerId } = parties;

    if (!lot.received) return res.status(400).json({ error: "ให้คะแนนได้หลังยืนยันรับของแล้วเท่านั้น" });

    let role = null, targetId = null, targetName = null;
    if (req.user.id === buyerId) { role = "buyer"; targetId = sellerId; targetName = room.sellerName; }
    else if (req.user.id === sellerId) { role = "seller"; targetId = buyerId; targetName = lot.highestBidder; }
    else return res.status(403).json({ error: "ไม่มีสิทธิ์ให้คะแนน lot นี้" });

    const existing = await findOne("ratings", { lotId, raterId: req.user.id });
    if (existing) return res.status(400).json({ error: "คุณให้คะแนน lot นี้ไปแล้ว" });

    const rating = await insert("ratings", {
      lotId, roomId: lot.roomId,
      raterId: req.user.id, raterName: req.user.name, raterRole: role,
      targetId, targetName,
      score: s,
      comment: (comment || "").trim().slice(0, 500),
      createdAt: new Date(),
    });

    res.json({ ok: true, rating });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;