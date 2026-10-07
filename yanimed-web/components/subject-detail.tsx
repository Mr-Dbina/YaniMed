"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { PdfDropzone } from "@/components/pdf-dropzone";
import { SetInstructionsModal } from "@/components/set-instructions-modal";
import { DeleteSubjectModal } from "@/components/delete-subject-modal";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { useSidebarStore } from "@/lib/stores/sidebar-store";
import type { Subject } from "@/lib/types";

interface SubjectDetailProps {
  subject: Subject;
  onUpdateSubject: (id: string, patch: Partial<Omit<Subject, "id">>) => void;
  onDeleteSubject: (id: string) => void;
  onBack: () => void;
}

export function SubjectDetail({
  subject,
  onUpdateSubject,
  onDeleteSubject,
  onBack,
}: SubjectDetailProps) {
  const isCollapsed = useSidebarStore((state) => state.isCollapsed);
  const [isInstructionsOpen, setIsInstructionsOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(subject.name);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) renameInputRef.current?.focus();
  }, [isRenaming]);

  const startRename = () => {
    setRenameValue(subject.name);
    setIsRenaming(true);
    setIsMenuOpen(false);
  };

  const commitRename = () => {
    const next = renameValue.trim();
    if (next && next !== subject.name) {
      onUpdateSubject(subject.id, { name: next });
    }
    setIsRenaming(false);
  };

  const handleDelete = () => {
    setIsMenuOpen(false);
    setIsDeleteOpen(true);
  };

  const confirmDelete = () => {
    setIsDeleteOpen(false);
    onDeleteSubject(subject.id);
  };

  const handleSaveInstructions = (text: string) => {
    onUpdateSubject(subject.id, { instructions: text });
    setIsInstructionsOpen(false);
  };

  const isChat = Boolean(subject.file);

  const crumbRow = (
    <div className="subject-detail__crumb-row">
      <SidebarToggle />
      <nav className="subject-detail__breadcrumb">
        <button type="button" className="subject-detail__crumb-link" onClick={onBack}>
          Subjects
        </button>
        <span className="subject-detail__crumb-sep">/</span>
        <span className="subject-detail__crumb-current">{subject.name}</span>
      </nav>
    </div>
  );

  const menu = (
    <div className="subject-detail__menu-wrap">
      <button
        type="button"
        className="subject-detail__menu"
        aria-label="Subject options"
        aria-haspopup="menu"
        aria-expanded={isMenuOpen}
        onClick={() => setIsMenuOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
          <circle cx="12" cy="5" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="12" cy="19" r="1.8" />
        </svg>
      </button>

      {isMenuOpen && (
        <>
          <button
            type="button"
            className="subject-detail__menu-backdrop"
            aria-label="Close menu"
            tabIndex={-1}
            onClick={() => setIsMenuOpen(false)}
          />
          <div className="subject-detail__menu-dropdown" role="menu">
            <button
              type="button"
              role="menuitem"
              className="subject-detail__menu-item"
              onClick={startRename}
            >
              <img src="/images/pencil.png" alt="" width={18} height={18} className="icon-mono" />
              <span className="subject-detail__menu-label">Rename</span>
              <span className="subject-detail__menu-shortcut">R</span>
            </button>
            <div className="subject-detail__menu-divider" />
            <button
              type="button"
              role="menuitem"
              className="subject-detail__menu-item"
              onClick={handleDelete}
            >
              <img src="/images/delete.png" alt="" width={18} height={18} />
              <span className="subject-detail__menu-label">Delete</span>
              <span className="subject-detail__menu-shortcut">D</span>
            </button>
          </div>
        </>
      )}
    </div>
  );

  const className = [
    "subject-detail",
    isChat ? "subject-detail--chat" : "",
    !isChat && isCollapsed ? "subject-detail--centered" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className}>
      {isChat ? (
        <>
          <div className="subject-detail__topbar">
            {crumbRow}
            {menu}
          </div>

          <div className="subject-chat">
            <div className="subject-chat__hero">
              <img src="/images/yanimed_logo.png" alt="" width={64} height={64} />
              <h1 className="subject-chat__title">How can I help?</h1>
            </div>

            <div className="subject-chat__prompt">
              <button type="button" aria-label="Add attachment" className="subject-chat__icon-btn">
                <img src="/images/add.png" alt="" width={24} height={24} className="icon-mono" />
              </button>
              <input
                type="text"
                className="subject-chat__input"
                placeholder="What do you want to learn today?"
              />
              <button type="button" aria-label="Voice input" className="subject-chat__icon-btn">
                <img src="/images/mic.png" alt="" width={24} height={24} className="icon-mono" />
              </button>
              <button type="button" aria-label="Audio reply" className="subject-chat__icon-btn">
                <img src="/images/music.png" alt="" width={24} height={24} className="icon-mono" />
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          {crumbRow}

          <div className="subject-detail__header">
            {isRenaming ? (
              <input
                ref={renameInputRef}
                type="text"
                className="subject-detail__title subject-detail__title-input"
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                  if (event.key === "Enter") commitRename();
                  if (event.key === "Escape") setIsRenaming(false);
                }}
              />
            ) : (
              <h1 className="subject-detail__title">{subject.name}</h1>
            )}

            {menu}
          </div>

          <div className="subject-detail__card">
            <div className="subject-detail__section-header">
              <h2 className="subject-detail__section-title">Instructions</h2>
              <button
                type="button"
                className="subject-detail__add"
                aria-label="Set subject instructions"
                onClick={() => setIsInstructionsOpen(true)}
              >
                <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </div>

            {subject.instructions ? (
              <p className="subject-detail__instruction-text">{subject.instructions}</p>
            ) : (
              <p className="subject-detail__instruction-empty">
                Add instructions to tailor YaniMed&rsquo;s responses
              </p>
            )}

            <h2 className="subject-detail__section-title">Context</h2>
            <PdfDropzone
              file={subject.file}
              onFileSelect={(file) => onUpdateSubject(subject.id, { file })}
            />
          </div>
        </>
      )}

      <SetInstructionsModal
        open={isInstructionsOpen}
        onOpenChange={setIsInstructionsOpen}
        subjectName={subject.name}
        value={subject.instructions}
        onSave={handleSaveInstructions}
      />

      <DeleteSubjectModal
        open={isDeleteOpen}
        onOpenChange={setIsDeleteOpen}
        subjectName={subject.name}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
