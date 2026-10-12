import { ChevronRight } from "lucide-react";
import { SettingRow, SettingFootnote } from "@/components/settings/setting-row";
import { Toggle } from "@/components/settings/toggle";

export default function PersonalizationSettingsPage() {
  return (
    <>
      <h1 className="settings-page-title">Personalization</h1>

      <h2 className="setting-section-title">YaniMed memory</h2>
      <p className="setting-section-description">
        Configure how YaniMed manages memory.{" "}
        <button type="button" className="setting-link" data-todo="no-destination">
          Learn more
        </button>
      </p>

      <div className="setting-card">
        <SettingRow
          label="Enable memory"
          description="Let YaniMed personalize your experience based on your chat and files."
          link={{ label: "Learn more" }}
        >
          <Toggle label="Enable memory" defaultChecked variant="dark" />
        </SettingRow>

        <SettingRow
          label="Memory summary"
          descriptionMaxWidth
          description="View an overview of what YaniMed has learned about you, the reason memory may be relevant, and what you'd like to showcase in mind. You can still manage your old saved memories."
        >
          {/* TODO: wire this up when the memory summary view exists. */}
          <span className="setting-pill">Manage</span>
        </SettingRow>

        <SettingFootnote>
          YaniMed may use memory to personalize replies, tailor suggestions, and make things more useful.{" "}
          <button type="button" className="setting-link" data-todo="no-destination">
            Learn more
          </button>
        </SettingFootnote>
      </div>

      <h2 className="setting-section-title">Custom instructions</h2>

      <div className="setting-card">
        <SettingRow
          label="YaniMed"
          description="Give YaniMed extra instructions and context for all chats."
          link={{ label: "Learn more" }}
        >
          {/* TODO: wire this up when the custom instructions editor exists. */}
          <ChevronRight size={18} strokeWidth={1.7} className="setting-chevron" aria-hidden="true" />
        </SettingRow>
      </div>

      <h2 className="setting-section-title">Capabilities</h2>

      <div className="setting-card">
        <SettingRow
          label="Reference record history"
          description="Let YaniMed reference all previous recording transcripts and notes when responding."
          link={{ label: "Learn more" }}
        >
          <Toggle label="Reference record history" defaultChecked variant="dark" />
        </SettingRow>

        <SettingRow label="YaniMed Voice" description="Enable Voice in YaniMed">
          <Toggle label="YaniMed Voice" defaultChecked variant="dark" />
        </SettingRow>

        <SettingRow
          label="Library search"
          description="Allow YaniMed to automatically search Library files for answers"
        >
          <Toggle label="Library search" defaultChecked variant="dark" />
        </SettingRow>

        <SettingRow
          label="Connector search"
          description="Let YaniMed automatically search connected sources for answers"
        >
          <Toggle label="Connector search" defaultChecked variant="dark" />
        </SettingRow>
      </div>
    </>
  );
}
