"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useSidebarStore } from "@/lib/stores/sidebar-store";
import { SettingsMenu } from "@/components/settings/settings-menu";
import { DeleteSubjectModal } from "@/components/delete-subject-modal";
import {
  Archive,
  Bell,
  ClipboardList,
  GraduationCap,
  Moon,
  PanelLeft,
  Plus,
  Search,
  Sun,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Subject } from "@/lib/types";

const navItems: { label: string; href: string; icon: LucideIcon }[] = [
  { label: "Subjects", href: "/subjects", icon: GraduationCap },
  { label: "Mock Test", href: "/mock-test", icon: ClipboardList },
];

interface SidebarProps {
  subjects: Subject[];
  activeSubjectId: string | null;
  onSelectSubject: (id: string) => void;
  onAddSubject: () => void;
  onUpdateSubject: (id: string, patch: Partial<Omit<Subject, "id">>) => void;
  onDeleteSubject: (id: string) => void;
}

export function Sidebar({
  subjects,
  activeSubjectId,
  onSelectSubject,
  onAddSubject,
  onUpdateSubject,
  onDeleteSubject,
}: SidebarProps) {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const isCollapsed = useSidebarStore((state) => state.isCollapsed);
  const isPreview = useSidebarStore((state) => state.isPreview);
  const toggle = useSidebarStore((state) => state.toggle);
  const setPreview = useSidebarStore((state) => state.setPreview);
  const [mounted, setMounted] = useState(false);
  const [menuSubjectId, setMenuSubjectId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const subjectsRef = useRef<HTMLDivElement>(null);

  const startRename = (subject: Subject) => {
    setRenameValue(subject.name);
    setRenamingId(subject.id);
  };

  const commitRename = (id: string) => {
    const next = renameValue.trim();
    if (next) onUpdateSubject(id, { name: next });
    setRenamingId(null);
  };

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  useEffect(() => {
    if (!menuSubjectId) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!subjectsRef.current?.contains(event.target as Node)) setMenuSubjectId(null);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuSubjectId(null);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [menuSubjectId]);

  const pendingDelete = subjects.find((s) => s.id === pendingDeleteId) ?? null;

  useEffect(() => setMounted(true), []);

  const activeTheme = mounted ? theme : "light";
  const isVisuallyCollapsed = isCollapsed && !isPreview;

  return (
    <aside
      className={`sidebar${isVisuallyCollapsed ? " sidebar--collapsed" : ""}`}
      onMouseEnter={() => {
        if (isCollapsed) setPreview(true);
      }}
      onMouseLeave={() => setPreview(false)}
    >
      <div className="sidebar__inner">
        <div className="sidebar__header">
          <span className="sidebar__brand">YaniMed</span>
          <div className="sidebar__header-actions">
            <button type="button" aria-label="Search" className="icon-button">
              <Search size={18} strokeWidth={1.75} className="sidebar__icon" aria-hidden="true" />
            </button>
            <button type="button" aria-label="Notifications" className="icon-button">
              <Bell size={18} strokeWidth={1.75} className="sidebar__icon" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Collapse sidebar"
              onClick={toggle}
              className="icon-button"
            >
              <PanelLeft size={18} strokeWidth={1.75} className="sidebar__icon" aria-hidden="true" />
            </button>
          </div>
        </div>

        <button type="button" className="sidebar__new" onClick={onAddSubject}>
          <Plus size={18} strokeWidth={1.75} className="sidebar__icon" aria-hidden="true" />
          New
        </button>

        <nav className="sidebar__nav">
          {navItems.map((item) => {
            const active = pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`sidebar__link${active ? " sidebar__link--active" : ""}`}
              >
                <Icon size={18} strokeWidth={1.75} className="sidebar__icon" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {subjects.length > 0 && (
          <div className="sidebar__subjects" ref={subjectsRef}>
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
              <div key={subject.id} className="sidebar__subject-row">
                <button
                  type="button"
                  className={`sidebar__subject${subject.id === activeSubjectId ? " sidebar__subject--active" : ""}`}
                  onClick={() => {
                    setMenuSubjectId(null);
                    onSelectSubject(subject.id);
                  }}
                >
                  <Archive size={18} strokeWidth={1.75} className="sidebar__icon" aria-hidden="true" />
                  {renamingId === subject.id ? (
                    <input
                      ref={renameInputRef}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => commitRename(subject.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(subject.id);
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      className="sidebar__subject-rename"
                      aria-label={`Rename ${subject.name}`}
                    />
                  ) : (
                    <span className="sidebar__subject-name">{subject.name}</span>
                  )}
                </button>

                <button
                  type="button"
                  className="sidebar__subject-more"
                  aria-label={`Actions for ${subject.name}`}
                  aria-haspopup="menu"
                  aria-expanded={menuSubjectId === subject.id}
                  onClick={() =>
                    setMenuSubjectId(menuSubjectId === subject.id ? null : subject.id)
                  }
                >
                  <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor" aria-hidden="true">
                    <circle cx="5" cy="12" r="1.8" />
                    <circle cx="12" cy="12" r="1.8" />
                    <circle cx="19" cy="12" r="1.8" />
                  </svg>
                </button>

                {subject.lastMessage ? (
                  <p className="sidebar__subject-preview">{subject.lastMessage}</p>
                ) : null}

                {menuSubjectId === subject.id ? (
                  <div role="menu" className="sidebar__subject-menu">
                    <button
                      type="button"
                      role="menuitem"
                      className="sidebar__subject-menu-item"
                      onClick={() => {
                        setMenuSubjectId(null);
                        startRename(subject);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="sidebar__subject-menu-item sidebar__subject-menu-item--danger"
                      onClick={() => {
                        setMenuSubjectId(null);
                        setPendingDeleteId(subject.id);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="sidebar__bottom">
        <div className="sidebar__settings">
          <SettingsMenu />
        </div>

        <div className="sidebar__row sidebar__footer">
          <span className="sidebar__footer-label">
            {activeTheme === "dark" ? (
              <Moon size={20} strokeWidth={1.7} className="sidebar__icon" aria-hidden="true" />
            ) : (
              <Sun size={20} strokeWidth={1.7} className="sidebar__icon" aria-hidden="true" />
            )}
            Appearance
          </span>
          <div className="theme-toggle">
            <button
              type="button"
              aria-label="Light mode"
              onClick={() => setTheme("light")}
              className={`theme-toggle__option${activeTheme === "light" ? " theme-toggle__option--active" : ""}`}
            >
              <Sun size={14} strokeWidth={1.75} className="sidebar__icon" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Dark mode"
              onClick={() => setTheme("dark")}
              className={`theme-toggle__option${activeTheme === "dark" ? " theme-toggle__option--active" : ""}`}
            >
              <Moon size={14} strokeWidth={1.75} className="sidebar__icon" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <DeleteSubjectModal
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDeleteId(null);
        }}
        subjectName={pendingDelete?.name ?? ""}
        onConfirm={() => {
          if (pendingDeleteId) onDeleteSubject(pendingDeleteId);
          setPendingDeleteId(null);
        }}
      />
    </aside>
  );
}
