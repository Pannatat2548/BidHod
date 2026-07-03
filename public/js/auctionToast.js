/**
 * public/js/auctionToast.js
 * 
 * ฟัง auction:warning จาก socket แล้วแสดง toast
 * 
 * วิธีใช้ใน room page (ที่มี socket อยู่แล้ว):
 *   initAuctionToast(socket);
 * 
 * (ไม่ต้องส่ง roomId เพราะ server emit ไปยัง socket ที่ join room อยู่แล้ว)
 */
function initAuctionToast(socket) {
  socket.on('auction:warning', (data) => {
    showToast(data.message, 'warning');
  });
}

// ─── Toast UI ────────────────────────────────────────────────────
let _queue = [], _busy = false;

function showToast(message, type = 'warning') {
  _queue.push({ message, type });
  if (!_busy) _next();
}

function _next() {
  if (!_queue.length) { _busy = false; return; }
  _busy = true;
  const { message, type } = _queue.shift();

  const el = document.createElement('div');
  el.className = `auction-toast auction-toast--${type}`;
  el.textContent = message;
  document.body.appendChild(el);

  requestAnimationFrame(() => el.classList.add('show'));

  setTimeout(() => {
    el.classList.remove('show');
    el.addEventListener('transitionend', () => { el.remove(); _next(); }, { once: true });
  }, 4000);
}

// ─── CSS (inject ครั้งเดียว) ─────────────────────────────────────
(function () {
  if (document.getElementById('auction-toast-css')) return;
  const s = document.createElement('style');
  s.id = 'auction-toast-css';
  s.textContent = `
    .auction-toast {
      position: fixed; bottom: 24px; left: 50%;
      transform: translateX(-50%) translateY(60px);
      opacity: 0; transition: transform .3s, opacity .3s;
      z-index: 9999; padding: 12px 24px; border-radius: 12px;
      font-size: 15px; font-weight: 600;
      box-shadow: 0 4px 16px rgba(0,0,0,.2);
      white-space: nowrap; max-width: 90vw; text-align: center;
    }
    .auction-toast.show { transform: translateX(-50%) translateY(0); opacity: 1; }
    .auction-toast--warning { background: #fef3c7; color: #92400e; border: 1px solid #f59e0b; }
    .auction-toast--closed  { background: #fee2e2; color: #991b1b; border: 1px solid #ef4444; }
  `;
  document.head.appendChild(s);
})();
