import { SettingRow } from "@/components/settings/setting-row";
import { Toggle } from "@/components/settings/toggle";

export default function VoiceSettingsPage() {
  return (
    <>
      <h1 className="settings-page-title">Voice</h1>

      <div className="setting-card">
        <SettingRow
          label="Voice"
          description="Choose the voice used for voice chat and read aloud"
        >
          {/* TODO: make this a picker once the voice list is defined. */}
          <span className="setting-pill">Breeze</span>
        </SettingRow>

        <SettingRow label="Language">
          {/* TODO: make this a picker once the language list is defined. */}
          <span className="setting-pill setting-pill--select">
            Auto-detect
            <svg
              viewBox="0 0 24 24"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </span>
        </SettingRow>
      </div>

      <h2 className="setting-section-title">Dictation</h2>

      <div className="setting-card">
        <SettingRow label="Enable Dictation" description="Use dictation in the chat composer.">
          <Toggle label="Enable Dictation" defaultChecked />
        </SettingRow>
      </div>

      <div className="setting-card">
        <SettingRow
          label="Recent recordings"
          description="Your last 20 recordings are saved on this device"
        />
      </div>
    </>
  );
}
