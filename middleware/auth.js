const jwt = require("jsonwebtoken");
const { findOne } = require("../db");

const SECRET = process.env.JWT_SECRET || "bidhaus_secret_change_in_prod";

function signToken(user) {
  return jwt.sign(
    { id: user._id.toString(), email: user.email, role: user.role, name: user.name },
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

// middleware: ต้องไม่ถูก blacklist — ใช้คุม "การกระทำ" เช่น bid, สร้างห้อง
// (login ได้ปกติ แต่ทำสิ่งเหล่านี้ไม่ได้) — เช็คจาก DB ตรงๆ เพราะ JWT อาจออกไปก่อนถูกแบน
async function requireNotBlacklisted(req, res, next) {
  try {
    const u = await findOne("users", { _id: req.user.id });
    if (u?.blacklisted) {
      return res.status(403).json({ error: "บัญชีนี้ถูกระงับการประมูล/สร้างห้อง เนื่องจากถูกแบน (Blacklist)" });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// เวอร์ชันสำหรับ Socket.io (ไม่มี req/res) — คืน true ถ้าแบนอยู่
async function isBlacklisted(userId) {
  const u = await findOne("users", { _id: userId });
  return !!u?.blacklisted;
}

// parse token จาก socket handshake
function authSocket(token) {
  if (!token) return null;
  try { return verifyToken(token); }
  catch { return null; }
}

module.exports = { signToken, requireAuth, requireAdmin, requireSeller, requireNotBlacklisted, isBlacklisted, authSocket };