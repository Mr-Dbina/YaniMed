"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { AudioWaveform, Mic, Plus } from "lucide-react";
import { Message } from "@/components/chat/message";
import type { ChatMessage } from "@/lib/types";
import { ApiError, MAX_PROMPT_LENGTH, requestAnswer } from "@/lib/api";

interface ChatConversationProps {
  onAsked?: (prompt: string) => void;
}

function createMessageId(): string {
  return crypto.randomUUID();
}

export function ChatConversation({ onAsked }: ChatConversationProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedPrompt, setFailedPrompt] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, isPending, error]);

  const canSend = draft.trim().length > 0 && !isPending;

  const send = async (rawPrompt: string, retry = false) => {
    const prompt = rawPrompt.trim();
    if (!prompt || isPending || abortRef.current) return;

    if (prompt.length > MAX_PROMPT_LENGTH) {
      setError(`Question is too long. Keep it under ${MAX_PROMPT_LENGTH} characters.`);
      return;
    }

    if (!retry) setMessages((current) => [
      ...current,
      { id: createMessageId(), role: "user", content: prompt },
    ]);
    setDraft("");
    setError(null);
    setFailedPrompt(null);
    setIsPending(true);
    onAsked?.(prompt);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await requestAnswer(prompt, controller.signal);
      setMessages((current) => [
        ...current,
        {
          id: createMessageId(), role: "assistant", content: result.answer,
          citations: result.citations, grounding: result.grounding, metadata: result.metadata,
        },
      ]);
    } catch (err) {
      if (controller.signal.aborted) return;
      setFailedPrompt(prompt);
      setError(
        err instanceof ApiError ? err.message : "Something went wrong while asking.",
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

  const copyMessage = (message: ChatMessage) => {
    void navigator.clipboard?.writeText(message.content);
  };

  const hasThread = messages.length > 0;

  return (
    <div className={`subject-chat${hasThread ? " subject-chat--thread" : ""}`}>
      <p className="text-sm text-muted-foreground" role="note">
        Development build: not for studying. Single-turn only. Answers are not grounded in your PDF and have no verified citations.
      </p>
      {!hasThread && (
        <div className="subject-chat__hero">
          <img src="/images/yanimed_logo.png" alt="" width={64} height={64} />
          <h1 className="subject-chat__title">How can I help?</h1>
        </div>
      )}

      {hasThread && (
        <div className="subject-chat__thread">
          {messages.map((message) => (
            <Message key={message.id} message={message} onCopy={copyMessage} />
          ))}

          {isPending && (
            <p className="subject-chat__status" role="status">
              Thinking…
            </p>
          )}

          <div ref={endRef} />
        </div>
      )}

      {error && (
        <div className="subject-chat__error" role="alert">
          <p>{error}</p>
          {failedPrompt && (
            <button type="button" className="underline" disabled={isPending}
              onClick={() => void send(failedPrompt, true)}>
              Retry last question
            </button>
          )}
          <p>You can also enter a new question below.</p>
        </div>
      )}

      <form className="subject-chat__prompt" onSubmit={handleSubmit}>
        <button type="button" disabled title="Attachments are not available yet" aria-label="Add attachment" className="subject-chat__icon-btn">
          <Plus size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <input
          type="text"
          className="subject-chat__input"
          placeholder="What do you want to learn today?"
          value={draft}
          maxLength={MAX_PROMPT_LENGTH}
          disabled={isPending}
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
    </div>
  );
}
