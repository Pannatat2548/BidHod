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

// GET /api/admin/rooms — ดูห้องทั้งหมด (พร้อม activeLots/totalLots)
router.get("/rooms", requireAdmin, async (req, res) => {
  const rooms = await find("rooms", {}, { createdAt: -1 });

  const enriched = await Promise.all(rooms.map(async r => {
    const lots = await find("lots", { roomId: r._id });
    return {
      ...r,
      totalLots: lots.length,
      activeLots: lots.filter(l => l.isActive).length,
    };
  }));

  res.json(enriched);
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