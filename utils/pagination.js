/**
 * utils/pagination.js
 * 
 * Helper สำหรับ paginate ใน NeDB (ไม่มี native skip/limit)
 * 
 * NeDB ดึงทั้งหมดก่อน แล้ว slice — เหมาะกับ dataset ไม่ใหญ่มาก
 * 
 * ใช้งาน:
 *   const { paginateArray, parsePage } = require('../utils/pagination');
 * 
 *   router.get('/seller-lots/:roomId', requireAuth, async (req, res) => {
 *     const { page, limit } = parsePage(req);
 *     const all = await find('lots', { roomId: req.params.roomId });
 *     res.json(paginateArray(all, page, limit));
 *   });
 */

function parsePage(req, defaultLimit = 20) {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || defaultLimit));
  return { page, limit };
}

function paginateArray(arr, page, limit) {
  const total      = arr.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage   = Math.min(page, totalPages);
  const start      = (safePage - 1) * limit;
  const items      = arr.slice(start, start + limit);

  return {
    items,
    total,
    page: safePage,
    limit,
    totalPages,
    hasNext: safePage < totalPages,
    hasPrev: safePage > 1,
  };
}

module.exports = { parsePage, paginateArray };
