import { create } from "zustand";
import type { Subject } from "@/lib/types";
import { loadLocalSubjects, writeLocalSubject } from "@/lib/subject-storage";
import { ApiError } from "@/lib/api";
import {
  createInitialSubject,
  InitialUploadDuplicateError,
  isInitialUploadTerminal,
  listSubjects,
  SubjectNameConflictError,
  type BackendSubject,
  type DuplicateAction,
  type InitialUploadResult,
} from "@/lib/backend-api";

const KEY_REUSE_MESSAGE = "Idempotency key is already used for different request content.";
const inFlightSyncs = new Set<string>();

function createId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : String(Date.now());
}

interface SubjectsState {
  subjects: Subject[];
  activeSubjectId: string | null;
  hydrated: boolean;
  storageError: string | null;
  hydrate: () => Promise<void>;
  addSubject: (data: { name: string; file: File | null }) => Promise<void>;
  updateSubject: (id: string, patch: Partial<Omit<Subject, "id">>) => void;
  syncSubject: (id: string, duplicateAction?: DuplicateAction) => Promise<void>;
  deleteSubject: (id: string) => void;
  setActiveSubject: (id: string | null) => void;
}

let hydration: Promise<void> | null = null;
let writes: Promise<unknown> = Promise.resolve();
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = writes.then(work);
  writes = next.catch(() => undefined);
  return next;
}

function shouldResumeSync(subject: Subject): boolean {
  if (!subject.idempotencyKey || subject.backendSubjectId) return false;
  if (subject.uploadStatus === "UPLOADED") return false;
  const kind = subject.syncError?.kind;
  return kind !== "name_conflict" && kind !== "key_conflict" && kind !== "duplicate_pdf";
}

/**
 * Local rows stay as they are. A backend row without a local row behind it is
 * added in memory only, linked through backendSubjectId.
 */
function mergeSubjects(localSubjects: Subject[], backendSubjects: BackendSubject[]): Subject[] {
  // A persisted upload status is not proof of a live upload. Rows without a
  // backend id stay only while this page session is syncing them.
  const localRows = localSubjects.filter(
    subject => subject.backendSubjectId || inFlightSyncs.has(subject.id),
  );
  const merged = [...localRows];
  const knownBackendIds = new Set(
    localRows
      .map(subject => subject.backendSubjectId)
      .filter((id): id is string => Boolean(id)),
  );

  for (const backendSubject of backendSubjects) {
    if (knownBackendIds.has(backendSubject.id)) continue;
    knownBackendIds.add(backendSubject.id);
    merged.push({
      id: createId(),
      name: backendSubject.name,
      file: null,
      instructions: "",
      backendSubjectId: backendSubject.id,
    });
  }
  return merged;
}

function toSyncError(error: unknown): NonNullable<Subject["syncError"]> {
  if (error instanceof InitialUploadDuplicateError) {
    const actions = error.allowedActions.length > 0
      ? ` Allowed actions: ${error.allowedActions.join(", ")}.`
      : "";
    return {
      kind: "duplicate_pdf",
      message: `This PDF is already stored on the server (existing file: ${error.existingFilename}).${actions}`,
    };
  }
  if (error instanceof SubjectNameConflictError) {
    return {
      kind: "name_conflict",
      message: "A subject with this name already exists on the server.",
    };
  }
  if (error instanceof ApiError) {
    if (error.status === 409 && error.message === KEY_REUSE_MESSAGE) {
      return { kind: "key_conflict", message: "This upload can no longer be retried safely." };
    }
    if (typeof error.status === "number") return { kind: "rejected", message: error.message };
    return { kind: "network", message: "Could not reach the server." };
  }
  return { kind: "network", message: "Could not reach the server." };
}

export const useSubjectsStore = create<SubjectsState>((set, get) => ({
  subjects: [],
  activeSubjectId: null,
  hydrated: false,
  storageError: null,
  hydrate: () => {
    if (get().hydrated) return Promise.resolve();
    if (hydration) return hydration;
    hydration = Promise.allSettled([loadLocalSubjects(), listSubjects()]).then(([localResult, serverResult]) => {
      // A browser-storage failure keeps the old retry path: no subjects, not hydrated.
      if (localResult.status === "rejected") {
        set({ storageError: localResult.reason instanceof Error ? localResult.reason.message : "Browser storage could not be opened." });
        return;
      }
      const local = localResult.value;
      const subjects = serverResult.status === "fulfilled"
        ? mergeSubjects(local.subjects, serverResult.value)
        : local.subjects;
      set({
        subjects,
        activeSubjectId: subjects.some(s => s.id === local.activeSubjectId) ? local.activeSubjectId : subjects[0]?.id ?? null,
        hydrated: true,
        storageError: serverResult.status === "rejected"
          ? "Could not load subjects from the server. Showing saved subjects."
          : null,
      });
      for (const subject of local.subjects) {
        if (shouldResumeSync(subject)) void get().syncSubject(subject.id);
      }
    }).finally(() => { hydration = null; });
    return hydration;
  },
  addSubject: ({ name, file }) => enqueue(async () => {
    if (!get().hydrated) throw new Error("Wait for saved subjects to load first.");
    if (!name.trim() || !file || file.type !== "application/pdf" || file.size === 0) throw new Error("Enter a subject name and select a nonempty PDF.");
    const id = createId();
    const subject: Subject = {
      id,
      name: name.trim(),
      file,
      instructions: "",
      processingStatus: "unavailable",
      idempotencyKey: id,
      uploadName: name.trim(),
      uploadStatus: "PENDING",
    };
    await writeLocalSubject(subject, subject.id);
    set(state => ({ subjects: [...state.subjects, subject], activeSubjectId: subject.id, storageError: null }));
    void get().syncSubject(subject.id);
  }),
  updateSubject: (id, patch) => {
    void enqueue(async () => {
      const current = get().subjects.find(s => s.id === id);
      if (!current) return;
      const subject = { ...current, ...patch };
      await writeLocalSubject(subject, get().activeSubjectId);
      set(state => ({ subjects: state.subjects.map(s => s.id === id ? subject : s), storageError: null }));
    }).catch((error: Error) => set({ storageError: error.message }));
  },
  syncSubject: async (id, duplicateAction) => {
    if (inFlightSyncs.has(id)) return;
    const subject = get().subjects.find(s => s.id === id);
    if (!subject || subject.backendSubjectId) return;
    const { file, idempotencyKey, name, uploadName } = subject;
    if (!file || !idempotencyKey) return;

    inFlightSyncs.add(id);
    try {
      let result: InitialUploadResult;
      try {
        result = await createInitialSubject({
          // Renaming changes only the local label; the frozen upload name is sent.
          name: uploadName ?? name,
          idempotencyKey,
          file,
          ...(duplicateAction ? { duplicateAction } : {}),
        });
      } catch (error) {
        await patchSubject(id, { syncError: toSyncError(error) }).catch(() => undefined);
        return;
      }
      // backendSubjectId marks a completed upload so non-terminal records stay
      // eligible for Retry sync and hydrate recovery.
      await patchSubject(id, {
        ...(isInitialUploadTerminal(result) ? { backendSubjectId: result.subjectId } : {}),
        documentId: result.documentId,
        uploadStatus: result.uploadStatus,
        syncError: undefined,
      }).catch(() => undefined);
    } finally {
      inFlightSyncs.delete(id);
    }
  },
  deleteSubject: (id) => {
    void enqueue(async () => {
      const subjects = get().subjects.filter(s => s.id !== id);
      const activeSubjectId = get().activeSubjectId === id ? subjects[0]?.id ?? null : get().activeSubjectId;
      await writeLocalSubject(null, activeSubjectId, id);
      set({ subjects, activeSubjectId, storageError: null });
    }).catch((error: Error) => set({ storageError: error.message }));
  },
  setActiveSubject: (id) => {
    set({ activeSubjectId: id });
    void enqueue(() => writeLocalSubject(null, get().activeSubjectId))
      .catch((error: Error) => set({ storageError: error.message }));
  },
}));

async function patchSubject(id: string, patch: Partial<Omit<Subject, "id">>): Promise<void> {
  try {
    await enqueue(async () => {
      const state = useSubjectsStore.getState();
      const current = state.subjects.find(subject => subject.id === id);
      if (!current) return;
      const subject = { ...current, ...patch };
      await writeLocalSubject(subject, state.activeSubjectId);
      useSubjectsStore.setState(latest => ({
        subjects: latest.subjects.map(item => item.id === id ? subject : item),
        storageError: null,
      }));
    });
  } catch (error) {
    useSubjectsStore.setState({ storageError: error instanceof Error ? error.message : "Could not save sync status." });
    throw error;
  }
}
