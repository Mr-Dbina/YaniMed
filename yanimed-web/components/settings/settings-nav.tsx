"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, ChevronRight, Info, Search } from "lucide-react";
import { settingsItems } from "@/components/settings/settings-items";

export function SettingsNav() {
  const pathname = usePathname();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? settingsItems.filter((i) => i.label.toLowerCase().includes(q))
      : settingsItems;
  }, [query]);

  return (
    <nav className="settings-nav">
      {/* Always goes straight to the app index. router.back() would only undo
          one click, so from a deep settings page it walked the user back
          through every settings page they had visited first. */}
      <Link href="/" className="settings-nav__back">
        <ArrowLeft size={16} strokeWidth={1.7} aria-hidden="true" />
        Back
      </Link>

      {/* Mobile menu header: round back, centered title, round info. */}
      <div className="settings-nav__mobile-top">
        <Link href="/" className="settings-nav__icon-btn" aria-label="Back">
          <ArrowLeft size={18} strokeWidth={1.7} aria-hidden="true" />
        </Link>
        <span className="settings-nav__title">Settings</span>
        <button
          type="button"
          className="settings-nav__icon-btn"
          aria-label="Settings information"
          data-todo="no-destination"
        >
          <Info size={18} strokeWidth={1.7} aria-hidden="true" />
        </button>
      </div>

      <div className="settings-nav__search">
        <Search size={15} strokeWidth={1.7} aria-hidden="true" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings"
          aria-label="Search settings"
          className="settings-nav__search-input"
        />
      </div>

      <p className="settings-nav__group">Personal</p>

      <div className="settings-nav__items">
        {filtered.length === 0 ? (
          <p className="settings-nav__empty">No results</p>
        ) : (
          filtered.map((item) => {
            // On the mobile menu (/settings) General is the default section, so
            // it keeps the active treatment there too.
            const active =
              pathname === item.href ||
              (pathname === "/settings" && item.href === "/settings/general");
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`settings-nav__item nav-item${active ? " settings-nav__item--active" : ""}`}
                aria-current={active ? "page" : undefined}
                data-active={active}
              >
                <span className="nav-icon">
                  <Icon size={17} strokeWidth={1.7} className="sidebar__icon" aria-hidden="true" />
                </span>
                <span className="settings-nav__label">{item.label}</span>
                <ChevronRight
                  size={17}
                  strokeWidth={1.7}
                  className="settings-nav__chevron"
                  aria-hidden="true"
                />
              </Link>
            );
          })
        )}
      </div>
    </nav>
  );
}
