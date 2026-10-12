import type { ReactNode } from "react";

interface SettingLink {
  label: string;
  /** TODO: real destinations do not exist yet - these render as inert buttons. */
  href?: string;
}

interface SettingRowProps {
  label: string;
  description?: string;
  /** Flows inline at the end of the description sentence, e.g. "Learn more". */
  link?: SettingLink;
  /** Rendered on its own line beneath the description, e.g. "Manage tasks". */
  linkLine?: SettingLink;
  /** Caps the description width so the control never gets squeezed. */
  descriptionMaxWidth?: boolean;
  children?: ReactNode;
}

/** One row inside a settings card. Rows stack; a rule separates each pair. */
export function SettingRow({
  label,
  description,
  link,
  linkLine,
  descriptionMaxWidth,
  children,
}: SettingRowProps) {
  return (
    <div className="setting-row">
      <div
        className={`setting-row__text${descriptionMaxWidth ? " setting-row__text--narrow" : ""}`}
      >
        <span className="setting-row__label">{label}</span>

        {description ? (
          <span className="setting-row__description">
            {description}
            {link ? (
              <>
                {" "}
                <button type="button" className="setting-link" data-todo="no-destination">
                  {link.label}
                </button>
              </>
            ) : null}
          </span>
        ) : null}

        {linkLine ? (
          <span className="setting-row__description">
            <button
              type="button"
              className="setting-link"
              data-todo="no-destination"
            >
              {linkLine.label}
            </button>
          </span>
        ) : null}
      </div>

      {children ? <div className="setting-row__control">{children}</div> : null}
    </div>
  );
}

/** Trailing note inside a card, on its own section beneath a rule. */
export function SettingFootnote({ children }: { children: ReactNode }) {
  return <p className="setting-card__footnote">{children}</p>;
}
