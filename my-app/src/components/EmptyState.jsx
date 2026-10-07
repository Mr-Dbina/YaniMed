// Decorative illustration and button glyph use plain <img> assets from /images/.
// The same folder illustration is reused for light and dark mode.
import "./EmptyState.css";

export function EmptyState({ onCreateSubject }) {
  return (
    <div className="empty-state">
      <img
        src="/images/Empty%20folder%20artwork.png"
        alt=""
        width={160}
        height={160}
        className="empty-state__art"
      />

      <h2 className="empty-state__title">No File Yet</h2>
      <p className="empty-state__text">
        You haven&apos;t created any subject yet. Start by creating your first
        subject to see it here.
      </p>

      <button type="button" onClick={onCreateSubject} className="empty-state__button">
        <img src="/images/plus.png" alt="" width={16} height={16} />
        Create Subject
      </button>
    </div>
  );
}
