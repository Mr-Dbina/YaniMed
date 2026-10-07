import { ThemeProvider as NextThemesProvider } from "next-themes";

// Thin wrapper so the app imports a single provider entry point instead of
// depending on next-themes directly everywhere (the shadcn/ui convention).
export function ThemeProvider({ children, ...props }) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
