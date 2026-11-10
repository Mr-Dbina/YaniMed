"use client";

import { useEffect, useRef, useState } from "react";
import { MessageActions } from "@/components/chat/message-actions";
import type { MessageAction } from "@/components/chat/message-actions";
import type { ChatMessage } from "@/lib/types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MessageProps {
  message: ChatMessage;
  onCopy?: (message: ChatMessage) => void | Promise<void>;
  onEdit?: (message: ChatMessage, content: string) => void;
  onFeedback?: (message: ChatMessage, rating: 1 | -1) => void;
  onReadAloud?: (message: ChatMessage) => void;
  onRegenerate?: (message: ChatMessage) => void;
  actionsDisabled?: boolean;
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

export function Message({
  message,
  onCopy,
  onEdit,
  onFeedback,
  onReadAloud,
  onRegenerate,
  actionsDisabled = false,
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

  return (
    <div className={`subject-chat__message group/message flex flex-col ${isUser ? "items-end" : "items-start"}`}>
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
            <p className="subject-chat__user-text max-w-md rounded-lg border border-border bg-card px-3.5 py-2 text-foreground">
              {message.content}
            </p>
            {actions.length > 0 && (
              <MessageActions actions={actions} visibility={visibility} align={align} />
            )}
          </>
        )
      ) : (
        <>
          <div className="subject-chat__answer max-w-2xl">
            <div className="chat-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
                table: ({ children }) => <div className="chat-markdown__scroll" tabIndex={0} role="region" aria-label="Scrollable table"><table>{children}</table></div>,
                pre: ({ children }) => <pre className="chat-markdown__scroll" tabIndex={0} aria-label="Scrollable code block">{children}</pre>,
                img: ({ alt }) => <span>{alt}</span>,
              }}>{message.content}</ReactMarkdown>
            </div>
            {message.citations?.map((citation) => (
              <div key={JSON.stringify([citation.sourceId, citation.page, citation.chapter, citation.snippet])} className="mt-2 text-foreground">
                <p className="font-bold">
                  {citation.sourceId}: {citation.chapter ? `${citation.chapter}, ` : ""}Page {citation.page}
                </p>
                {citation.snippet && <blockquote className="mt-1 text-sm text-muted-foreground">{citation.snippet}</blockquote>}
              </div>
            ))}
          </div>
          {actions.length > 0 && (
            <MessageActions actions={actions} visibility={visibility} align={align} />
          )}
        </>
      )}
    </div>
  );
}
