"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { PanelLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/sidebar";
import { EmptyState } from "@/components/empty-state";
import { SubjectDetail, isChatSubject } from "@/components/subject-detail";
import { CreateSubjectModal } from "@/components/create-subject-modal";
import { useSubjectsStore } from "@/lib/stores/subjects-store";
import { useSidebarStore } from "@/lib/stores/sidebar-store";

export function AppShell({ children }: { children?: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const subjects = useSubjectsStore((state) => state.subjects);
  const activeSubjectId = useSubjectsStore((state) => state.activeSubjectId);
  const addSubject = useSubjectsStore((state) => state.addSubject);
  const updateSubject = useSubjectsStore((state) => state.updateSubject);
  const deleteSubject = useSubjectsStore((state) => state.deleteSubject);
  const setActiveSubject = useSubjectsStore((state) => state.setActiveSubject);
  const hydrated = useSubjectsStore((state) => state.hydrated);
  const hydrate = useSubjectsStore((state) => state.hydrate);
  const storageError = useSubjectsStore((state) => state.storageError);
  const collapsed = useSidebarStore((state) => state.isCollapsed);
  const toggleSidebar = useSidebarStore((state) => state.toggle);

  useEffect(() => {
    void hydrate();
    if (window.matchMedia("(max-width: 767px)").matches) {
      useSidebarStore.setState({ isCollapsed: true });
    }
  }, [hydrate]);

  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const activeSubject =
    subjects.find((subject) => subject.id === activeSubjectId) ?? subjects[0] ?? null;

  const selectSubject = (id: string) => {
    setActiveSubject(id);
    if (pathname !== "/mock-test") router.push("/subjects");
    if (window.matchMedia("(max-width: 767px)").matches) {
      useSidebarStore.setState({ isCollapsed: true });
    }
  };

  return (
    <div className={`app${!children && activeSubject && isChatSubject(activeSubject) ? " app--chat" : ""}`}>
      {collapsed && <button type="button" className="sidebar-open" aria-label="Open sidebar" onClick={toggleSidebar}><PanelLeft size={20} /></button>}
      <Sidebar
        subjects={subjects}
        activeSubjectId={activeSubjectId}
        onSelectSubject={selectSubject}
        onAddSubject={() => setIsCreateOpen(true)}
        onUpdateSubject={updateSubject}
        onDeleteSubject={deleteSubject}
      />

      <main className="app__main">
        {storageError && <p role="alert" className="storage-error">{storageError} {!hydrated && <button type="button" onClick={() => void hydrate()}>Retry loading</button>}</p>}
        {children ??
          (!hydrated ? <p role="status">Loading saved subjects…</p> : activeSubject ? (
            <SubjectDetail
              subject={activeSubject}
              onUpdateSubject={updateSubject}
              onDeleteSubject={deleteSubject}
              onBack={() => router.push("/subjects")}
            />
          ) : (
            <EmptyState onCreateSubject={() => setIsCreateOpen(true)} />
          ))}
      </main>

      {isCreateOpen && <CreateSubjectModal
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onSubmit={async (data) => {
          await addSubject(data);
          router.push("/subjects");
        }}
      />}
    </div>
  );
}
