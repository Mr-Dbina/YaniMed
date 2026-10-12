import type { ReactNode } from "react";
import { SettingsNav } from "@/components/settings/settings-nav";

/**
 * Settings is its own full-page layout. It sits at app/settings/ - outside any
 * route group that renders the main app Sidebar - so the app chrome does not
 * appear here and the settings nav owns the full viewport instead.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="settings-layout">
      <SettingsNav />
      <main className="settings-layout__main">{children}</main>
    </div>
  );
}
