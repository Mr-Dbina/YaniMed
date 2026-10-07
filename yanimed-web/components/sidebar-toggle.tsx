"use client";

import { useSidebarStore } from "@/lib/stores/sidebar-store";

export function SidebarToggle() {
  const isCollapsed = useSidebarStore((state) => state.isCollapsed);
  const toggle = useSidebarStore((state) => state.toggle);
  const setPreview = useSidebarStore((state) => state.setPreview);

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
