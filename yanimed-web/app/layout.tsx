import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";

export const metadata: Metadata = {
  title: "YaniMed",
  description: "YaniMed study assistant",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      {/* suppressHydrationWarning: next-themes writes the theme class before
          React hydrates, and browser extensions (Grammarly et al.) inject their
          own data-* attributes onto <body> pre-hydration. Both are expected
          diffs. Deliberately one level deep - it covers <body>'s own
          attributes only, so real mismatches deeper in the tree still warn. */}
      <body suppressHydrationWarning>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
