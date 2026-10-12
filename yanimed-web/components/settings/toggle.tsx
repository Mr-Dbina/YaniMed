"use client";

import { useState } from "react";

interface ToggleProps {
  label: string;
  defaultChecked?: boolean;
  /** "green" for the Voice page, "dark" for the personalization switches. */
  variant?: "green" | "dark";
}

/** Accessible on/off switch. Space and Enter both toggle via the native button. */
export function Toggle({ label, defaultChecked = false, variant = "green" }: ToggleProps) {
  // TODO: persist across reloads - the app has no settings persistence yet.
  const [on, setOn] = useState(defaultChecked);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => setOn((v) => !v)}
      className={`setting-toggle setting-toggle--${variant}${on ? " setting-toggle--on" : ""}`}
    >
      <span className="setting-toggle__knob" />
    </button>
  );
}
