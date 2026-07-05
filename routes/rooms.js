const router = require("express").Router();
const { find, findOne, insert, update, remove } = require("../db");
const { requireAuth, requireSeller, requireAdmin, requireNotBlacklisted } = require("../middleware/auth");
const { scheduleRoomNotifications, cancelRoomNotifications } = require('../utils/auctionNotifier');

// GET /api/rooms
router.get("/", async (req, res) => {
  const { q, tag } = req.query;
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

  let result = enriched;

  // ── filter by ?q= (keyword search) ──
  if (q && q.trim()) {
    const kw = q.trim().toLowerCase();
    result = result.filter(r =>
      r.title?.toLowerCase().includes(kw) ||
      r.house?.toLowerCase().includes(kw) ||
      r.sellerName?.toLowerCase().includes(kw) ||
      r.tags?.some(t => t.toLowerCase().includes(kw))
    );
  }

  // ── filter by ?tag= (exact tag) ──
  if (tag && tag.trim()) {
    const t = tag.trim().toLowerCase().replace(/^#+/, '');
    result = result.filter(r => r.tags?.includes(t));
  }

  res.json(result);
});

// GET /api/rooms/tags — ดึง tags ทั้งหมดที่มีในระบบ
router.get("/tags", async (req, res) => {
  const rooms = await find("rooms", {}, {});
  const tagMap = {};
  for (const r of rooms) {
    for (const t of (r.tags || [])) {
      tagMap[t] = (tagMap[t] || 0) + 1;
    }
  }
  const tags = Object.entries(tagMap)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));
  res.json(tags);
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
router.post("/", requireSeller, requireNotBlacklisted, async (req, res) => {
  const { title, house, lots: lotsData, snipeExt = 0, snipeTrigger = 0, endsAt, tags = [], shippingOptions = [] } = req.body;
  if (!title || !house) return res.status(400).json({ error: "กรุณากรอก title และ house" });

  // sanitize tags
  const cleanTags = [...new Set(
    tags.map(t => t.toString().toLowerCase().replace(/^#+/, '').trim()).filter(Boolean)
  )].slice(0, 10);

  // sanitize shippingOptions — { type: 'pickup'|'ship'|'other', name, price, desc }
  const allowedShipTypes = ["pickup", "ship", "other"];
  const cleanShippingOptions = Array.isArray(shippingOptions)
    ? shippingOptions
        .filter(o => o && o.name && o.name.toString().trim())
        .slice(0, 10)
        .map(o => ({
          type: allowedShipTypes.includes(o.type) ? o.type : "other",
          name: o.name.toString().trim().slice(0, 60),
          price: Math.max(0, Number(o.price) || 0),
          desc: (o.desc || "").toString().trim().slice(0, 200),
        }))
    : [];

  const room = await insert("rooms", {
    title, house,
    sellerId: req.user.id,
    sellerName: req.user.name,
    snipeExt,
    snipeTrigger,
    tags: cleanTags,
    shippingOptions: cleanShippingOptions,
    createdAt: new Date(),
  });

  scheduleRoomNotifications(room);

  if (lotsData?.length) {
    await Promise.all(lotsData.map((l, i) => insert("lots", {
      roomId: room._id,
      sellerId: room.sellerId,
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

  const { title, house, tags } = req.body;
  const setObj = {};
  if (title !== undefined) setObj.title = title;
  if (house !== undefined) setObj.house = house;
  if (tags !== undefined) {
    setObj.tags = [...new Set(
      tags.map(t => t.toString().toLowerCase().replace(/^#+/, '').trim()).filter(Boolean)
    )].slice(0, 10);
  }

  await update("rooms", { _id: req.params.id }, { $set: setObj });
  res.json({ ok: true });
});

// DELETE /api/rooms/:id
router.delete("/:id", requireSeller, async (req, res) => {
  const room = await findOne("rooms", { _id: req.params.id });
  if (!room) return res.status(404).json({ error: "ไม่พบห้องนี้" });
  if (req.user.role !== "admin" && room.sellerId !== req.user.id)
    return res.status(403).json({ error: "ไม่มีสิทธิ์ลบ" });
  await remove("rooms", { _id: req.params.id });
  await update("lots", { roomId: req.params.id }, { $set: { roomDeleted: true } }, { multi: true });
  cancelRoomNotifications(req.params.id);
  res.json({ ok: true });
});

// GET /api/rooms/:id/my-wins
router.get("/:id/my-wins", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const roomId = req.params.id;
    const room = await findOne("rooms", { _id: roomId });
    if (!room) return res.status(404).json({ error: "ไม่พบห้องนี้" });
    const lots = await find("lots", {
      roomId,
      highestBidderId: userId,
      isActive: false,
      paid: { $ne: true },
    });
    res.json({ lots, room });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;