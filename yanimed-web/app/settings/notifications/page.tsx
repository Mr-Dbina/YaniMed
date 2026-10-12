import { SettingRow } from "@/components/settings/setting-row";

function ChannelPill({ value }: { value: string }) {
  // TODO: make this a real multi-select once delivery channels are defined.
  return (
    <span className="setting-pill setting-pill--select">
      {value}
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
  );
}

export default function NotificationsSettingsPage() {
  return (
    <>
      <h1 className="settings-page-title">Notifications</h1>

      <div className="setting-card">
        <SettingRow
          label="Projects"
          description="Get notified when you receive an email invitation to a shared project."
        >
          <ChannelPill value="Email" />
        </SettingRow>

        <SettingRow
          label="Responses"
          description="Get notified when YaniMed responds to requests that take time, like research or image generation."
        >
          <ChannelPill value="Push" />
        </SettingRow>

        <SettingRow
          label="Tasks"
          description="Get notified when tasks you've created have updates."
          linkLine={{ label: "Manage tasks" }}
        >
          <ChannelPill value="Push" />
        </SettingRow>

        <SettingRow
          label="Usage"
          description="We'll notify you when limits reset for features like image creation."
        >
          <ChannelPill value="Push, Email" />
        </SettingRow>
      </div>
    </>
  );
}
