"use client";

import { useState } from "react";
import { Sidebar } from "@/components/sidebar";
import { EmptyState } from "@/components/empty-state";
import { SubjectDetail } from "@/components/subject-detail";
import { CreateSubjectModal } from "@/components/create-subject-modal";
import { useSubjectsStore } from "@/lib/stores/subjects-store";

export function AppShell() {
  const subjects = useSubjectsStore((state) => state.subjects);
  const activeSubjectId = useSubjectsStore((state) => state.activeSubjectId);
  const addSubject = useSubjectsStore((state) => state.addSubject);
  const updateSubject = useSubjectsStore((state) => state.updateSubject);
  const deleteSubject = useSubjectsStore((state) => state.deleteSubject);
  const setActiveSubject = useSubjectsStore((state) => state.setActiveSubject);

  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const activeSubject =
    subjects.find((subject) => subject.id === activeSubjectId) ?? null;

  return (
    <div className="app">
      <Sidebar
        subjects={subjects}
        activeSubjectId={activeSubjectId}
        onSelectSubject={setActiveSubject}
        onAddSubject={() => setIsCreateOpen(true)}
      />

      <main className="app__main">
        {activeSubject ? (
          <SubjectDetail
            subject={activeSubject}
            onUpdateSubject={updateSubject}
            onDeleteSubject={deleteSubject}
            onBack={() => setActiveSubject(null)}
          />
        ) : (
          <EmptyState onCreateSubject={() => setIsCreateOpen(true)} />
        )}
      </main>

      <CreateSubjectModal
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onSubmit={addSubject}
      />
    </div>
  );
}
