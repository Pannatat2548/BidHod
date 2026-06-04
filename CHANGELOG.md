# CHANGELOG

## [Unreleased]

### Added
- Added chat notification support on `index.html` via Socket.IO.
- Added navigation back button for chat in `public/messages.html`.
- Added room context support for messages so chat replies route through room owner/seller.
- Added admin chat entry point and admin chat routing logic.

### Changed
- Improved chat bubble rendering and deduplication in `public/messages.html`.
- Refactored message send flow to persist via REST and keep socket updates in sync.
- Preserved room context using `?room=` query parameter when opening chat from an auction room.

### Fixed
- Fixed duplicate message rendering in chat by removing local double-append.
- Fixed back button positioning and moved it into the top navbar for visibility.
- Fixed chat notification behavior on external pages.
