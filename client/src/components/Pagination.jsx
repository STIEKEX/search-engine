/** "Page 2 of 7" with Prev / Next, as in the mockup, but with real page counts. */
export default function Pagination({ page, total, limit, onPage }) {
  const pages = Math.ceil(total / limit);
  if (pages <= 1) return null;
  return (
    <nav className="pagination mono" aria-label="Result pages">
      <span className="faint">
        Page {page} of {pages}
      </span>
      <span className="pagination__buttons">
        <button type="button" className="btn" disabled={page === 1} onClick={() => onPage(page - 1)}>
          ← Prev
        </button>
        <button type="button" className="btn" disabled={page === pages} onClick={() => onPage(page + 1)}>
          Next →
        </button>
      </span>
    </nav>
  );
}
