const jwt = require("jsonwebtoken");
const { findOne } = require("../db");

const SECRET = process.env.JWT_SECRET || "bidhaus_secret_change_in_prod";

function signToken(user) {
  return jwt.sign(
    { id: user._id, email: user.email, role: user.role, name: user.name },
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

// parse token จาก socket handshake
function authSocket(token) {
  if (!token) return null;
  try { return verifyToken(token); }
  catch { return null; }
}

module.exports = { signToken, requireAuth, requireAdmin, requireSeller, authSocket };