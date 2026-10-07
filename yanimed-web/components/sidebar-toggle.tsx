"use client";

import { useSidebarStore } from "@/lib/stores/sidebar-store";

export function SidebarToggle() {
  const isCollapsed = useSidebarStore((state) => state.isCollapsed);
  const toggle = useSidebarStore((state) => state.toggle);
  const setPreview = useSidebarStore((state) => state.setPreview);

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
