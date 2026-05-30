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
