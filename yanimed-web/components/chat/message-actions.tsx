"use client";

import type { ReactNode } from "react";

export type MessageRole = "user" | "assistant";

export type ActionVisibility = "hover" | "always";

export type ActionAlign = "start" | "end";

export interface MessageAction {
  id: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  /** Renders the pressed state and swaps the tooltip to activeLabel. */
  active?: boolean;
  disabled?: boolean;
  /** Tooltip shown while active, e.g. "Copied". Falls back to label. */
  activeLabel?: string;
}

interface MessageActionsProps {
  actions: MessageAction[];
  visibility: ActionVisibility;
  align?: ActionAlign;
}

/**
 * Visibility is done with opacity instead of conditional rendering so the row
 * always occupies its slot: hovering never reflows the message list, and the
 * buttons stay in the tab order for keyboard users.
 */
export function MessageActions({
  actions,
  visibility,
  align = "start",
}: MessageActionsProps) {
  const hidden =
    visibility === "hover"
      ? "opacity-0 pointer-events-none group-hover/message:opacity-100 group-hover/message:pointer-events-auto group-focus-within/message:opacity-100 group-focus-within/message:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto"
      : "opacity-100";

  return (
    <div
      className={`flex items-center gap-1 pt-1.5 ${align === "end" ? "justify-end" : "justify-start"} ${hidden} transition-opacity duration-150`}
    >
      {actions.map((action) => (
        <span key={action.id} className="group/action relative inline-flex">
          <button
            type="button"
            aria-label={action.label}
            aria-pressed={action.active ?? undefined}
            disabled={action.disabled}
            onClick={action.onClick}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-not-allowed disabled:opacity-50 ${
              action.active
                ? "text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {action.icon}
          </button>
          <span
            role="tooltip"
            className="pointer-events-none absolute top-full left-1/2 z-10 mt-1 -translate-x-1/2 whitespace-nowrap rounded bg-neutral-900 px-1.5 py-0.5 text-[11px] leading-tight text-neutral-50 opacity-0 transition-opacity group-hover/action:opacity-100 group-focus-within/action:opacity-100 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {action.active && action.activeLabel ? action.activeLabel : action.label}
          </span>
        </span>
      ))}
    </div>
  );
}