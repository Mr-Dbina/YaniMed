import { connection } from "next/server";
import type { ReactNode } from "react";
import { SettingsNav } from "@/components/settings/settings-nav";

// SettingsNav resolves the active row with usePathname(), so no settings route
// can be streamed or prerendered under Cache Components.
export const instant = false;

/**
 * Settings is its own full-page layout. It sits at app/settings/ - outside any
 * route group that renders the main app Sidebar - so the app chrome does not
 * appear here and the settings nav owns the full viewport instead.
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  // SettingsNav resolves the active row with usePathname(), which cannot be
  // statically prerendered under Cache Components.
  await connection();

  return (
    <div className="settings-layout">
      <SettingsNav />
      <main className="settings-layout__main">{children}</main>
    </div>
  );
}
