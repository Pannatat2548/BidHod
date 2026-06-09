const router = require("express").Router();
const { find, findOne, insert, update, remove } = require("../db");
const { requireAuth, requireSeller, requireAdmin } = require("../middleware/auth");

// GET /api/rooms
router.get("/", async (req, res) => {
  const { q } = req.query;
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

  // ── ถ้ามี ?q= ให้ filter ──
  if (q && q.trim()) {
    const kw = q.trim().toLowerCase();
    const filtered = enriched.filter(r =>
      r.title?.toLowerCase().includes(kw) ||
      r.house?.toLowerCase().includes(kw) ||
      r.sellerName?.toLowerCase().includes(kw)
    );
    return res.json(filtered);
  }

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
  const { title, house, lots: lotsData, snipeExt = 0, snipeTrigger = 0, endsAt } = req.body;
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
      endsAt: l.endsAt ? new Date(l.endsAt) : new Date(Date.now() + 30 * 60 * 1000),
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