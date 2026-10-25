import { create } from "zustand";
import type { Subject } from "@/lib/types";
import { loadLocalSubjects, writeLocalSubject } from "@/lib/subject-storage";

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

export const useSubjectsStore = create<SubjectsState>((set, get) => ({
  subjects: [],
  activeSubjectId: null,
  hydrated: false,
  storageError: null,
  hydrate: () => {
    if (get().hydrated) return Promise.resolve();
    if (hydration) return hydration;
    hydration = loadLocalSubjects().then(({ subjects, activeSubjectId }) => {
      set({ subjects, activeSubjectId: subjects.some(s => s.id === activeSubjectId) ? activeSubjectId : subjects[0]?.id ?? null, hydrated: true, storageError: null });
    }).catch((error: Error) => { set({ storageError: error.message }); }).finally(() => { hydration = null; });
    return hydration;
  },
  addSubject: ({ name, file }) => enqueue(async () => {
    if (!get().hydrated) throw new Error("Wait for saved subjects to load first.");
    if (!name.trim() || !file || file.type !== "application/pdf" || file.size === 0) throw new Error("Enter a subject name and select a nonempty PDF.");
    // Frontend upload wiring is intentionally deferred until the backend
    // document endpoint and same-origin API route are available. The local
    // subject record remains the source of truth in this phase.
    const subject: Subject = { id: createId(), name: name.trim(), file, instructions: "", processingStatus: "unavailable" };
    await writeLocalSubject(subject, subject.id);
    set(state => ({ subjects: [...state.subjects, subject], activeSubjectId: subject.id, storageError: null }));
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
