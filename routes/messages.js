const express = require('express');
const router = express.Router();
const { requireAuth: auth } = require('../middleware/auth');
const { db } = require('../db');

// GET /api/messages/conversations — list all conversations for current user
router.get('/conversations', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Find all messages where user is sender or receiver
    const messages = await new Promise((resolve, reject) => {
      db.messages.find({
        $or: [{ senderId: userId }, { receiverId: userId }]
      }).sort({ createdAt: -1 }).exec((err, docs) => {
        if (err) reject(err);
        else resolve(docs);
      });
    });

    // Group by conversation partner
    const convMap = {};
    for (const msg of messages) {
      const partnerId = msg.senderId === userId ? msg.receiverId : msg.senderId;
      if (!convMap[partnerId]) {
        convMap[partnerId] = { lastMessage: msg, unread: 0 };
      }
      if (!msg.readAt && msg.receiverId === userId) {
        convMap[partnerId].unread++;
      }
    }

    // Fetch partner user info
    const partnerIds = Object.keys(convMap);
    const partners = await new Promise((resolve, reject) => {
      db.users.find({ _id: { $in: partnerIds } }, { password: 0 }, (err, docs) => {
        if (err) reject(err);
        else resolve(docs);
      });
    });

    const conversations = partners.map(partner => ({
      partner,
      lastMessage: convMap[partner._id].lastMessage,
      unread: convMap[partner._id].unread
    })).sort((a, b) => b.lastMessage.createdAt - a.lastMessage.createdAt);

    res.json(conversations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/admin — get admin contact info for chat
router.get('/admin', auth, async (req, res) => {
  try {
    db.users.findOne({ role: 'admin' }, { password: 0 }, (err, admin) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!admin) return res.status(404).json({ error: 'ไม่พบผู้ดูแลระบบ' });
      res.json({ admin });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/:userId — get messages between current user and userId
router.get('/:userId', auth, async (req, res) => {
  try {
    const myId = req.user.id;
    const otherId = req.params.userId;

    const messages = await new Promise((resolve, reject) => {
      db.messages.find({
        $or: [
          { senderId: myId, receiverId: otherId },
          { senderId: otherId, receiverId: myId }
        ]
      }).sort({ createdAt: 1 }).exec((err, docs) => {
        if (err) reject(err);
        else resolve(docs);
      });
    });

    // Mark messages as read
    await new Promise((resolve, reject) => {
      db.messages.update(
        { senderId: otherId, receiverId: myId, readAt: { $exists: false } },
        { $set: { readAt: Date.now() } },
        { multi: true },
        (err) => { if (err) reject(err); else resolve(); }
      );
    });

    // Fetch other user info
    let otherUser = await new Promise((resolve, reject) => {
      db.users.findOne({ _id: otherId }, { password: 0 }, (err, doc) => {
        if (err) reject(err);
        else resolve(doc);
      });
    });

    // If the target user ID no longer exists, but is attached to a room as seller, fallback to room seller metadata.
    if (!otherUser) {
      otherUser = await new Promise((resolve, reject) => {
        db.rooms.findOne({ sellerId: otherId }, (err, room) => {
          if (err) reject(err);
          else if (!room) resolve(null);
          else resolve({ _id: otherId, name: room.sellerName || 'ผู้ใช้', role: 'seller' });
        });
      });
    }

    if (!otherUser) {
      return res.status(404).json({ error: 'ไม่พบผู้ใช้ปลายทาง' });
    }

    res.json({ messages, otherUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/messages/:userId — send a message and persist it
router.post('/:userId', auth, async (req, res) => {
  try {
    const senderId = req.user.id;
    const receiverId = req.params.userId;
    const { text, roomId } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    const msg = {
      senderId,
      receiverId,
      text: text.trim(),
      createdAt: Date.now()
    };

    // If room context is provided, associate message with that room
    if (roomId) {
      msg.roomId = roomId;
    }

    const saved = await new Promise((resolve, reject) => {
      db.messages.insert(msg, (err, doc) => {
        if (err) reject(err);
        else resolve(doc);
      });
    });

    const io = req.app.get('io');
    if (io) {
      const chatRoomId = [senderId, receiverId].sort().join('_');
      io.to(`chat:${chatRoomId}`).emit('chat:message', saved);
      io.to(`user:${receiverId}`).emit('chat:notification', {
        fromId: senderId,
        preview: saved.text.substring(0, 60)
      });
    }

    res.status(201).json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
