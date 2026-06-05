# CHANGELOG

## [Unreleased]

### Added
- Added chat notification support on `index.html` via Socket.IO.
- Added navigation back button for chat in `public/messages.html`.
- Added room context support for messages so chat replies route through room owner/seller.
- Added admin chat entry point and admin chat routing logic.
- Added Buy It Now (BIN) price field per lot in `create-room.html`.
- Added BIN bulk/range setter — กำหนด BIN เป็นกลุ่มได้พร้อมกับราคาเริ่มต้น.
- Added "⚡ ซื้อทันที" button in `room.html` — แสดงเมื่อ lot มี `binPrice`.
- Added `bin:place` socket event in `server.js` — ปิด lot ทันทีเมื่อกด BIN.
- Added `lot:bin` socket broadcast — อัปเดต UI ทุกคนในห้องเมื่อมีคนซื้อ BIN.
- Added Anti-snipe extension duration field in `create-room.html` — ตั้งได้ต่อห้อง.
- Added `snipeExt` / `snipeTrigger` fields in `routes/rooms.js` — เก็บค่าลง DB ต่อ lot.

### Changed
- Improved chat bubble rendering and deduplication in `public/messages.html`.
- Refactored message send flow to persist via REST and keep socket updates in sync.
- Preserved room context using `?room=` query parameter when opening chat from an auction room.
- Anti-snipe trigger now uses `snipeExt` value as threshold — ต่อเวลาเมื่อเหลือน้อยกว่าค่าที่ตั้ง.
- Anti-snipe extension is now optional — ไม่กรอก = ไม่ต่อเวลาเลย (เดิม hardcode 30 วิ).
- BIN range apply now clears BIN field if left empty — ไม่ทิ้งค่าเก่าค้างไว้.
- Clear all prices now also clears BIN fields.

### Fixed
- Fixed duplicate message rendering in chat by removing local double-append.
- Fixed back button positioning and moved it into the top navbar for visibility.
- Fixed chat notification behavior on external pages.
- Fixed `binPrice` not saving to DB — เพิ่ม field ใน `routes/rooms.js` insert.
- Fixed anti-snipe triggering when time > threshold — เปลี่ยนจาก hardcode 60s เป็นใช้ค่าจาก lot.