const router = require("express").Router();
const { find, findOne, insert, update } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { parsePage, paginateArray } = require('../utils/pagination');

// ── helper: ส่ง notification หา buyer/seller ผ่านช่องแชทเดิม (เหมือน routes/payments.js) ──
// ใช้ตอน status ของ lot เปลี่ยน เช่น slip confirmed, shipped
async function notifyUser(req, toUserId, text) {
    try {
        const io = req.app.get("io");
        if (!toUserId || toUserId === req.user.id) return; // ไม่ต้องแจ้งตัวเอง
        const msg = {
            senderId: "system",
            receiverId: toUserId,
            text,
            createdAt: Date.now(),
        };
        const saved = await insert("messages", msg);
        if (io) {
            const chatRoom = ["system", toUserId].sort().join("_");
            io.to(`chat:${chatRoom}`).emit("chat:message", saved);
            io.to(`user:${toUserId}`).emit("chat:notification", {
                fromId: "system",
                preview: text.substring(0, 80),
            });
        }
    } catch (err) {
        console.error("notifyUser error:", err.message);
    }
}

// GET /api/profile/seller-rooms — ต้องอยู่ก่อน /:userId เสมอ
router.get("/seller-rooms", requireAuth, async (req, res) => {
    try {
        const sellerId = req.user.id;

        const activeRooms = await find("rooms", { sellerId }, { createdAt: -1 });

        const deletedLots = await find("lots", { sellerId, roomDeleted: true });
        const deletedRoomMap = {};
        for (const l of deletedLots) {
            const key = String(l.roomId);
            if (!deletedRoomMap[key]) {
                deletedRoomMap[key] = {
                    _id: key,
                    title: l.roomTitle || 'ห้องที่ถูกลบ',
                    sellerId,
                    deleted: true,
                    totalLots: 0,
                };
            }
            deletedRoomMap[key].totalLots++;
        }

        const activeRoomIds = new Set(activeRooms.map(r => String(r._id)));
        const deletedRooms = Object.values(deletedRoomMap).filter(r => !activeRoomIds.has(r._id));

        res.json([
            ...activeRooms.map(r => ({ ...r, deleted: false })),
            ...deletedRooms,
        ]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/profile/seller-lots/:roomId — ต้องอยู่ก่อน /:userId เสมอ
router.get("/seller-lots/:roomId", requireAuth, async (req, res) => {
    try {
        const sellerId = req.user.id;
        const roomId = req.params.roomId;

        const room = await findOne("rooms", { _id: roomId });

        let lots, roomTitle, isDeleted = false;

        if (room) {
            if (room.sellerId !== sellerId && req.user.role !== "admin")
                return res.status(403).json({ error: "ไม่มีสิทธิ์" });
            lots = await find("lots", { roomId }, { num: 1 });
            roomTitle = room.title;
        } else {
            lots = await find("lots", { roomId, sellerId, roomDeleted: true }, { num: 1 });
            if (!lots.length) return res.status(404).json({ error: "ไม่พบห้องหรือ lot" });
            if (lots[0].sellerId !== sellerId && req.user.role !== "admin")
                return res.status(403).json({ error: "ไม่มีสิทธิ์" });
            roomTitle = lots[0].roomTitle || 'ห้องที่ถูกลบ';
            isDeleted = true;
        }

        res.json({ roomId, roomTitle, isDeleted, lots });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/profile/:userId — ดึงข้อมูลโปรไฟล์
// - ถ้าเป็นเจ้าของ (isSelf) → ส่งข้อมูลครบ รวม lots, ราคา, สลิป
// - ถ้าเป็นคนอื่น (public) → ส่งเฉพาะ ชื่อ/avatar/social + publicStats เท่านั้น
router.get("/:userId", async (req, res) => {
    try {
        const userId = req.params.userId;
        const { password: _pw, ...user } = await findOne("users", { _id: userId }) || {};
        if (!user._id) return res.status(404).json({ error: "ไม่พบผู้ใช้" });

        // ── ตรวจว่าเป็นเจ้าของไหมจาก JWT ──
        // ใช้ middleware requireAuth ที่ populate req.user ให้แล้ว
        // ถ้าไม่ได้ login → req.user จะเป็น undefined → isSelf = false
        let isSelf = false;
        const authHeader = req.headers.authorization || "";
        if (authHeader.startsWith("Bearer ")) {
            try {
                const jwt = require("jsonwebtoken");
                const SECRET = process.env.JWT_SECRET || "bidhaus_secret_change_in_prod";
                const decoded = jwt.verify(authHeader.slice(7), SECRET);
                // รองรับทั้ง id / _id และ trim ป้องกัน whitespace
                const decodedId = (decoded.id || decoded._id || "").toString().trim();
                const targetId = userId.toString().trim();
                isSelf = decodedId !== "" && decodedId === targetId;
                console.log("[profile] decoded id:", decodedId, "| param userId:", targetId, "| isSelf:", isSelf);
            } catch (jwtErr) {
                console.log("[profile] JWT error:", jwtErr.message);
            }
        }

        // ========== PUBLIC STATS (ทุกคนดูได้) ==========
        const wonLots = await find("lots", { highestBidderId: userId });
        const paidLots = wonLots.filter(l => l.paid === true);

        // query ทั้ง rooms ที่ยังอยู่ และ lots ตรงๆ (รองรับกรณีห้องถูกลบแต่ lots ยัง soft-delete ไว้)
        const sellerRooms = await find("rooms", { sellerId: userId }, { createdAt: -1 });
        const roomMap = {};
        for (const r of sellerRooms) roomMap[String(r._id)] = r;

        // lots จาก rooms ที่ยังอยู่
        const sellerLots = [];
        for (const room of sellerRooms) {
            const lots = await find("lots", { roomId: room._id });
            sellerLots.push(...lots.map(l => ({ ...l, roomTitle: room.title, roomId: room._id })));
        }

        // lots จาก rooms ที่ถูกลบแล้ว (roomDeleted: true) — เพื่อรักษา credit stats
        const deletedRoomLots = await find("lots", { sellerId: userId, roomDeleted: true });
        for (const l of deletedRoomLots) {
            sellerLots.push({ ...l, roomTitle: l.roomTitle || 'ห้องที่ถูกลบ' });
        }

        const receivedLots = sellerLots.filter(l => l.received === true);

        // ห้องที่เปิดอยู่ตอนนี้ (สำหรับหน้า public) — ไม่เปิดเผยราคาประมูล
        const activeRooms = sellerRooms.map(r => ({
            _id: r._id,
            title: r.title,
            house: r.house,
        }));

        const publicStats = {
            totalWon: wonLots.length,       // ชนะประมูลกี่ครั้ง
            totalPaid: paidLots.length,       // จ่ายเงินกี่ครั้ง
            totalReceived: receivedLots.length,   // ส่งของสำเร็จกี่ครั้ง
            payRate: wonLots.length > 0
                ? Math.round((paidLots.length / wonLots.length) * 100) : null,
            deliveryRate: sellerLots.filter(l => !l.isActive && l.currentPrice > 0).length > 0
                ? Math.round((receivedLots.length /
                    sellerLots.filter(l => !l.isActive && l.currentPrice > 0).length) * 100) : null,
        };

        // ── Rating summary (ดาว 1-5 จากทั้ง buyer และ seller ที่เคยซื้อขายด้วยกัน) ──
        const userRatings = await find("ratings", { targetId: userId }, { createdAt: -1 });
        publicStats.ratingCount = userRatings.length;
        publicStats.ratingAverage = userRatings.length
            ? Math.round((userRatings.reduce((sum, r) => sum + r.score, 0) / userRatings.length) * 10) / 10
            : null;
        const recentRatings = userRatings.slice(0, 10).map(r => ({
            score: r.score,
            comment: r.comment || "",
            raterName: r.raterName,
            raterRole: r.raterRole,
            createdAt: r.createdAt,
        }));

        // ── ถ้าไม่ใช่เจ้าของ → ส่ง public view เท่านั้น ──
        if (!isSelf) {
            const { password: _p, email, ...publicUser } = user;
            return res.json({
                isSelf: false,
                user: publicUser,
                publicStats,
                activeRooms,
                recentRatings,
            });
        }

        // ========== PRIVATE VIEW (เจ้าของเท่านั้น) ==========
        const unpaidLots = wonLots.filter(l => l.paid !== true);
        const activeLots = sellerLots.filter(l => l.isActive === true);
        const deliveredLots = sellerLots.filter(l => l.delivered === true && !l.received);

        const resolvedWonLots = await Promise.all(wonLots.map(async l => {
            const room = await findOne("rooms", { _id: l.roomId });
            return {
                _id: l._id,
                lotName: l.name,
                roomId: room ? room._id : (l.roomId || null),
                roomTitle: room ? room.title : (l.roomTitle || 'ห้องที่ถูกลบ'),
                sellerId: room ? room.sellerId : (l.sellerId || null),
                sellerName: room ? room.sellerName : null,
                price: l.currentPrice,
                paid: l.paid || false,
                delivered: l.delivered || false,
                received: l.received || false,
                paymentSlip: l.paymentSlip || null,
                slipConfirmed: l.slipConfirmed || false,
                slipRejected: l.slipRejected || false,
                slipRejectReason: l.slipRejectReason || null,
                trackingNumber: l.trackingNumber || null,
                shippingProvider: l.shippingProvider || null,
                endedAt: l.endsAt,
            };
        }));

        const resolvedSellerLots = sellerLots.map(l => ({
            _id: l._id,
            lotName: l.name,
            roomTitle: l.roomTitle,
            currentPrice: l.currentPrice,
            isActive: l.isActive,
            paid: l.paid || false,
            delivered: l.delivered || false,
            received: l.received || false,
            paymentSlip: l.paymentSlip || null,
            slipConfirmed: l.slipConfirmed || false,
            slipRejected: l.slipRejected || false,
            slipRejectReason: l.slipRejectReason || null,
            trackingNumber: l.trackingNumber || null,
            shippingProvider: l.shippingProvider || null,
            bidderCount: l.bids?.length || 0,
        }));

        res.json({
            isSelf: true,
            user,
            publicStats,
            recentRatings,
            stats: {
                buy: {
                    totalBids: wonLots.length,
                    totalWon: wonLots.length,
                    totalPaid: paidLots.length,
                    totalUnpaid: unpaidLots.length,
                    totalSpent: paidLots.reduce((sum, l) => sum + (l.currentPrice || 0), 0),
                    lots: resolvedWonLots,
                },
                sell: {
                    totalRooms: sellerRooms.length,
                    totalLots: sellerLots.length,
                    totalActive: activeLots.length,
                    totalDelivered: deliveredLots.length,
                    totalReceived: receivedLots.length,
                    totalRevenue: receivedLots.reduce((sum, l) => sum + (l.currentPrice || 0), 0),
                    lots: resolvedSellerLots,
                },
                credit: {
                    buyerScore: paidLots.length,
                    sellerScore: receivedLots.length,
                    totalScore: paidLots.length + receivedLots.length,
                },
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/profile/:userId — อัปเดต social links
router.patch("/:userId", requireAuth, async (req, res) => {
    try {
        if (req.user.id !== req.params.userId && req.user.role !== "admin") {
            return res.status(403).json({ error: "ไม่มีสิทธิ์แก้ไข" });
        }
        const { facebook, instagram, discord, reddit, phone, otherSocial, otherSocialLabel,
                paymentQr, bankName, bankAccountNumber, bankAccountName } = req.body;
        const setObj = {};
        if (facebook !== undefined) setObj.facebook = facebook;
        if (instagram !== undefined) setObj.instagram = instagram;
        if (reddit !== undefined) setObj.reddit = reddit;
        if (discord !== undefined) setObj.discord = discord;
        if (phone !== undefined) setObj.phone = phone;
        if (otherSocial !== undefined) setObj.otherSocial = otherSocial;
        if (otherSocialLabel !== undefined) setObj.otherSocialLabel = otherSocialLabel;
        // ── ข้อมูลรับเงินของผู้ขาย (QR + เลขบัญชีสำรอง) ตั้งครั้งเดียวใช้ได้ทุกห้อง ──
        if (paymentQr !== undefined) setObj.paymentQr = paymentQr;
        if (bankName !== undefined) setObj.bankName = bankName;
        if (bankAccountNumber !== undefined) setObj.bankAccountNumber = bankAccountNumber;
        if (bankAccountName !== undefined) setObj.bankAccountName = bankAccountName;

        if (Object.keys(setObj).length === 0) {
            return res.status(400).json({ error: "ไม่มีข้อมูลที่จะอัปเดต" });
        }
        await update("users", { _id: req.params.userId }, { $set: setObj });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/profile/lots/:id/pay — Buyer แนบสลิป
router.patch("/lots/:id/pay", requireAuth, async (req, res) => {
    try {
        const lot = await findOne("lots", { _id: req.params.id });
        if (!lot) return res.status(404).json({ error: "ไม่พบ lot" });

        if (lot.highestBidderId !== req.user.id && req.user.role !== "admin") {
            return res.status(403).json({ error: "ไม่มีสิทธิ์" });
        }

        // ── ต้องประมูลจบก่อนถึงจ่ายเงินได้ ──
        if (lot.isActive) {
            return res.status(400).json({ error: "Lot นี้ยังประมูลไม่จบ กรุณารอให้การประมูลสิ้นสุดก่อน" });
        }

        const { paymentSlip } = req.body;
        if (!paymentSlip) return res.status(400).json({ error: "กรุณาแนบสลิปการโอนเงิน" });

        await update("lots", { _id: req.params.id }, {
            $set: {
                paid: true,
                paidAt: new Date(),
                paymentSlip,
                // reset slip status ทุกครั้งที่ส่งสลิปใหม่
                slipConfirmed: false,
                slipRejected: false,
                slipRejectReason: null,
            }
        });

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── ใหม่: PATCH /api/profile/lots/:id/confirm-slip — Seller ยืนยันสลิป ──
router.patch("/lots/:id/confirm-slip", requireAuth, async (req, res) => {
    try {
        const lot = await findOne("lots", { _id: req.params.id });
        if (!lot) return res.status(404).json({ error: "ไม่พบ lot" });

        // เฉพาะ seller เจ้าของห้องหรือ admin เท่านั้น (รองรับกรณีห้องถูกลบไปแล้ว — ใช้ sellerId ที่ cache ไว้ใน lot แทน)
        const room = await findOne("rooms", { _id: lot.roomId });
        const sellerId = room ? room.sellerId : lot.sellerId;
        if (req.user.role !== "admin" && sellerId !== req.user.id) {
            return res.status(403).json({ error: "ไม่มีสิทธิ์" });
        }

        if (!lot.paymentSlip) {
            return res.status(400).json({ error: "ยังไม่มีสลิปจาก buyer" });
        }

        await update("lots", { _id: req.params.id }, {
            $set: {
                slipConfirmed: true,
                slipConfirmedAt: new Date(),
                slipRejected: false,
                slipRejectReason: null,
            }
        });

        notifyUser(req, lot.highestBidderId,
            `✅ ผู้ขายยืนยันการชำระเงินสำหรับ "${lot.name}" แล้ว รอการจัดส่งครับ/ค่ะ`);

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── ใหม่: PATCH /api/profile/lots/:id/reject-slip — Seller ปฏิเสธสลิป ──
router.patch("/lots/:id/reject-slip", requireAuth, async (req, res) => {
    try {
        const lot = await findOne("lots", { _id: req.params.id });
        if (!lot) return res.status(404).json({ error: "ไม่พบ lot" });

        // เฉพาะ seller เจ้าของห้องหรือ admin เท่านั้น (รองรับกรณีห้องถูกลบไปแล้ว — ใช้ sellerId ที่ cache ไว้ใน lot แทน)
        const room = await findOne("rooms", { _id: lot.roomId });
        const sellerId = room ? room.sellerId : lot.sellerId;
        if (req.user.role !== "admin" && sellerId !== req.user.id) {
            return res.status(403).json({ error: "ไม่มีสิทธิ์" });
        }

        const { reason } = req.body;

        await update("lots", { _id: req.params.id }, {
            $set: {
                slipRejected: true,
                slipRejectedAt: new Date(),
                slipRejectReason: reason || "กรุณาส่งสลิปใหม่",
                slipConfirmed: false,
                // reset paid เพื่อให้ buyer ส่งสลิปใหม่ได้
                paid: false,
                paymentSlip: null,
            }
        });

        notifyUser(req, lot.highestBidderId,
            `❌ ผู้ขายปฏิเสธสลิปสำหรับ "${lot.name}" — เหตุผล: ${reason || "กรุณาส่งสลิปใหม่"}`);

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/profile/rooms/:roomId/pending-delivery — Seller: รวม lot ที่จ่ายแล้ว+ยืนยันสลิปแล้ว
// แต่ยังไม่ส่ง ของห้องนี้ จัดกลุ่มตาม buyer คนเดียวกัน เพื่อกรอก tracking ทีเดียว
router.get("/rooms/:roomId/pending-delivery", requireAuth, async (req, res) => {
    try {
        const roomId = req.params.roomId;
        let sellerId;

        const room = await findOne("rooms", { _id: roomId });
        if (room) {
            sellerId = room.sellerId;
        } else {
            // ห้องถูกลบ — หา sellerId จาก lot
            const anyLot = await findOne("lots", { roomId, roomDeleted: true });
            if (!anyLot) return res.status(404).json({ error: "ไม่พบห้อง" });
            sellerId = anyLot.sellerId;
        }

        if (sellerId !== req.user.id && req.user.role !== "admin") {
            return res.status(403).json({ error: "ไม่มีสิทธิ์" });
        }

        const lots = await find("lots", { roomId });
        const eligible = lots.filter(l =>
            !l.isActive && l.slipConfirmed === true && l.delivered !== true && l.highestBidderId
        );

        const groups = {};
        for (const l of eligible) {
            const key = l.highestBidderId;
            if (!groups[key]) groups[key] = { buyerId: key, buyerName: l.highestBidder, lots: [] };
            groups[key].lots.push({
                _id: l._id, name: l.name, desc: l.desc,
                currentPrice: l.currentPrice,
                shippingOption: l.shippingOption || null,
            });
        }

        res.json({ groups: Object.values(groups) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/profile/lots/deliver-merged — Seller กรอก tracking ครั้งเดียว ใช้กับหลาย lot ของ buyer คนเดียวกัน
router.patch("/lots/deliver-merged", requireAuth, async (req, res) => {
    try {
        const { lotIds, trackingNumber, shippingProvider } = req.body;
        if (!Array.isArray(lotIds) || !lotIds.length) {
            return res.status(400).json({ error: "ไม่ได้ระบุ lot" });
        }
        if (!trackingNumber) return res.status(400).json({ error: "กรุณากรอกเลข tracking" });

        // ตรวจสิทธิ์ + สถานะของทุก lot ก่อนอัปเดตจริง (NeDB ไม่รองรับ $in — loop findOne)
        const lots = [];
        for (const id of lotIds) {
            const lot = await findOne("lots", { _id: id });
            if (!lot) return res.status(404).json({ error: `ไม่พบ lot: ${id}` });
            const room = await findOne("rooms", { _id: lot.roomId });
            const sellerId = room ? room.sellerId : lot.sellerId;
            if (req.user.role !== "admin" && sellerId !== req.user.id) {
                return res.status(403).json({ error: "ไม่มีสิทธิ์กับ lot บางรายการ" });
            }
            if (!lot.slipConfirmed) {
                return res.status(400).json({ error: `Lot "${lot.name}" ยังไม่ยืนยันสลิป` });
            }
            lots.push(lot);
        }

        const deliveredAt = new Date();
        for (const lot of lots) {
            await update("lots", { _id: lot._id }, {
                $set: { delivered: true, deliveredAt, trackingNumber, shippingProvider: shippingProvider || "" }
            });
        }

        // ทุก lot ในกลุ่มนี้เป็นของ buyer คนเดียวกันเสมอ (merged deliver ทำงานแบบนี้) — แจ้งครั้งเดียวพอ
        const buyerId = lots[0].highestBidderId;
        const lotNames = lots.map(l => `"${l.name}"`).join(", ");
        notifyUser(req, buyerId,
            `🚚 ผู้ขายจัดส่งของแล้ว (${lots.length} lot: ${lotNames}) ` +
            `${shippingProvider ? shippingProvider + " " : ""}เลขพัสดุ: ${trackingNumber}`);

        res.json({ ok: true, count: lots.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/profile/lots/:id/deliver — Seller ส่งของ + tracking
router.patch("/lots/:id/deliver", requireAuth, async (req, res) => {
    try {
        const lot = await findOne("lots", { _id: req.params.id });
        if (!lot) return res.status(404).json({ error: "ไม่พบ lot" });

        const room = await findOne("rooms", { _id: lot.roomId });
        const sellerId = room ? room.sellerId : lot.sellerId;
        if (req.user.role !== "admin" && sellerId !== req.user.id) {
            return res.status(403).json({ error: "ไม่มีสิทธิ์" });
        }

        const { trackingNumber, shippingProvider } = req.body;
        if (!trackingNumber) return res.status(400).json({ error: "กรุณากรอกเลข tracking" });

        await update("lots", { _id: req.params.id }, {
            $set: { delivered: true, deliveredAt: new Date(), trackingNumber, shippingProvider: shippingProvider || "" }
        });

        notifyUser(req, lot.highestBidderId,
            `🚚 ผู้ขายจัดส่งของแล้วสำหรับ "${lot.name}" ` +
            `${shippingProvider ? shippingProvider + " " : ""}เลขพัสดุ: ${trackingNumber}`);

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/profile/lots/:id/receive — Buyer ยืนยันรับของ
router.patch("/lots/:id/receive", requireAuth, async (req, res) => {
    try {
        const lot = await findOne("lots", { _id: req.params.id });
        if (!lot) return res.status(404).json({ error: "ไม่พบ lot" });

        if (lot.highestBidderId !== req.user.id && req.user.role !== "admin") {
            return res.status(403).json({ error: "ไม่มีสิทธิ์" });
        }

        await update("lots", { _id: req.params.id }, {
            $set: { received: true, receivedAt: new Date() }
        });

        const room = await findOne("rooms", { _id: lot.roomId });
        const sellerId = room ? room.sellerId : lot.sellerId;
        notifyUser(req, sellerId,
            `📦 ${req.user.name || "ผู้ซื้อ"} ยืนยันรับของสำหรับ "${lot.name}" แล้ว ตอนนี้ให้คะแนนกันได้เลย`);

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/profile/seller-rooms — คืนทุกห้องของ seller รวมห้องที่ถูกลบแล้ว
// GET /api/profile/lots/:id
router.get("/lots/:id", requireAuth, async (req, res) => {
    try {
        const lot = await findOne("lots", { _id: req.params.id });
        if (!lot) return res.status(404).json({ error: "ไม่พบ lot" });
        res.json(lot);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/profile/seller-rooms ──────────────────────────────────────────
// คืนทุกห้องของ seller รวมห้องที่ถูกลบแล้ว (reconstruct จาก lots ที่มี roomDeleted:true)
router.get('/seller-rooms', requireAuth, async (req, res) => {
    try {
        const sellerId = req.user.id;

        // ห้องที่ยังอยู่
        const activeRooms = await find('rooms', { sellerId }, { createdAt: -1 });
        const activeIds   = new Set(activeRooms.map(r => String(r._id)));

        // lots ของห้องที่ถูกลบ → reconstruct room stub
        const deletedLots = await find('lots', { sellerId, roomDeleted: true });
        const deletedStubs = {};
        for (const l of deletedLots) {
            const key = String(l.roomId);
            if (activeIds.has(key) || deletedStubs[key]) continue;
            deletedStubs[key] = {
                _id:       l.roomId,
                title:     l.roomTitle || 'ห้องที่ถูกลบ',
                sellerId,
                isDeleted: true,
                createdAt: l.createdAt,
            };
        }

        const all = [
            ...activeRooms.map(r => ({ ...r, isDeleted: false })),
            ...Object.values(deletedStubs),
        ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        res.json(all);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// (หมายเหตุ: เดิมมี route GET /seller-lots/:roomId ซ้ำกับตัวที่บรรทัด ~42 ด้านบน —
//  ตัวนั้นเป็น route ที่ Express ใช้จริง (ตัวแรกที่ match เสมอ) ส่วนตัวซ้ำนี้ไม่เคยถูกเรียกเลย
//  (dead code) และ shape response ก็ไม่ตรงกับที่ orders.html ต้องการ (roomTitle/isDeleted/lots)
//  เลยลบออก — ถ้าจะ paginate seller-lots จริงๆ ควรทำฝั่ง client เพราะ orders.html ต้องใช้ lots
//  ทั้งหมดของห้องมาคำนวณ stats (paid/pending/unpaid/shipped) ก่อน ไม่ใช่แค่หน้าที่กำลังโชว์)

// ── GET /api/profile/won-lots ──────────────────────────────────────────────
// Buyer ดู lots ที่ตัวเองชนะ + pagination (สำหรับ profile credit ฝั่ง buyer)
router.get('/won-lots', requireAuth, async (req, res) => {
    try {
        const { page, limit } = parsePage(req, 20);
        const userId = req.user.id;

        const all = await find('lots', {
            highestBidderId: userId,
            isActive: false,
        }, { createdAt: -1 });

        // แนบชื่อห้อง
        const enriched = await Promise.all(all.map(async l => {
            let roomTitle = l.roomTitle || null;
            if (!roomTitle) {
                const room = await findOne('rooms', { _id: l.roomId });
                roomTitle = room ? room.title : 'ไม่ระบุห้อง';
            }
            return { ...l, roomTitle };
        }));

        res.json(paginateArray(enriched, page, limit));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;