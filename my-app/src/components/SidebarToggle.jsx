import { useSidebar } from "./SidebarContext";

export function SidebarToggle() {
  const { isCollapsed, toggle, setPreview } = useSidebar();

  if (!isCollapsed) return null;

  return (
    <button
      type="button"
      aria-label="Expand sidebar"
      onClick={toggle}
      onMouseEnter={() => setPreview(true)}
      className="sidebar-toggle"
    >
      <img src="/images/layout.png" alt="Expand sidebar" width={18} height={18} className="icon-mono" />
    </button>
  );
}
