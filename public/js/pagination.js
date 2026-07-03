/**
 * pagination.js — Reusable pagination helper
 * 
 * ใช้งาน:
 *   const pager = createPaginator({
 *     containerId: 'pagination-container',
 *     pageSize: 20,
 *     onPageChange: (page) => loadData(page),
 *   });
 *   pager.render(totalCount);  // เรียกหลังได้ข้อมูล
 */

function createPaginator({ containerId, pageSize = 20, onPageChange }) {
  let currentPage = 1;
  let totalPages  = 1;

  function render(totalCount) {
    totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const container = document.getElementById(containerId);
    if (!container) return;

    if (totalPages <= 1) {
      container.innerHTML = '';
      return;
    }

    const pages = getPagesArray(currentPage, totalPages);

    container.innerHTML = `
      <div class="pagination">
        <button class="page-btn" onclick="__pager_${containerId}.goto(${currentPage - 1})"
          ${currentPage === 1 ? 'disabled' : ''}>‹</button>

        ${pages.map(p => p === '...'
          ? `<span class="page-ellipsis">…</span>`
          : `<button class="page-btn ${p === currentPage ? 'active' : ''}"
               onclick="__pager_${containerId}.goto(${p})">${p}</button>`
        ).join('')}

        <button class="page-btn" onclick="__pager_${containerId}.goto(${currentPage + 1})"
          ${currentPage === totalPages ? 'disabled' : ''}>›</button>

        <span class="page-info">${currentPage} / ${totalPages}</span>
      </div>
    `;
  }

  function goto(page) {
    if (page < 1 || page > totalPages || page === currentPage) return;
    currentPage = page;
    onPageChange(currentPage);
    // re-render จะถูกเรียกใหม่หลัง onPageChange โหลดข้อมูล
  }

  function reset() {
    currentPage = 1;
  }

  function getOffset() {
    return (currentPage - 1) * pageSize;
  }

  // expose ไว้ให้ inline onclick เรียกได้
  window[`__pager_${containerId}`] = { goto };

  return { render, reset, goto, getOffset, getPage: () => currentPage, pageSize };
}

/** สร้าง array ของหน้าพร้อม ellipsis เช่น [1, '...', 4, 5, 6, '...', 10] */
function getPagesArray(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages = [];
  pages.push(1);

  if (current > 4) pages.push('...');

  const start = Math.max(2, current - 1);
  const end   = Math.min(total - 1, current + 1);
  for (let i = start; i <= end; i++) pages.push(i);

  if (current < total - 3) pages.push('...');
  pages.push(total);

  return pages;
}

/* ─── CSS (inject ครั้งเดียว) ─────────────────────────────────────────────── */
(function injectPaginationCSS() {
  if (document.getElementById('pagination-style')) return;
  const style = document.createElement('style');
  style.id = 'pagination-style';
  style.textContent = `
    .pagination {
      display: flex;
      align-items: center;
      gap: 4px;
      justify-content: center;
      margin: 16px 0;
      flex-wrap: wrap;
    }
    .page-btn {
      min-width: 36px;
      height: 36px;
      padding: 0 10px;
      border: 1px solid #ddd;
      border-radius: 8px;
      background: #fff;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.15s;
    }
    .page-btn:hover:not(:disabled) {
      background: #f0f0f0;
      border-color: #bbb;
    }
    .page-btn.active {
      background: #f59e0b;
      color: #fff;
      border-color: #f59e0b;
      font-weight: bold;
    }
    .page-btn:disabled {
      opacity: 0.35;
      cursor: default;
    }
    .page-ellipsis {
      padding: 0 4px;
      color: #999;
    }
    .page-info {
      font-size: 13px;
      color: #888;
      margin-left: 8px;
    }
  `;
  document.head.appendChild(style);
})();
