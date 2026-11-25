"use client";

import { useEffect, useRef, useState } from "react";
import { MessageActions } from "@/components/chat/message-actions";
import type { MessageAction } from "@/components/chat/message-actions";
import type { ChatMessage, ChatCitation } from "@/lib/types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BookOpen } from "lucide-react";

interface MessageProps {
  id?: string;
  message: ChatMessage;
  onCopy?: (message: ChatMessage) => void | Promise<void>;
  onEdit?: (message: ChatMessage, content: string) => void;
  onFeedback?: (message: ChatMessage, rating: 1 | -1) => void;
  onReadAloud?: (message: ChatMessage) => void;
  onRegenerate?: (message: ChatMessage) => void;
  actionsDisabled?: boolean;
  onCitationClick?: (citation: ChatCitation, index: number) => void;
  allCitations?: ChatCitation[];
  activeCitationIndex?: number;
}

const COPY_FEEDBACK_MS = 1500;

function CopyIcon() {
  return <img src="/images/Minimal Overlapping Copy Icon.png" alt="" width={14} height={14} className="icon-mono" />;
}

function PencilIcon() {
  return <img src="/images/pencil.png" alt="" width={14} height={14} className="icon-mono" />;
}

function SpeakerIcon() {
  return (
    <img
      src="/images/Minimal Charcoal Speaker Icon.png"
      alt=""
      width={14}
      height={14}
      className="icon-mono"
    />
  );
}

function RefreshIcon() {
  return (
    <img
      src="/images/Dark Charcoal Refresh Icon.png"
      alt=""
      width={14}
      height={14}
      className="icon-mono"
    />
  );
}

function ThumbIcon({ direction }: { direction: "up" | "down" }) {
  const rotation = direction === "down" ? "rotate-180" : "";
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={rotation}
      aria-hidden="true"
    >
      <path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3zM7 10l4.5-7a2 2 0 0 1 3.6 1.6L14.5 9H19a2 2 0 0 1 2 2.4l-1.4 7A2 2 0 0 1 17.6 20H7" />
    </svg>
  );
}

function useCopyFeedback(onCopy?: () => void | Promise<void>) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const trigger = async () => {
    if (!onCopy) return;
    try {
      await onCopy();
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
      setCopied(false);
    }
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => { setCopied(false); setCopyFailed(false); }, COPY_FEEDBACK_MS);
  };

  return { copied, copyFailed, trigger };
}

function CitationMarker({ index, isActive, onClick }: { index: number; isActive: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`citation-marker ${isActive ? "citation-marker--active" : ""}`}
      onClick={onClick}
      aria-label={`Open citation ${index + 1}`}
      aria-pressed={isActive}
    >
      [{index + 1}]
    </button>
  );
}

function SourceChip({ citation, index, isActive, onClick }: { citation: ChatCitation; index: number; isActive: boolean; onClick: () => void }) {
  const label = citation.chapter ? `${citation.chapter} · Page ${citation.page}` : `Page ${citation.page}`;
  return (
    <button
      type="button"
      className={`source-chip ${isActive ? "source-chip--active" : ""}`}
      onClick={onClick}
      aria-label={`Open ${label}`}
      aria-pressed={isActive}
    >
      <BookOpen size={12} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

function deduplicateCitations(citations: ChatCitation[]): ChatCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = `${citation.documentId ?? citation.sourceId}:${citation.page}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeMarkdownTables(content: string): string {
  if (!content.includes('|')) return content;
  
  // First, split collapsed "| |" row boundaries onto separate lines
  let processed = content.replace(/\|\s*\|\s*(?=\S)/g, '|\n|');
  
  // Split mid-paragraph tables: insert blank line before table that starts after prose
  // Matches: text ending with word + space + | at start of table row
  processed = processed.replace(/(\S)\s+\|(?=\s*\S)/g, '$1\n\n|');
  
  const lines = processed.split('\n');
  const result: string[] = [];
  let inTable = false;
  let tableBuffer: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const isTableRow = trimmed.startsWith('|') || 
      (trimmed.includes('|') && (trimmed.match(/\|/g) || []).length >= 2);
    const isSeparatorRow = trimmed.startsWith('|') && /^[\s\|\-\:]+$/.test(trimmed);
    
    if (isTableRow) {
      if (!inTable) {
        inTable = true;
        tableBuffer = [];
        if (result.length > 0 && result[result.length - 1].trim() !== '') {
          result.push('');
        }
      }
      let normalized = line.replace(/\|\|+/g, '|');
      if (!normalized.trim().startsWith('|')) {
        normalized = '| ' + normalized.trim();
      }
      if (!normalized.trim().endsWith('|')) {
        normalized = normalized.trim() + ' |';
      }
      tableBuffer.push(normalized);
    } else {
      if (inTable && tableBuffer.length > 0) {
        if (tableBuffer.length >= 2) {
          const firstRow = tableBuffer[0];
          const secondRow = tableBuffer[1];
          const isHeaderSeparator = secondRow.trim().startsWith('|') && /^[\s\|\-\:]+$/.test(secondRow.trim());
          if (!isHeaderSeparator) {
            const colCount = (firstRow.match(/\|/g) || []).length;
            const separator = '|' + ' --- |'.repeat(colCount - 1);
            tableBuffer.splice(1, 0, separator);
          }
        }
        result.push(...tableBuffer);
        tableBuffer = [];
        inTable = false;
      }
      result.push(line);
    }
  }
  
  if (inTable && tableBuffer.length > 0) {
    if (tableBuffer.length >= 2) {
      const firstRow = tableBuffer[0];
      const secondRow = tableBuffer[1];
      const isHeaderSeparator = secondRow.trim().startsWith('|') && /^[\s\|\-\:]+$/.test(secondRow.trim());
      if (!isHeaderSeparator) {
        const colCount = (firstRow.match(/\|/g) || []).length;
        const separator = '|' + ' --- |'.repeat(colCount - 1);
        tableBuffer.splice(1, 0, separator);
      }
    }
    result.push(...tableBuffer);
  }
  
  return result.join('\n');
}

function stripUnmappedSourceMarkers(content: string, citations: ChatCitation[]): string {
  if (!content.includes('[')) return content;
  
  const validIndices = new Set(citations.map((_, i) => i + 1));
  const validSourceIds = new Set(citations.filter(c => c.sourceId).map(c => c.sourceId));
  
  return content.replace(/\[S(\d+)\]/g, (match, numStr) => {
    const num = parseInt(numStr, 10);
    if (validIndices.has(num)) {
      return `[${num}]`;
    }
    if (validSourceIds.has(`S${numStr}`)) {
      return match;
    }
    return '';
  });
}

// Apply stripUnmappedSourceMarkers to table cell content as well
function stripUnmappedSourceMarkersInTable(content: string, citations: ChatCitation[]): string {
  const validIndices = new Set(citations.map((_, i) => i + 1));
  const validSourceIds = new Set(citations.filter(c => c.sourceId).map(c => c.sourceId));
  
  return content.replace(/\[S(\d+)\]/g, (match, numStr) => {
    const num = parseInt(numStr, 10);
    if (validIndices.has(num)) {
      return `[${num}]`;
    }
    if (validSourceIds.has(`S${numStr}`)) {
      return match;
    }
    return '';
  });
}

function parseContentWithCitations(content: string, citations: ChatCitation[], onCitationClick: (citation: ChatCitation, index: number) => void): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  const citationRegex = /\[(?:S)?(\d+)\]/g;
  let match;

  while ((match = citationRegex.exec(content)) !== null) {
    const beforeText = content.slice(lastIndex, match.index);
    if (beforeText) {
      nodes.push(beforeText);
    }
    const citationIndex = parseInt(match[1], 10) - 1;
    if (citationIndex >= 0 && citationIndex < citations.length) {
      nodes.push(
        <CitationMarker
          key={`citation-${citationIndex}-${match.index}`}
          index={citationIndex}
          isActive={false}
          onClick={() => onCitationClick(citations[citationIndex], citationIndex)}
        />
      );
    } else {
      nodes.push(match[0]);
    }
    lastIndex = match.index + match[0].length;
  }

  const remainingText = content.slice(lastIndex);
  if (remainingText) {
    nodes.push(remainingText);
  }

  return nodes.length > 0 ? nodes : [content];
}

function CitationMarkers({ content, citations, onCitationClick }: { content: string; citations: ChatCitation[]; onCitationClick: (citation: ChatCitation, index: number) => void }) {
  const nodes = parseContentWithCitations(content, citations, onCitationClick);
  return <span>{nodes}</span>;
}

export function Message({
  id,
  message,
  onCopy,
  onEdit,
  onFeedback,
  onReadAloud,
  onRegenerate,
  actionsDisabled = false,
  onCitationClick,
  allCitations = [],
  activeCitationIndex = 0,
}: MessageProps) {
  const isUser = message.role === "user";
  const { copied, copyFailed, trigger: triggerCopy } = useCopyFeedback(
    onCopy ? () => onCopy(message) : undefined,
  );

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const editInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditing) editInputRef.current?.focus();
  }, [isEditing]);

  const canSave = draft.trim().length > 0 && draft !== message.content;

  const copyAction: MessageAction = {
    id: "copy",
    label: "Copy",
    icon: <CopyIcon />,
    onClick: triggerCopy,
    active: copied || copyFailed,
    activeLabel: copyFailed ? "Copy unavailable" : "Copied",
  };

  const userActions: MessageAction[] = onCopy ? [copyAction] : [];
  if (onEdit) {
    userActions.push({
      id: "edit",
      label: "Edit message",
      icon: <PencilIcon />,
      onClick: () => {
        setDraft(message.content);
        setIsEditing(true);
      },
    });
  }

  const assistantActions: MessageAction[] = onCopy ? [copyAction] : [];
  assistantActions.push({
    id: "read-aloud", label: onReadAloud ? "Read aloud" : "Read aloud unavailable: voice is not connected",
    icon: <SpeakerIcon />, disabled: !onReadAloud || actionsDisabled,
    onClick: () => onReadAloud?.(message),
  });
  if (onFeedback) {
    assistantActions.push({
      id: "good",
      label: "Like response (saved for this session)",
      icon: <ThumbIcon direction="up" />,
      active: message.rating === 1,
      onClick: () => onFeedback(message, 1),
    });
    assistantActions.push({
      id: "bad", label: "Dislike response (saved for this session)",
      icon: <ThumbIcon direction="down" />, active: message.rating === -1,
      onClick: () => onFeedback(message, -1),
    });
  }
  if (onRegenerate) {
    assistantActions.push({
      id: "regenerate",
      label: "Retry response",
      disabled: actionsDisabled,
      icon: <RefreshIcon />,
      onClick: () => onRegenerate(message),
    });
  }

  const actions = isUser ? userActions : assistantActions;
  const visibility = isUser ? "hover" : "always";
  const align = isUser ? "end" : "start";

  const commitEdit = () => {
    if (!canSave) return;
    onEdit?.(message, draft.trim());
    setIsEditing(false);
  };

  const editControls = (
    <div className="flex items-center justify-end gap-3 pt-1.5">
      <button
        type="button"
        className="text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
        onClick={() => {
          setDraft(message.content);
          setIsEditing(false);
        }}
      >
        Cancel
      </button>
      <button
        type="button"
        disabled={!canSave}
        className="rounded-md bg-foreground px-2.5 py-1 text-sm font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-not-allowed disabled:opacity-40"
        onClick={commitEdit}
      >
        Save
      </button>
    </div>
  );

  const handleCitationClick = (citation: ChatCitation, index: number) => {
    onCitationClick?.(citation, index);
  };

  const citations = message.citations ?? [];
  const showCitations = citations.length > 0 && !isUser;

  return (
    <div id={id} className={`subject-chat__message group/message flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      {isUser ? (
        isEditing ? (
          <div className="flex w-full max-w-md flex-col items-end gap-1">
            <textarea
              ref={editInputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setDraft(message.content);
                  setIsEditing(false);
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  commitEdit();
                }
              }}
              aria-label="Edit message"
              className="w-full resize-none rounded-lg border border-border bg-card px-3 py-2 font-[inherit] text-foreground outline-none focus-visible:border-foreground/40"
              rows={2}
            />
            {editControls}
          </div>
        ) : (
          <>
            <p className="subject-chat__user-text">
              {message.content}
            </p>
            {actions.length > 0 && (
              <MessageActions actions={actions} visibility={visibility} align={align} />
            )}
          </>
        )
      ) : (
        <>
          <div className="subject-chat__answer">
            <div className="chat-markdown">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                components={{
                  table: ({ children }) => (
                    <div className="chat-markdown__scroll" tabIndex={0} role="region" aria-label="Scrollable table">
                      <table>{children}</table>
                    </div>
                  ),
                  td: ({ children }) => (
                    <td>{stripUnmappedSourceMarkersInTable(String(children), citations)}</td>
                  ),
                  th: ({ children }) => (
                    <th>{stripUnmappedSourceMarkersInTable(String(children), citations)}</th>
                  ),
                  pre: ({ children }) => (
                    <pre className="chat-markdown__scroll" tabIndex={0} aria-label="Scrollable code block">
                      {children}
                    </pre>
                  ),
                  img: ({ alt }) => <span>{alt}</span>,
                  p: ({ children }) => (
                    <p style={{ lineHeight: 1.7, fontSize: "15.5px", marginBlock: 12 }}>
                      {children}
                    </p>
                  ),
                }}
              >
                {normalizeMarkdownTables(stripUnmappedSourceMarkers(message.content, citations))}
              </ReactMarkdown>
              <CitationMarkers content={stripUnmappedSourceMarkers(message.content, citations)} citations={citations} onCitationClick={handleCitationClick} />
            </div>
            {showCitations && (
              <div className="subject-chat__sources" role="list" aria-label="Sources">
                {deduplicateCitations(citations).map((citation, index) => {
                  const originalIndex = citations.findIndex(c => c.sourceId === citation.sourceId && c.page === citation.page);
                  return (
                    <SourceChip
                      key={`${citation.sourceId}-${citation.page}`}
                      citation={citation}
                      index={originalIndex}
                      isActive={originalIndex === activeCitationIndex}
                      onClick={() => handleCitationClick(citation, originalIndex)}
                    />
                  );
                })}
              </div>
            )}
            {actions.length > 0 && (
              <MessageActions actions={actions} visibility={visibility} align={align} />
            )}
          </div>
        </>
      )}
    </div>
  );
}