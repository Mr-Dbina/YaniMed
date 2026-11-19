"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useSidebarStore } from "@/lib/stores/sidebar-store";
import { SettingsMenu } from "@/components/settings/settings-menu";
import { loadChatThread } from "@/lib/chat-storage";
import {
  ChevronDown,
  ChevronRight,
  ClipboardList,
  GraduationCap,
  LayoutDashboard,
  Moon,
  PanelLeft,
  Plus,
  Search,
  Sun,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Subject } from "@/lib/types";

const RECENTS_OPEN_KEY = "yanimed:recents-open";

const navItems: { label: string; href: string; icon: LucideIcon }[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Subjects", href: "/subjects", icon: GraduationCap },
  { label: "Mock Test", href: "/mock-test", icon: ClipboardList },
];

const subscribeMounted = () => () => {};

interface SidebarProps {
  subjects: Subject[];
  activeSubjectId: string | null;
  currentSubject?: Subject | null;
  onSelectSubject: (id: string) => void;
  onAddSubject: () => void;
  onUpdateSubject?: (id: string, patch: Partial<Omit<Subject, "id">>) => void;
  onDeleteSubject?: (id: string) => void;
}

export function Sidebar({
  currentSubject,
  onAddSubject,
}: SidebarProps) {
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const isCollapsed = useSidebarStore((state) => state.isCollapsed);
  const toggle = useSidebarStore((state) => state.toggle);
  const mounted = useSyncExternalStore(subscribeMounted, () => true, () => false);

  const [prompts, setPrompts] = useState<{ id: string; content: string }[]>([]);
  const [isRecentsOpen, setIsRecentsOpen] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(RECENTS_OPEN_KEY);
      if (stored !== null) return stored === "true";
    } catch {
      // localStorage unavailable
    }
    return true;
  });

  const toggleRecents = () => {
    setIsRecentsOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(RECENTS_OPEN_KEY, String(next));
      } catch {
        // localStorage unavailable
      }
      return next;
    });
  };

  useEffect(() => {
    if (!currentSubject) return undefined;
    const key = currentSubject.backendSubjectId ?? currentSubject.id;
    let cancelled = false;

    void loadChatThread(key)
      .then((thread) => {
        if (cancelled) return;
        if (!thread) {
          setPrompts([]);
          return;
        }
        const userPrompts = thread.messages
          .filter((message) => message.role === "user")
          .map((message) => ({ id: message.id, content: message.content }));
        userPrompts.reverse();
        setPrompts(userPrompts);
      })
      .catch(() => {
        if (!cancelled) setPrompts([]);
      });

    return () => {
      cancelled = true;
    };
  }, [currentSubject, currentSubject?.lastMessage]);

  const displayedPrompts = currentSubject ? prompts : [];

  const handlePromptClick = (messageId: string) => {
    const target = document.getElementById(`msg-${messageId}`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    if (window.matchMedia("(max-width: 767px)").matches) {
      useSidebarStore.setState({ isCollapsed: true });
    }
  };

  const activeTheme = mounted ? resolvedTheme : "light";

  return (
    <aside className={`sidebar${isCollapsed ? " sidebar--collapsed" : ""}`}>
      <div className="sidebar__inner">
        <div className="sidebar__header">
          <span className="sidebar__brand">YaniMed</span>
          <div className="sidebar__header-actions">
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
          <button type="button" className="sidebar__link sidebar__link--button">
            <Search size={18} strokeWidth={1.75} className="sidebar__icon" aria-hidden="true" />
            Search
          </button>
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

        {currentSubject && (
          <div className="sidebar__recents">
            <div className="sidebar__recents-header">
              <button
                type="button"
                className="sidebar__recents-toggle"
                aria-expanded={isRecentsOpen}
                onClick={toggleRecents}
              >
                <span className="sidebar__recents-label">Recents</span>
                {isRecentsOpen ? (
                  <ChevronDown size={15} strokeWidth={1.8} aria-hidden="true" />
                ) : (
                  <ChevronRight size={15} strokeWidth={1.8} aria-hidden="true" />
                )}
              </button>
            </div>

            {isRecentsOpen && displayedPrompts.length > 0 && (
              <div className="sidebar__recents-list" role="list">
                {displayedPrompts.map((prompt) => (
                  <button
                    key={prompt.id}
                    type="button"
                    className="sidebar__recents-item"
                    title={prompt.content}
                    onClick={() => handlePromptClick(prompt.id)}
                  >
                    <span className="sidebar__recents-text">{prompt.content}</span>
                  </button>
                ))}
              </div>
            )}
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
          <button type="button" className="theme-toggle" role="switch"
            aria-label="Appearance" aria-checked={activeTheme === "dark"}
            onClick={() => setTheme(activeTheme === "dark" ? "light" : "dark")}>
            <span
              className={`theme-toggle__option${activeTheme === "light" ? " theme-toggle__option--active" : ""}`}
            >
              <Sun size={14} strokeWidth={1.75} className="sidebar__icon" aria-hidden="true" />
            </span>
            <span
              className={`theme-toggle__option${activeTheme === "dark" ? " theme-toggle__option--active" : ""}`}
            >
              <Moon size={14} strokeWidth={1.75} className="sidebar__icon" aria-hidden="true" />
            </span>
          </button>
        </div>
      </div>
    </aside>
  );
}
