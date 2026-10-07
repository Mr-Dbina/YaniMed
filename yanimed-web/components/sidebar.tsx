"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useSidebarStore } from "@/lib/stores/sidebar-store";
import type { Subject } from "@/lib/types";

const navItems = [
  { label: "Subjects", href: "/subjects", icon: "/images/graduate-hat.png" },
  { label: "Mock Test", href: "/mock-test", icon: "/images/clipboard.png" },
];

interface SidebarProps {
  subjects: Subject[];
  activeSubjectId: string | null;
  onSelectSubject: (id: string) => void;
  onAddSubject: () => void;
}

export function Sidebar({
  subjects,
  activeSubjectId,
  onSelectSubject,
  onAddSubject,
}: SidebarProps) {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const { isCollapsed, toggle } = useSidebarStore();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const activeTheme = mounted ? theme : "light";

  return (
    <>
      <aside className={`sidebar${isCollapsed ? " sidebar--collapsed" : ""}`}>
        <div className="sidebar__inner">
          <div className="sidebar__header">
            <span className="sidebar__brand">YaniMed</span>
            <div className="sidebar__header-actions">
              <button type="button" aria-label="Search" className="icon-button">
                <img src="/images/magnifying-glass.png" alt="Search" width={18} height={18} className="icon-mono" />
              </button>
              <button type="button" aria-label="Notifications" className="icon-button">
                <img src="/images/notification.png" alt="Notifications" width={18} height={18} className="icon-mono" />
              </button>
              <button
                type="button"
                aria-label="Collapse sidebar"
                onClick={toggle}
                className="icon-button"
              >
                <img src="/images/layout.png" alt="Collapse sidebar" width={18} height={18} className="icon-mono" />
              </button>
            </div>
          </div>

          <button type="button" className="sidebar__new" onClick={onAddSubject}>
            <img src="/images/plus.png" alt="" width={18} height={18} className="icon-mono" />
            New
          </button>

          <nav className="sidebar__nav">
            {navItems.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`sidebar__link${active ? " sidebar__link--active" : ""}`}
                >
                  <img src={item.icon} alt={item.label} width={18} height={18} className="icon-mono" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {subjects.length > 0 && (
            <div className="sidebar__subjects">
              <div className="sidebar__subjects-header">
                <span className="sidebar__subjects-label">Subjects</span>
                <button
                  type="button"
                  aria-label="Add subject"
                  className="sidebar__subjects-add"
                  onClick={onAddSubject}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
              </div>
              {subjects.map((subject) => (
                <button
                  key={subject.id}
                  type="button"
                  className={`sidebar__subject${subject.id === activeSubjectId ? " sidebar__subject--active" : ""}`}
                  onClick={() => onSelectSubject(subject.id)}
                >
                  <img src="/images/archive.png" alt="" width={18} height={18} className="icon-mono" />
                  <span className="sidebar__subject-name">{subject.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="sidebar__footer">
          <span className="sidebar__footer-label">
            <img
              src={activeTheme === "dark" ? "/images/moon.png" : "/images/sunny.png"}
              alt="Appearance"
              width={18}
              height={18}
              className="icon-mono"
            />
            Appearance
          </span>
          <div className="theme-toggle">
            <button
              type="button"
              aria-label="Light mode"
              onClick={() => setTheme("light")}
              className={`theme-toggle__option${activeTheme === "light" ? " theme-toggle__option--active" : ""}`}
            >
              <img src="/images/sunny.png" alt="Light mode" width={14} height={14} className="icon-mono" />
            </button>
            <button
              type="button"
              aria-label="Dark mode"
              onClick={() => setTheme("dark")}
              className={`theme-toggle__option${activeTheme === "dark" ? " theme-toggle__option--active" : ""}`}
            >
              <img src="/images/moon.png" alt="Dark mode" width={14} height={14} className="icon-mono" />
            </button>
          </div>
        </div>
      </aside>

      {isCollapsed && (
        <button
          type="button"
          aria-label="Expand sidebar"
          onClick={toggle}
          className="sidebar-expand"
        >
          <img src="/images/layout.png" alt="Expand sidebar" width={18} height={18} className="icon-mono" />
        </button>
      )}
    </>
  );
}
