const router = require("express").Router();
const { find, findOne, insert, update, remove } = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

// POST /api/reports — รายงาน user คนอื่น (แนบรูปได้)
router.post("/", requireAuth, async (req, res) => {
  try {
    const { targetId, lotId, roomId, reason, detail, imageUrls } = req.body;
    if (!targetId) return res.status(400).json({ error: "ไม่ระบุผู้ถูกรายงาน" });
    if (targetId === req.user.id) return res.status(400).json({ error: "รายงานตัวเองไม่ได้" });
    if (!reason) return res.status(400).json({ error: "กรุณาเลือกเหตุผล" });

    const target = await findOne("users", { _id: targetId });
    if (!target) return res.status(404).json({ error: "ไม่พบผู้ใช้ที่ต้องการรายงาน" });

    const cleanImages = Array.isArray(imageUrls) ? imageUrls.filter(u => typeof u === "string").slice(0, 6) : [];

    const report = await insert("reports", {
      reporterId: req.user.id, reporterName: req.user.name,
      targetId, targetName: target.name,
      lotId: lotId || null, roomId: roomId || null,
      reason,
      detail: (detail || "").trim().slice(0, 1000),
      imageUrls: cleanImages,
      status: "pending",   // pending | reviewed
      verdict: null,        // null | guilty | not_guilty
      adminNote: "",
      createdAt: new Date(),
    });

    res.json({ ok: true, report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/mine — รายงานที่ตัวเองส่งไป (ดูสถานะ)
router.get("/mine", requireAuth, async (req, res) => {
  try {
    const reports = await find("reports", { reporterId: req.user.id }, { createdAt: -1 });
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin moderation ──

// GET /api/reports?status=pending — admin ดูรายงานทั้งหมด
// status: pending | reviewed (ไม่ส่ง query = ทั้งหมด)
router.get("/", requireAdmin, async (req, res) => {
  try {
    const q = req.query.status ? { status: req.query.status } : {};
    const reports = await find("reports", q, { createdAt: -1 });
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/reports/:id — admin ตัดสิน: ผิดจริง (guilty) → auto blacklist ผู้ถูกรายงาน
//                                        ไม่ผิดจริง (not_guilty) → ปิดเรื่องเฉยๆ
router.patch("/:id", requireAdmin, async (req, res) => {
  try {
    const { verdict, adminNote } = req.body;
    if (!["guilty", "not_guilty"].includes(verdict)) {
      return res.status(400).json({ error: "กรุณาเลือกผลการตัดสิน (ผิดจริง / ไม่ผิดจริง)" });
    }

    const report = await findOne("reports", { _id: req.params.id });
    if (!report) return res.status(404).json({ error: "ไม่พบรายงาน" });

    await update("reports", { _id: req.params.id }, {
      $set: {
        status: "reviewed",
        verdict,
        adminNote: adminNote || "",
        resolvedAt: new Date(),
        resolvedBy: req.user.id,
      }
    });

    // ── ตัดสินว่าผิดจริง → แบนทันที (ห้าม login เข้าระบบประมูล/สร้างห้อง) ──
    if (verdict === "guilty") {
      await update("users", { _id: report.targetId }, {
        $set: {
          blacklisted: true,
          blacklistedAt: new Date(),
          blacklistReason: `รายงาน: ${report.reason}${adminNote ? " — " + adminNote : ""}`,
          blacklistReportId: report._id,
        }
      });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/reports/:id — admin ลบรายงาน
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    await remove("reports", { _id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Blacklist management ──

// GET /api/reports/blacklist — รายชื่อ user ที่ถูกแบน
router.get("/blacklist/list", requireAdmin, async (req, res) => {
  try {
    const users = await find("users", { blacklisted: true }, { blacklistedAt: -1 });
    res.json(users.map(({ password, ...u }) => u));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/reports/blacklist/:userId/unban — ปลดแบน
router.patch("/blacklist/:userId/unban", requireAdmin, async (req, res) => {
  try {
    await update("users", { _id: req.params.userId }, {
      $set: { blacklisted: false },
      $unset: { blacklistedAt: true, blacklistReason: true, blacklistReportId: true },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reports/blacklist/:userId/ban — admin แบนตรง (ไม่ผ่าน report)
router.post("/blacklist/:userId/ban", requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    const target = await findOne("users", { _id: req.params.userId });
    if (!target) return res.status(404).json({ error: "ไม่พบผู้ใช้" });
    if (target.role === "admin") return res.status(400).json({ error: "แบน admin ไม่ได้" });

    await update("users", { _id: req.params.userId }, {
      $set: {
        blacklisted: true,
        blacklistedAt: new Date(),
        blacklistReason: reason || "แบนโดย admin",
      }
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;