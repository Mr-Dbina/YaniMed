"use client";

import { useEffect, type ReactNode, Suspense } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { SettingsNav } from "@/components/settings/settings-nav";

/**
 * Settings is its own full-page layout. It sits at app/settings/ - outside any
 * route group that renders the main app Sidebar - so the app chrome does not
 * appear here and the settings nav owns the full viewport instead.
 *
 * Below 768px the nav becomes the menu page and each section is a full-width
 * page with its own back link. At 768px and up the nav is a fixed left column.
 */
function SettingsLayoutInner({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isIndex = pathname === "/settings";

  // Desktop keeps the old /settings -> /settings/general behaviour. On mobile
  // /settings is the menu, so the redirect must not run there.
  useEffect(() => {
    if (isIndex && window.matchMedia("(min-width: 768px)").matches) {
      router.replace("/settings/general");
    }
  }, [isIndex, router]);

  return (
    <div className={`settings-layout${isIndex ? " settings-layout--index" : ""}`}>
      <SettingsNav />

      <main className="settings-layout__main">
        {isIndex ? null : (
          <Link href="/settings" className="settings-mobile-back" aria-label="Back to settings">
            <ArrowLeft size={18} strokeWidth={1.7} aria-hidden="true" />
          </Link>
        )}
        {children}
      </main>
    </div>
  );
}

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <SettingsLayoutInner>{children}</SettingsLayoutInner>
    </Suspense>
  );
}
