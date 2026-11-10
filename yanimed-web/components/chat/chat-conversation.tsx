"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { AudioWaveform, Mic, Plus } from "lucide-react";
import { Message } from "@/components/chat/message";
import type { ChatMessage } from "@/lib/types";
import { ApiError, MAX_PROMPT_LENGTH, requestAnswer } from "@/lib/api";
import { requestSubjectAnswer } from "@/lib/backend-api";

interface ChatConversationProps {
  onAsked?: (prompt: string) => void;
  disabledReason?: string;
  emptyState?: ReactNode;
  subjectId?: string;
}

function subjectChatError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return "Too many questions. Wait one minute.";
    if (err.status === 503) return "AI is unavailable. Try again shortly.";
    if (err.status === 404) return "Subject or chat not found.";
    if (err.status === 403) return "Request blocked by the API. Check the allowed frontend origin.";
  }
  return "Something went wrong.";
}

function createMessageId(): string {
  return crypto.randomUUID();
}

export function ChatConversation({ onAsked, disabledReason, emptyState, subjectId }: ChatConversationProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const chatIdRef = useRef<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedMessage, setFailedMessage] = useState<{ id: string; prompt: string; assistantId?: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [showLatest, setShowLatest] = useState(false);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && followLatest.current) viewport.scrollTop = viewport.scrollHeight;
  }, [messages, isPending, error]);

  const canSend = draft.trim().length > 0 && !isPending && !disabledReason;

  const send = async (rawPrompt: string, regenerate?: { id: string; prompt: string; assistantId: string }) => {
    const prompt = rawPrompt.trim();
    if (!prompt || isPending || abortRef.current || disabledReason) return;

    if (prompt.length > MAX_PROMPT_LENGTH) {
      setError(`Question is too long. Keep it under ${MAX_PROMPT_LENGTH} characters.`);
      return;
    }

    const retryMessage = regenerate ?? (failedMessage?.prompt === prompt ? failedMessage : null);
    const userMessageId = retryMessage?.id ?? createMessageId();
    if (!retryMessage) setMessages((current) => [
      ...current,
      { id: userMessageId, role: "user", content: prompt },
    ]);
    setDraft("");
    setError(null);
    setFailedMessage(null);
    setIsPending(true);
    followLatest.current = true;
    setShowLatest(false);
    onAsked?.(prompt);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const subjectResult = subjectId
        ? await requestSubjectAnswer(
            { subjectId, prompt, chatId: chatIdRef.current },
            controller.signal,
          )
        : null;
      if (subjectResult) chatIdRef.current = subjectResult.chatId;
      const result = subjectResult ?? (await requestAnswer(prompt, controller.signal));
      const assistant: ChatMessage = {
          id: createMessageId(), role: "assistant", content: result.answer,
          citations: result.citations, grounding: result.grounding, metadata: result.metadata,
          replyToId: userMessageId,
      };
      setMessages(current => retryMessage?.assistantId
        ? current.map(message => message.id === retryMessage.assistantId ? assistant : message)
        : [...current, assistant]);
    } catch (err) {
      if (controller.signal.aborted) return;
      setFailedMessage({ id: userMessageId, prompt, assistantId: retryMessage?.assistantId });
      setError(
        subjectId
          ? subjectChatError(err)
          : err instanceof ApiError ? err.message : "Something went wrong while asking.",
      );
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setIsPending(false);
      }
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSend) return;
    void send(draft);
  };

  const copyMessage = async (message: ChatMessage) => {
    if (!navigator.clipboard) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(message.content);
  };

  const regenerateMessage = (message: ChatMessage) => {
    const question = messages.find(item => item.id === message.replyToId && item.role === "user");
    if (question) void send(question.content, { id: question.id, prompt: question.content, assistantId: message.id });
  };

  const hasThread = messages.length > 0;

  return (
    <div className={`subject-chat${hasThread ? " subject-chat--thread" : ""}`}>
      {(!subjectId || disabledReason) && (
        <p className="subject-chat__notice text-sm text-muted-foreground" role="note">
          {disabledReason ? "PDF not indexed · chat unavailable" : "Development preview · ungrounded · not for studying"}
        </p>
      )}
      <div className="subject-chat__viewport" ref={viewportRef} onScroll={(event) => {
        const element = event.currentTarget;
        followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        setShowLatest(!followLatest.current);
      }}>
      {!hasThread && (emptyState ?? (
        <div className="subject-chat__hero">
          <img src="/images/yanimed_logo.png" alt="" width={64} height={64} />
          <h1 className="subject-chat__title">How can I help?</h1>
        </div>
      ))}

      {hasThread && (
        <div className="subject-chat__thread">
          {messages.map((message) => (
            <Message key={message.id} message={message} onCopy={copyMessage}
              onFeedback={(item, rating) => setMessages(current => current.map(entry => entry.id === item.id ? { ...entry, rating: entry.rating === rating ? null : rating } : entry))}
              onRegenerate={regenerateMessage} actionsDisabled={isPending || Boolean(disabledReason)} />
          ))}

          {isPending && (
            <p className="subject-chat__status" role="status">
              Thinking…
            </p>
          )}

        </div>
      )}
      </div>

      {showLatest && <button type="button" className="subject-chat__latest" onClick={() => {
        followLatest.current = true;
        setShowLatest(false);
        if (viewportRef.current) viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
      }}>Latest message ↓</button>}

      {error && (
        <div className="subject-chat__error" role="alert">
          <p>{error}</p>
          {failedMessage && (
            <button type="button" className="underline" disabled={isPending}
              onClick={() => void send(failedMessage.prompt)}>
              Retry last question
            </button>
          )}
        </div>
      )}

      <form className="subject-chat__prompt" onSubmit={handleSubmit}>
        <button type="button" disabled title="Attachments are not available yet" aria-label="Add attachment" className="subject-chat__icon-btn">
          <Plus size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <input
          type="text"
          className="subject-chat__input"
          placeholder={disabledReason ? "PDF processing unavailable" : "What do you want to learn today?"}
          aria-label="Question"
          aria-describedby={disabledReason ? "chat-disabled-reason" : undefined}
          value={draft}
          maxLength={MAX_PROMPT_LENGTH}
          disabled={isPending || Boolean(disabledReason)}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={!canSend} className="subject-chat__icon-btn" aria-label="Send question">
          Send
        </button>
        <button type="button" disabled title="Voice input is not connected" aria-label="Voice input" className="subject-chat__icon-btn">
          <Mic size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button type="button" disabled title="Audio reply is not connected" aria-label="Audio reply" className="subject-chat__icon-btn">
          <AudioWaveform size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </form>
      {disabledReason && <p id="chat-disabled-reason" className="subject-chat__notice">{disabledReason}</p>}
    </div>
  );
}
