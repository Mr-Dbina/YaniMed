/**
 * Theme registry.
 *
 * YaniMed currently ships exactly one theme, so this does not introduce a
 * parallel palette: the values below are derived from the tokens already
 * applied in globals.css (:root and .dark), which remain the single source of
 * truth for what the user actually sees. Selecting a theme sets `data-theme`
 * on <html> so a second theme only needs CSS to be added.
 */

export interface ThemeVariant {
  accent: string;
  background: string;
  foreground: string;
  border: string;
  surface: string;
  muted: string;
  mutedForeground: string;
}

export interface AppTheme {
  id: string;
  label: string;
  /** Logo asset shown in the theme row. */
  icon?: string;
  light: ThemeVariant;
  dark: ThemeVariant;
  fontFamily: string;
}

/** Raw HSL triplets, matching globals.css. Converted for display only. */
const LIGHT_TOKENS = {
  accent: "328 100% 45%",
  background: "0 0% 98%",
  foreground: "221 39% 11%",
  border: "220 13% 91%",
  surface: "0 0% 100%",
  muted: "220 14% 96%",
  mutedForeground: "220 9% 46%",
} as const;

const DARK_TOKENS = {
  accent: "328 100% 45%",
  background: "222 28% 8%",
  foreground: "210 20% 96%",
  border: "220 15% 24%",
  surface: "221 25% 12%",
  muted: "220 15% 18%",
  mutedForeground: "220 9% 65%",
} as const;

function toVariant(tokens: Record<keyof typeof LIGHT_TOKENS, string>): ThemeVariant {
  return {
    accent: tokens.accent,
    background: tokens.background,
    foreground: tokens.foreground,
    border: tokens.border,
    surface: tokens.surface,
    muted: tokens.muted,
    mutedForeground: tokens.mutedForeground,
  };
}

/** "40 33% 97%" -> "#FAF8F5" for the colour pills. */
export function hslTripletToHex(triplet: string): string {
  // parseFloat strips the "%" - Number("33%") would be NaN.
  const [h, s, l] = triplet.split(" ").map(parseFloat);
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const hPrime = (h % 360) / 60;
  const x = c * (1 - Math.abs((hPrime % 2) - 1));
  const [r1, g1, b1] =
    hPrime < 1
      ? [c, x, 0]
      : hPrime < 2
        ? [x, c, 0]
        : hPrime < 3
          ? [0, c, x]
          : hPrime < 4
            ? [0, x, c]
            : hPrime < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = light - c / 2;
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`.toUpperCase();
}

const yanimedTheme: AppTheme = {
  id: "yanimed",
  label: "YaniMed",
  icon: "/images/yanimed_logo.png",
  light: toVariant(LIGHT_TOKENS),
  dark: toVariant(DARK_TOKENS),
  fontFamily:
    'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
};

export const themes: AppTheme[] = [yanimedTheme];

export const defaultThemeId = yanimedTheme.id;

export function getTheme(id: string): AppTheme {
  return themes.find((theme) => theme.id === id) ?? yanimedTheme;
}

const THEME_STORAGE_KEY = "yanimed:theme";

/**
 * Applied theme is persisted separately from next-themes' mode, so changing the
 * theme never resets the user's Light/Dark/System choice.
 */
export function readStoredTheme(): string {
  if (typeof window === "undefined") return defaultThemeId;
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) ?? defaultThemeId;
  } catch {
    return defaultThemeId;
  }
}

export function storeTheme(id: string): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // Storage unavailable - the theme still applies for this session.
  }
}