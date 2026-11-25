"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { FormEvent } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Mic, Plus, ArrowUp, ChevronLeft, ChevronRight, Minimize2, Maximize2, X, BookOpen, Loader2, ChevronDown } from "lucide-react";
import { Message } from "@/components/chat/message";
import { PDFViewer, type PDFViewerRef } from "@/components/chat/pdf-viewer";
import type { ChatMessage, ChatCitation } from "@/lib/types";
import { ApiError, MAX_PROMPT_LENGTH, requestAnswer } from "@/lib/api";
import { requestSubjectAnswer } from "@/lib/backend-api";
import { loadChatThread, writeChatThread } from "@/lib/chat-storage";

interface ChatConversationProps {
  onAsked?: (prompt: string) => void;
  disabledReason?: string;
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

export function ChatConversation({ onAsked, disabledReason, subjectId }: ChatConversationProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const chatIdRef = useRef<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedMessage, setFailedMessage] = useState<{ id: string; prompt: string; assistantId?: string } | null>(null);
  const [isMultiline, setIsMultiline] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const [loadedThreadFor, setLoadedThreadFor] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [pdfOpen, setPdfOpen] = useState(false);
  const [pdfExpanded, setPdfExpanded] = useState(false);
  const [currentPdfPage, setCurrentPdfPage] = useState(1);
  const [totalPdfPages, setTotalPdfPages] = useState(1);
  const [pdfZoom, setPdfZoom] = useState(100);
  const [activeCitationIndex, setActiveCitationIndex] = useState(0);
  const [allCitations, setAllCitations] = useState<ChatCitation[]>([]);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const pdfContainerRef = useRef<PDFViewerRef>(null);
  const isMobile = typeof window !== "undefined" && window.innerWidth <= 860;

  const canSend = draft.trim().length > 0 && !isPending && !disabledReason;

  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    const newHeight = Math.min(textarea.scrollHeight, 160);
    textarea.style.height = `${newHeight}px`;
    setIsMultiline(newHeight > 28);
  }, []);

  const handleTextareaChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value);
    requestAnimationFrame(adjustTextareaHeight);
  }, [adjustTextareaHeight]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSend) {
        void send(draft);
      }
    }
  }, [canSend, draft]);

  useEffect(() => {
    if (!subjectId) return undefined;
    let cancelled = false;
    void loadChatThread(subjectId)
      .then((thread) => {
        if (cancelled || !thread) return;
        chatIdRef.current = chatIdRef.current ?? thread.chatId;
        setMessages((current) => (current.length === 0 ? thread.messages : current));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoadedThreadFor(subjectId);
      });
    return () => {
      cancelled = true;
    };
  }, [subjectId]);

  useEffect(() => {
    if (!subjectId || loadedThreadFor !== subjectId) return;
    void writeChatThread({ subjectId, chatId: chatIdRef.current, messages }).catch(
      () => undefined,
    );
  }, [subjectId, loadedThreadFor, messages]);

  useEffect(() => {
    if (!messages.length || typeof window === "undefined" || !window.location.hash) return;
    const targetId = window.location.hash.replace(/^#/, "");
    const element = document.getElementById(targetId) || document.getElementById(`msg-${targetId}`);
    if (element) {
      followLatest.current = false;
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [messages]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && followLatest.current) viewport.scrollTop = viewport.scrollHeight;
  }, [messages, isPending, error]);

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
    setIsMultiline(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
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
      
      if (result.citations && result.citations.length > 0) {
        setAllCitations(result.citations);
        setActiveCitationIndex(0);
        setPdfOpen(true);
        setPdfExpanded(false);
        if (result.citations[0].documentId) {
          setDocumentId(result.citations[0].documentId);
        }
        if (result.citations[0].page) {
          setCurrentPdfPage(result.citations[0].page);
        }
      }
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

  const handleCitationClick = (citation: ChatCitation, index: number) => {
    setActiveCitationIndex(index);
    setCurrentPdfPage(citation.page);
    if (citation.documentId) {
      setDocumentId(citation.documentId);
    }
    if (!pdfOpen) {
      setPdfOpen(true);
      setPdfExpanded(false);
    }
  };

  const handleClosePdf = () => {
    setPdfOpen(false);
    setPdfExpanded(false);
    setActiveCitationIndex(0);
  };

  const handleToggleExpand = () => {
    setPdfExpanded(prev => !prev);
  };

  const handlePageChange = (page: number) => {
    setCurrentPdfPage(page);
  };

  const handleZoomChange = (zoom: number) => {
    setPdfZoom(zoom);
  };

  const handleKeyDownGlobal = useCallback((e: globalThis.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (pdfExpanded) {
        setPdfExpanded(false);
        e.preventDefault();
      } else if (pdfOpen) {
        handleClosePdf();
        e.preventDefault();
      }
    }
    if (pdfOpen && !isMobile) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (currentPdfPage > 1) setCurrentPdfPage(currentPdfPage - 1);
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        if (currentPdfPage < totalPdfPages) setCurrentPdfPage(currentPdfPage + 1);
      }
    }
  }, [pdfOpen, pdfExpanded, isMobile, currentPdfPage, totalPdfPages]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDownGlobal as EventListener);
    return () => window.removeEventListener("keydown", handleKeyDownGlobal as EventListener);
  }, [handleKeyDownGlobal]);

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth <= 860;
      if (mobile && pdfExpanded) {
        setPdfExpanded(false);
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [pdfExpanded]);

  const hasThread = messages.length > 0;
  const latestAssistantMessage = [...messages].reverse().find(m => m.role === "assistant");
  const citationsToShow = latestAssistantMessage?.citations ?? [];

  return (
    <div className={`subject-chat${hasThread ? " subject-chat--thread" : ""} ${pdfOpen ? " pdf-open" : ""} ${pdfExpanded ? " pdf-expanded" : ""}`}>
      {(!subjectId || disabledReason) && (
        <p className="subject-chat__notice text-sm text-muted-foreground" role="note">
          {disabledReason ? "PDF not indexed · chat unavailable" : "Development preview · ungrounded · not for studying"}
        </p>
      )}
      <div className="subject-chat__viewport" ref={viewportRef} onScroll={(event) => {
        const element = event.currentTarget;
        const isAtBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        followLatest.current = isAtBottom;
        setShowLatest(!isAtBottom);
        const latestBtn = document.querySelector('.subject-chat__latest') as HTMLElement;
        if (latestBtn) {
          if (isAtBottom) {
            latestBtn.classList.remove('visible');
          } else {
            latestBtn.classList.add('visible');
          }
        }
      }}>
      {!hasThread && (
        <div className="subject-chat__hero">
          <img src="/images/yanimed_logo.png" alt="" width={64} height={64} />
          <h1 className="subject-chat__title">How can I help?</h1>
        </div>
      )}

      {hasThread && (
        <div className="subject-chat__thread">
          {messages.map((message) => (
            <Message key={message.id} id={`msg-${message.id}`} message={message} onCopy={copyMessage}
              onFeedback={(item, rating) => setMessages(current => current.map(entry => entry.id === item.id ? { ...entry, rating: entry.rating === rating ? null : rating } : entry))}
              onRegenerate={regenerateMessage} actionsDisabled={isPending || Boolean(disabledReason)}
              onCitationClick={handleCitationClick}
              allCitations={allCitations}
              activeCitationIndex={activeCitationIndex}
            />
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
        if (viewportRef.current) viewportRef.current.scrollTo({ top: viewportRef.current.scrollHeight, behavior: "smooth" });
      }} aria-label="Scroll to latest message">
        <ChevronDown size={20} strokeWidth={1.8} aria-hidden="true" />
      </button>}

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

      <form className={`subject-chat__prompt ${isMultiline ? 'subject-chat__prompt--multiline' : ''}`} onSubmit={handleSubmit}>
        <button type="button" disabled title="Attachments are not available yet" aria-label="Add attachment" className="subject-chat__icon-btn">
          <Plus size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <textarea
          ref={textareaRef}
          className="subject-chat__input"
          placeholder={disabledReason ? "PDF processing unavailable" : "Ask YaniMed"}
          aria-label="Question"
          aria-describedby={disabledReason ? "chat-disabled-reason" : undefined}
          value={draft}
          maxLength={MAX_PROMPT_LENGTH}
          disabled={isPending || Boolean(disabledReason)}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <button type="button" disabled title="Voice input is not connected" aria-label="Voice input" className="subject-chat__icon-btn">
          <Mic size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
        {draft.trim().length > 0 && (
          <div className="subject-chat__send-wrapper">
            <button
              type="submit"
              disabled={!canSend}
              className="subject-chat__send-btn"
              aria-label="Send question"
            >
              <ArrowUp size={20} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        )}
      </form>
      <p className="subject-chat__disclaimer">YaniMed is AI and can make mistakes.</p>
      {disabledReason && <p id="chat-disabled-reason" className="subject-chat__notice">{disabledReason}</p>}

      {pdfOpen && documentId && (
        <PDFViewer
          ref={pdfContainerRef}
          citations={citationsToShow}
          activeCitationIndex={activeCitationIndex}
          onPageChange={setCurrentPdfPage}
          onClose={handleClosePdf}
          onToggleExpand={handleToggleExpand}
          isExpanded={pdfExpanded}
          totalPages={totalPdfPages}
          currentPage={currentPdfPage}
          zoom={pdfZoom}
          onZoomChange={setPdfZoom}
          documentId={documentId}
        />
      )}

      {pdfOpen && isMobile && (
        <div className="pdf-viewer__mobile-backdrop" onClick={handleClosePdf} aria-hidden="true" />
      )}
    </div>
  );
}