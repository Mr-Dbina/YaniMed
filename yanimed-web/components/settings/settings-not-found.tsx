export function SettingsNotFoundCard() {
  return (
    <>
      <h1 className="settings-page-title">Page not found</h1>
      <div className="setting-card">
        <div className="setting-row">
          <div className="setting-row__text">
            <span className="setting-row__label">That setting page does not exist</span>
            <span className="setting-row__description">Pick one from the list on the left.</span>
          </div>
        </div>
      </div>
    </>
  );
}
