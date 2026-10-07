import { create } from "zustand";
import type { Subject } from "@/lib/types";

function createId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : String(Date.now());
}

interface SubjectsState {
  subjects: Subject[];
  activeSubjectId: string | null;
  addSubject: (data: { name: string; file: File | null }) => void;
  updateSubject: (id: string, patch: Partial<Omit<Subject, "id">>) => void;
  deleteSubject: (id: string) => void;
  setActiveSubject: (id: string | null) => void;
}

export const useSubjectsStore = create<SubjectsState>((set) => ({
  subjects: [],
  activeSubjectId: null,
  addSubject: ({ name, file }) =>
    set((state) => {
      const id = createId();
      return {
        subjects: [...state.subjects, { id, name, file, instructions: "" }],
        activeSubjectId: id,
      };
    }),
  updateSubject: (id, patch) =>
    set((state) => ({
      subjects: state.subjects.map((subject) =>
        subject.id === id ? { ...subject, ...patch } : subject
      ),
    })),
  deleteSubject: (id) =>
    set((state) => ({
      subjects: state.subjects.filter((subject) => subject.id !== id),
      activeSubjectId:
        state.activeSubjectId === id ? null : state.activeSubjectId,
    })),
  setActiveSubject: (id) => set({ activeSubjectId: id }),
}));
