import { SettingsNotFoundCard } from "@/components/settings/settings-not-found";

export default function SettingsNotFound() {
  // Rendered inside app/settings/layout.tsx, so the settings nav is preserved.
  return <SettingsNotFoundCard />;
}
