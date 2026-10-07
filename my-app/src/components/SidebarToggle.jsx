import { useSidebar } from "./SidebarContext";

export function SidebarToggle() {
  const { isCollapsed, toggle, setPreview } = useSidebar();

  return (
    <button
      type="button"
      aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      onClick={toggle}
      onMouseEnter={() => {
        if (isCollapsed) setPreview(true);
      }}
      className="sidebar-toggle"
    >
      <img src="/images/layout.png" alt="" width={18} height={18} className="icon-mono" />
    </button>
  );
}
