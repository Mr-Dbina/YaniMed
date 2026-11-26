"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { PdfDropzone } from "@/components/pdf-dropzone";
import { AddPdfModal } from "@/components/add-pdf-modal";
import { DeleteSubjectModal } from "@/components/delete-subject-modal";
import { ChatConversation } from "@/components/chat/chat-conversation";
import { SubjectDocuments } from "@/components/subject-documents";
import type { SubjectDocumentsSummary } from "@/components/subject-documents";
import { useSidebarStore } from "@/lib/stores/sidebar-store";
import type { Subject } from "@/lib/types";
import { processingPresentation } from "@/lib/processing-state";
import { useSubjectsStore } from "@/lib/stores/subjects-store";

/** A subject uses the chat layout once it exists on the backend or has a local PDF. */
export function isChatSubject(subject: Subject): boolean {
  return Boolean(subject.backendSubjectId) || Boolean(subject.file);
}

interface SubjectDetailProps {
  subject: Subject;
  onUpdateSubject: (id: string, patch: Partial<Omit<Subject, "id">>) => void;
  onDeleteSubject: (id: string) => Promise<void>;
  onBack: () => void;
}

export function SubjectDetail({
  subject,
  onUpdateSubject,
  onDeleteSubject,
  onBack,
}: SubjectDetailProps) {
  const isCollapsed = useSidebarStore((state) => state.isCollapsed);
  const syncSubject = useSubjectsStore((state) => state.syncSubject);
  const renameSubject = useSubjectsStore((state) => state.renameSubject);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isAddPdfOpen, setIsAddPdfOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(subject.name);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [documentsRefreshToken, setDocumentsRefreshToken] = useState(0);
  const [documentsSummary, setDocumentsSummary] = useState<{
    subjectId: string;
    summary: SubjectDocumentsSummary;
  } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) renameInputRef.current?.focus();
  }, [isRenaming]);

  useEffect(() => {
    if (pdfOpen) {
      setIsMenuOpen(false);
    }
  }, [pdfOpen]);

  const startRename = () => {
    setRenameValue(subject.name);
    setIsRenaming(true);
    setIsMenuOpen(false);
    setRenameError(null);
  };

  const commitRename = async () => {
    const next = renameValue.trim();
    if (!next || next === subject.name) {
      setIsRenaming(false);
      setRenameError(null);
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      await renameSubject(subject.id, next);
      setIsRenaming(false);
    } catch (error) {
      setRenameError(
        error instanceof Error && error.message
          ? error.message
          : "Could not rename subject."
      );
    } finally {
      setRenameBusy(false);
    }
  };

  const handleDelete = () => {
    setIsMenuOpen(false);
    setDeleteError(null);
    setIsDeleteOpen(true);
  };

  const handleAddPdf = () => {
    setIsMenuOpen(false);
    setIsAddPdfOpen(true);
  };

  const confirmDelete = async () => {
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await onDeleteSubject(subject.id);
      setIsDeleteOpen(false);
    } catch (error) {
      setDeleteError(error instanceof Error && error.message
        ? error.message
        : "Could not delete this subject. Please try again.");
    } finally {
      setIsDeleting(false);
    }
  };

  const isUploadLocked = Boolean(subject.idempotencyKey);
  const backendSubjectId = subject.backendSubjectId;
  const processing = processingPresentation(subject);
  const handleDocumentsSummary = useCallback((summary: SubjectDocumentsSummary) => {
    setDocumentsSummary({ subjectId: backendSubjectId ?? "", summary });
  }, [backendSubjectId]);
  const summary = backendSubjectId && documentsSummary?.subjectId === backendSubjectId
    ? documentsSummary.summary
    : null;
  const hasReadyDocument = Boolean(summary?.hasReady);
  const showDropzone = Boolean(backendSubjectId) && summary !== null && !summary.loading &&
    !summary.error && summary.documentCount === 0;
  const isChat = isChatSubject(subject);
  // Status text lives in SubjectDocuments (compact) or the local processing line; the composer just stays disabled.
  const backendChatDisabledReason = hasReadyDocument
    ? undefined
    : summary && summary.documentCount === 0
      ? "Upload a PDF to start chatting."
      : "Chat available once the PDF is processed.";

  const breadcrumb = (
    <nav className="subject-detail__breadcrumb">
      <button type="button" className="subject-detail__crumb-link" onClick={onBack}>
        Subject
      </button>
      <span className="subject-detail__crumb-sep">/</span>
      <span className="subject-detail__crumb-current">{subject.name}</span>
    </nav>
  );

  const menu = !pdfOpen ? (
    <div className="subject-detail__menu-wrap">
      <button
        type="button"
        className="subject-detail__menu"
        aria-label="Subject options"
        aria-haspopup="menu"
        aria-expanded={isMenuOpen}
        onClick={() => setIsMenuOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" width="22" height={22} fill="currentColor">
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
            {backendSubjectId && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="subject-detail__menu-item"
                  onClick={handleAddPdf}
                >
                  <span className="subject-detail__menu-label">Add PDF</span>
                </button>
                <div className="subject-detail__menu-divider" />
              </>
            )}
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
  ) : null;

  const headerRow = isChat ? (
    <div className="subject-detail__header-row">
      {breadcrumb}
      {menu}
    </div>
  ) : null;

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
          {headerRow}

          {showDropzone && (
            <div className="subject-detail__card">
              <h2 className="subject-detail__section-title">Context</h2>
              <PdfDropzone
                file={subject.file}
                disabled={isUploadLocked}
                onFileSelect={(file) => onUpdateSubject(subject.id, { file, processingStatus: "unavailable", processingError: undefined })}
              />
              {isUploadLocked && <p>The PDF cannot be changed after upload starts.</p>}
            </div>
          )}

          {backendSubjectId ? (
            <SubjectDocuments
              key={`documents-${backendSubjectId}`}
              subjectId={backendSubjectId}
              refreshToken={documentsRefreshToken}
              onSummary={handleDocumentsSummary}
            />
          ) : (
            (Boolean(subject.idempotencyKey) ||
              subject.processingStatus === "processing" ||
              subject.processingStatus === "failed") && (
              <p className="subject-docstatus" role="status">
                <span>{processing.title}</span>
                {processing.retrySync && subject.idempotencyKey && (
                  <button type="button" onClick={() => void syncSubject(subject.id)}>
                    Retry sync
                  </button>
                )}
              </p>
            )
          )}

          <ChatConversation
            key={`chat-${subject.id}`}
            subjectId={backendSubjectId}
            disabledReason={backendSubjectId
              ? backendChatDisabledReason
              : "Chat unavailable until this PDF is processed and its index is verified."}
            onAsked={(prompt) => onUpdateSubject(subject.id, { lastMessage: prompt })}
            pdfOpen={pdfOpen}
            onPdfOpenChange={setPdfOpen}
            leftHeader={null}
          />
        </>
      ) : (
        <>
          {breadcrumb}

          <div className="subject-detail__header">
            {isRenaming ? (
              <div>
                <input
                  ref={renameInputRef}
                  disabled={renameBusy}
                  type="text"
                  className="subject-detail__title subject-detail__title-input"
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onBlur={() => {
                    if (!renameBusy) void commitRename();
                  }}
                  onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                    if (event.key === "Enter" && !renameBusy) void commitRename();
                    if (event.key === "Escape" && !renameBusy) {
                      setIsRenaming(false);
                      setRenameError(null);
                    }
                  }}
                />
                {renameError && (
                  <p role="alert" className="subject-modal__error" style={{ fontSize: "13px", marginTop: "6px" }}>
                    {renameError}
                  </p>
                )}
              </div>
            ) : (
              <h1 className="subject-detail__title">{subject.name}</h1>
            )}

            {menu}
          </div>

          <div className="subject-detail__card">
            <h2 className="subject-detail__section-title">Context</h2>
            <PdfDropzone
              file={subject.file}
              disabled={isUploadLocked}
              onFileSelect={(file) => onUpdateSubject(subject.id, { file, processingStatus: "unavailable", processingError: undefined })}
            />
            {isUploadLocked && <p>The PDF cannot be changed after upload starts.</p>}
          </div>

          {backendSubjectId && (
            <SubjectDocuments
              key={`documents-${backendSubjectId}`}
              subjectId={backendSubjectId}
              refreshToken={documentsRefreshToken}
              onSummary={handleDocumentsSummary}
            />
          )}
        </>
      )}

      {isAddPdfOpen && backendSubjectId && (
        <AddPdfModal
          subjectId={backendSubjectId}
          subjectName={subject.name}
          onClose={() => setIsAddPdfOpen(false)}
          onUploaded={() => setDocumentsRefreshToken((token) => token + 1)}
        />
      )}

      <DeleteSubjectModal
        open={isDeleteOpen}
        onOpenChange={(open) => {
          if (!isDeleting) {
            setIsDeleteOpen(open);
            if (!open) setDeleteError(null);
          }
        }}
        subjectName={subject.name}
        onConfirm={() => void confirmDelete()}
        busy={isDeleting}
        error={deleteError}
      />
    </div>
  );
}
