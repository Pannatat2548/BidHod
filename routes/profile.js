const router = require("express").Router();
const { find, findOne, update } = require("../db");
const { requireAuth } = require("../middleware/auth");

// GET /api/profile/:userId — ดึงข้อมูลโปรไฟล์ + สถิติ
router.get("/:userId", async (req, res) => {
    try {
        const userId = req.params.userId;
        const user = await findOne("users", { _id: userId });
        if (!user) return res.status(404).json({ error: "ไม่พบผู้ใช้" });

        // ========== ฝั่ง BUYER ==========
        const wonLots = await find("lots", { highestBidderId: userId }, { createdAt: -1 });
        const paidLots = wonLots.filter(l => l.paid === true);
        const unpaidLots = wonLots.filter(l => l.paid !== true);

        const resolvedWonLots = await Promise.all(wonLots.map(async l => {
            const room = await findOne("rooms", { _id: l.roomId });
            return {
                _id: l._id,
                lotName: l.name,
                roomTitle: room ? room.title : "ไม่ระบุห้อง",
                price: l.currentPrice,
                paid: l.paid || false,
                delivered: l.delivered || false,
                received: l.received || false,
                paymentSlip: l.paymentSlip || null,
                // ── ใหม่: สถานะการตรวจสลิป ──
                slipConfirmed: l.slipConfirmed || false,
                slipRejected: l.slipRejected || false,
                slipRejectReason: l.slipRejectReason || null,
                trackingNumber: l.trackingNumber || null,
                shippingProvider: l.shippingProvider || null,
                endedAt: l.endsAt,
            };
        }));

        // ========== ฝั่ง SELLER ==========
        const sellerRooms = await find("rooms", { sellerId: userId }, { createdAt: -1 });
        const sellerLots = [];
        for (const room of sellerRooms) {
            const lots = await find("lots", { roomId: room._id });
            sellerLots.push(...lots.map(l => ({
                ...l,
                roomTitle: room.title,
                roomHouse: room.house,
            })));
        }

        const receivedLots = sellerLots.filter(l => l.received === true);
        const deliveredLots = sellerLots.filter(l => l.delivered === true && l.received !== true);
        const activeLots = sellerLots.filter(l => l.isActive === true);

        const resolvedSellerLots = await Promise.all(sellerLots.map(async l => {
            return {
                _id: l._id,
                lotName: l.name,
                roomTitle: l.roomTitle,
                currentPrice: l.currentPrice,
                isActive: l.isActive,
                paid: l.paid || false,
                delivered: l.delivered || false,
                received: l.received || false,
                // ── ใหม่: ข้อมูลสลิปสำหรับ seller ──
                paymentSlip: l.paymentSlip || null,
                slipConfirmed: l.slipConfirmed || false,
                slipRejected: l.slipRejected || false,
                slipRejectReason: l.slipRejectReason || null,
                trackingNumber: l.trackingNumber || null,
                shippingProvider: l.shippingProvider || null,
                bidderCount: l.bids?.length || 0
            };
        }));

        res.json({
            user: { ...user, password: undefined },
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
                }
            }
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
        const { facebook, instagram, discord, reddit, phone, otherSocial, otherSocialLabel } = req.body;
        const setObj = {};
        if (facebook !== undefined) setObj.facebook = facebook;
        if (instagram !== undefined) setObj.instagram = instagram;
        if (reddit !== undefined) setObj.reddit = reddit;
        if (discord !== undefined) setObj.discord = discord;
        if (phone !== undefined) setObj.phone = phone;
        if (otherSocial !== undefined) setObj.otherSocial = otherSocial;
        if (otherSocialLabel !== undefined) setObj.otherSocialLabel = otherSocialLabel;

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

        // เฉพาะ seller เจ้าของห้องหรือ admin เท่านั้น
        const room = await findOne("rooms", { _id: lot.roomId });
        if (!room || (room.sellerId !== req.user.id && req.user.role !== "admin")) {
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

        // เฉพาะ seller เจ้าของห้องหรือ admin เท่านั้น
        const room = await findOne("rooms", { _id: lot.roomId });
        if (!room || (room.sellerId !== req.user.id && req.user.role !== "admin")) {
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

        res.json({ ok: true });
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
        if (!room || (room.sellerId !== req.user.id && req.user.role !== "admin")) {
            return res.status(403).json({ error: "ไม่มีสิทธิ์" });
        }

        const { trackingNumber, shippingProvider } = req.body;
        if (!trackingNumber) return res.status(400).json({ error: "กรุณากรอกเลข tracking" });

        await update("lots", { _id: req.params.id }, {
            $set: { delivered: true, deliveredAt: new Date(), trackingNumber, shippingProvider: shippingProvider || "" }
        });

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

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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

module.exports = router;