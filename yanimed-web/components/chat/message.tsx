"use client";

import { useEffect, useRef, useState } from "react";
import { MessageActions } from "@/components/chat/message-actions";
import type { MessageAction } from "@/components/chat/message-actions";
import type { MessageRole } from "@/lib/types";

export interface ChatCitation {
  chapter: string | null;
  page: number;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  citations?: ChatCitation[];
  rating?: 1 | -1 | null;
  isStreaming?: boolean;
}

interface MessageProps {
  message: ChatMessage;
  onCopy?: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage, content: string) => void;
  onFeedback?: (message: ChatMessage, rating: 1 | -1) => void;
  onReadAloud?: (message: ChatMessage) => void;
  onRegenerate?: (message: ChatMessage) => void;
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

function useCopyFeedback(onCopy?: () => void) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const trigger = () => {
    if (!onCopy) return;
    onCopy();
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  };

  return { copied, trigger };
}

export function Message({
  message,
  onCopy,
  onEdit,
  onFeedback,
  onReadAloud,
  onRegenerate,
}: MessageProps) {
  const isUser = message.role === "user";
  const { copied, trigger: triggerCopy } = useCopyFeedback(
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
    active: copied,
    activeLabel: "Copied",
  };

  const userActions: MessageAction[] = [
    copyAction,
    {
      id: "edit",
      label: "Edit message",
      icon: <PencilIcon />,
      onClick: () => {
        setDraft(message.content);
        setIsEditing(true);
      },
    },
  ];

  const assistantActions: MessageAction[] = [
    copyAction,
    {
      id: "good",
      label: "Good response",
      icon: <ThumbIcon direction="up" />,
      active: message.rating === 1,
      onClick: () => onFeedback?.(message, 1),
    },
    { id: "read-aloud", label: "Read aloud", icon: <SpeakerIcon />, onClick: () => onReadAloud?.(message) },
    {
      id: "regenerate",
      label: "Change response",
      icon: <RefreshIcon />,
      onClick: () => onRegenerate?.(message),
    },
  ];

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

  return (
    <div className={`group/message flex flex-col ${isUser ? "items-end" : "items-start"}`}>
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
            <p className="max-w-md rounded-lg border border-border bg-card px-3.5 py-2 text-foreground">
              {message.content}
            </p>
            <MessageActions actions={actions} visibility={visibility} align={align} />
          </>
        )
      ) : (
        <>
          <div className="max-w-2xl">
            <p className="whitespace-pre-wrap text-foreground">{message.content}</p>
            {message.citations?.map((citation) => (
              <p key={`${citation.page}-${citation.chapter ?? ""}`} className="mt-2 font-bold text-foreground">
                {citation.chapter ? `${citation.chapter}, ` : ""}p.{citation.page}
              </p>
            ))}
          </div>
          <MessageActions actions={actions} visibility={visibility} align={align} />
        </>
      )}
    </div>
  );
}