"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Check, ChevronDown } from "lucide-react";
import { ModePreviewSelector, isModeId } from "@/components/settings/mode-preview-selector";
import type { ModeId } from "@/components/settings/mode-preview-selector";
import { SettingRow } from "@/components/settings/setting-row";
import { getTheme, hslTripletToHex, readStoredTheme, storeTheme, themes } from "@/lib/themes";

/** A colour readout. Read-only until the token system supports overrides. */
function ColorPill({ value }: { value: string }) {
  return (
    <span className="appearance__color">
      <span className="appearance__swatch" style={{ background: value }} aria-hidden="true" />
      {value}
    </span>
  );
}

/** Three-way segmented control. */
function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div className="appearance__segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={`appearance__segment${value === option.id ? " appearance__segment--active" : ""}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** next-themes returns undefined for the real theme until the client hydrates.
 * useSyncExternalStore gives that flag without a setState-in-effect, so the
 * server and first client render agree and there is no flash. */
const noopSubscribe = () => () => {};
const useMounted = () => useSyncExternalStore(noopSubscribe, () => true, () => false);

export default function AppearanceSettingsPage() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const [themeId, setThemeId] = useState(readStoredTheme);
  const [themeOpen, setThemeOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [reduceMotion, setReduceMotion] = useState<"system" | "on" | "off">("system");
  const [separateModes, setSeparateModes] = useState(false);
  const [contrast, setContrast] = useState(45);
  const [diffMarkers, setDiffMarkers] = useState<"color" | "signs">("color");
  const themeMenuRef = useRef<HTMLDivElement>(null);

  // next-themes returns undefined for the real theme until mounted; rendering
  // the default first keeps the server and client markup identical.
  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!themeMenuRef.current?.contains(event.target as Node)) setThemeOpen(false);
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setThemeOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Applies the theme by tagging <html>; a second theme only needs CSS.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", themeId);
  }, [themeId]);

  const activeTheme = getTheme(themeId);
  const storedMode = mounted ? theme : "system";
  const resolvedMode: ModeId = isModeId(storedMode) ? storedMode : "system";
  const variant = resolvedMode === "dark" ? activeTheme.dark : activeTheme.light;

  const chooseTheme = (id: string) => {
    setThemeId(id);
    storeTheme(id);
    setThemeOpen(false);
  };

  return (
    <>
      <h1 className="settings-page-title">Appearance</h1>

      <h2 className="setting-section-title">Visual style</h2>

      <div className="setting-card">
        <div className="setting-row">
          <div className="setting-row__text">
            <span className="setting-row__label">Mode</span>
          </div>
          <div className="setting-row__control">
            <ModePreviewSelector value={resolvedMode} onChange={setTheme} />
          </div>
        </div>
      </div>

      <div className="setting-card">
        <div className="setting-row">
          <div className="setting-row__text">
            <span className="setting-row__label">Theme</span>
          </div>
          <div className="setting-row__control">
            <div className="appearance__theme-menu" ref={themeMenuRef}>
              <button
                type="button"
                className="appearance__theme-trigger"
                aria-haspopup="listbox"
                aria-expanded={themeOpen}
                onClick={() => setThemeOpen((open) => !open)}
              >
                {activeTheme.icon ? (
                  <img src={activeTheme.icon} alt="" width={18} height={18} />
                ) : null}
                <span>{activeTheme.label}</span>
                <ChevronDown size={15} strokeWidth={1.7} aria-hidden="true" />
              </button>

              {themeOpen ? (
                <div className="appearance__theme-list" role="listbox" aria-label="Theme">
                  {themes.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="option"
                      aria-selected={option.id === themeId}
                      className="appearance__theme-option"
                      onClick={() => chooseTheme(option.id)}
                    >
                      {option.icon ? (
                        <img src={option.icon} alt="" width={18} height={18} />
                      ) : null}
                      <span>{option.label}</span>
                      {option.id === themeId ? (
                        <Check size={15} strokeWidth={1.9} aria-hidden="true" />
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* TODO: colour overrides need the token system to accept runtime values. */}
        <SettingRow label="Accent">
          <ColorPill value={hslTripletToHex(variant.accent)} />
        </SettingRow>
        <SettingRow label="Background">
          <ColorPill value={hslTripletToHex(variant.background)} />
        </SettingRow>
        <SettingRow label="Foreground">
          <ColorPill value={hslTripletToHex(variant.foreground)} />
        </SettingRow>
      </div>

      <button
        type="button"
        className="appearance__advanced-toggle"
        aria-expanded={advancedOpen}
        onClick={() => setAdvancedOpen((open) => !open)}
      >
        <span>Advanced</span>
        <ChevronDown
          size={16}
          strokeWidth={1.7}
          aria-hidden="true"
          className={advancedOpen ? "appearance__chevron--open" : ""}
        />
      </button>

      {advancedOpen ? (
        <>
          {/* TODO: these control appearance but are not persisted yet. */}
          <div className="setting-card">
            <SettingRow
              label="UI font size"
              description="Adjust the base size used for YaniMed"
            >
              <span className="appearance__number">
                <input type="number" defaultValue={14} min={12} max={20} aria-label="UI font size" />
                <span className="appearance__unit">px</span>
              </span>
            </SettingRow>

            <SettingRow
              label="Code font size"
              description="Adjust the base size used for code across chats and diffs"
            >
              <span className="appearance__number">
                <input type="number" defaultValue={12} min={10} max={18} aria-label="Code font size" />
                <span className="appearance__unit">px</span>
              </span>
            </SettingRow>
          </div>

          <div className="setting-card">
            <SettingRow label="Reduce motion" description="Reduce animations or match your system">
              <Segmented
                label="Reduce motion"
                value={reduceMotion}
                onChange={setReduceMotion}
                options={[
                  { id: "system", label: "System" },
                  { id: "on", label: "On" },
                  { id: "off", label: "Off" },
                ]}
              />
            </SettingRow>

            <SettingRow label="Separate light and dark modes" description="Choose a theme, colors, and font for each">
              <button
                type="button"
                role="switch"
                aria-checked={separateModes}
                aria-label="Separate light and dark modes"
                onClick={() => setSeparateModes((v) => !v)}
                className={`setting-toggle${separateModes ? " setting-toggle--on" : ""}`}
              >
                <span className="setting-toggle__knob" />
              </button>
            </SettingRow>
          </div>

          <div className="setting-card">
            <SettingRow label="Contrast">
              <span className="appearance__slider">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={contrast}
                  onChange={(e) => setContrast(Number(e.target.value))}
                  aria-label="Contrast"
                />
                <span className="appearance__slider-value">{contrast}</span>
              </span>
            </SettingRow>

            <SettingRow label="Diff markers" description="Show changes using colors or +/- markers">
              <Segmented
                label="Diff markers"
                value={diffMarkers}
                onChange={setDiffMarkers}
                options={[
                  { id: "color", label: "Color" },
                  { id: "signs", label: "+/-" },
                ]}
              />
            </SettingRow>
          </div>
        </>
      ) : null}
    </>
  );
}