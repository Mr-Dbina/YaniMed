"use client";

import { SidebarToggle } from "@/components/sidebar-toggle";

interface EmptyStateProps {
  onCreateSubject: () => void;
}

export function EmptyState({ onCreateSubject }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state__topbar">
        <SidebarToggle />
      </div>

      <div className="empty-state__content">
        <img
          src="/images/Empty%20folder%20artwork.png"
          alt=""
          width={160}
          height={160}
          className="empty-state__art"
        />

        <h2 className="empty-state__title">No File Yet</h2>
        <p className="empty-state__text">
          You haven&apos;t created any subject yet. Start by creating your first
          subject to see it here.
        </p>

        <button type="button" onClick={onCreateSubject} className="empty-state__button">
          <img src="/images/plus.png" alt="" width={16} height={16} />
          Create Subject
        </button>
      </div>
    </div>
  );
}
