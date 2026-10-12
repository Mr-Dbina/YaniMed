import { SettingsNotFoundCard } from "@/components/settings/settings-not-found";

/**
 * Catch-all for unknown /settings paths. Without it Next falls back to the
 * root 404, which drops the settings layout and nav entirely.
 *
 * The card is rendered directly rather than via notFound(): throwing from a
 * catch-all leaves the client nav unmounted during the error render, so the
 * page came up half-blank.
 */
export default function SettingsCatchAll() {
  return <SettingsNotFoundCard />;
}
