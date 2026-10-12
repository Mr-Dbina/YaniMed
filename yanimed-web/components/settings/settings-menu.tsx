"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Settings } from "lucide-react";
import { settingsItems } from "@/components/settings/settings-items";

const CLOSE_DELAY_MS = 150;

export function SettingsMenu() {
  const pathname = usePathname();
  // The opened path is stored alongside the flag so a route change closes the
  // panel without a setState-in-effect (which would cascade renders).
  const [state, setState] = useState({ open: false, path: pathname });
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLAnchorElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuId = useId();

  const open = state.open && state.path === pathname;

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const close = useCallback(
    (returnFocus: boolean) => {
      cancelClose();
      setState((prev) => ({ open: false, path: prev.path }));
      setActiveIndex(-1);
      // Focus returns to the trigger so keyboard users are not dropped at the
      // top of the document after the panel unmounts.
      if (returnFocus) triggerRef.current?.focus();
    },
    [cancelClose],
  );

  const openMenu = useCallback(
    (index?: number) => {
      cancelClose();
      setState({ open: true, path: pathname });
      setActiveIndex(index ?? -1);
    },
    [cancelClose, pathname],
  );

  // Leaving the whole wrapper (trigger + panel) closes after a short delay.
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => close(false), CLOSE_DELAY_MS);
  }, [cancelClose, close]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) close(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open, close]);

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const start = event.key === "ArrowUp" ? settingsItems.length - 1 : 0;
      openMenu(start);
      itemRefs.current[start]?.focus();
    }
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const { key } = event;
    const last = settingsItems.length - 1;

    if (key === "ArrowDown") {
      event.preventDefault();
      const next = activeIndex + 1 >= settingsItems.length ? 0 : activeIndex + 1;
      setActiveIndex(next);
      itemRefs.current[next]?.focus();
    } else if (key === "ArrowUp") {
      event.preventDefault();
      const next = activeIndex - 1 < 0 ? last : activeIndex - 1;
      setActiveIndex(next);
      itemRefs.current[next]?.focus();
    } else if (key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      itemRefs.current[0]?.focus();
    } else if (key === "End") {
      event.preventDefault();
      setActiveIndex(last);
      itemRefs.current[last]?.focus();
    } else if (key === "Tab") {
      close(true);
    }
  };

  return (
    <div
      className="settings-menu"
      ref={wrapperRef}
      onMouseEnter={() => openMenu()}
      onMouseLeave={scheduleClose}
    >
      {open ? (
        // No gap between trigger and panel: the panel sits flush at bottom-full
        // and its own padding-top is the invisible hover bridge, so the pointer
        // can travel upward without crossing dead space.
        <div
          ref={panelRef}
          id={menuId}
          role="menu"
          aria-labelledby={`${menuId}-trigger`}
          className="settings-menu__panel"
          onKeyDown={onMenuKeyDown}
          onMouseEnter={cancelClose}
          onMouseLeave={() => {
            cancelClose();
            // Keyboard navigation moves real focus, which keeps :focus-visible
            // stuck on the last item after the pointer leaves. Drop both the
            // index and the focus so the highlight cannot linger.
            setActiveIndex(-1);
            const el = document.activeElement;
            if (el instanceof HTMLElement && panelRef.current?.contains(el)) {
              el.blur();
            }
          }}
        >
          <div className="settings-menu__surface">
            {settingsItems.map((item, index) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  role="menuitem"
                  tabIndex={index === activeIndex ? 0 : -1}
                  className="settings-menu__item"
                  aria-current={pathname === item.href ? "page" : undefined}
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  onClick={() => close(false)}
                >
                  <Icon size={18} strokeWidth={1.75} className="settings-menu__icon" aria-hidden="true" />
                  <span className="settings-menu__label">{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      ) : null}

      <Link
        id={`${menuId}-trigger`}
        ref={triggerRef}
        href="/settings/general"
        className="sidebar__row settings-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onFocus={() => openMenu()}
        onBlur={(event) => {
          if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node)) {
            close(false);
          }
        }}
        onClick={() => close(false)}
        onKeyDown={onTriggerKeyDown}
      >
        <Settings size={18} strokeWidth={1.75} className="settings-menu__icon" aria-hidden="true" />
        <span>Settings</span>
      </Link>
    </div>
  );
}
