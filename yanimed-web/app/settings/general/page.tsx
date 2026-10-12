"use client";

import { useState } from "react";
import { SettingRow } from "@/components/settings/setting-row";
import { LanguageSelect } from "@/components/language-select";

export default function GeneralSettingsPage() {
  // TODO: persist once the app has settings storage.
  const [language, setLanguage] = useState("Auto detect");

  return (
    <>
      <h1 className="settings-page-title">General</h1>

      <div className="setting-card">
        <SettingRow label="Language" description="Language for the app UI">
          <LanguageSelect value={language} onChange={setLanguage} />
        </SettingRow>
      </div>
    </>
  );
}
