"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { PanelLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/sidebar";
import { SubjectGrid } from "@/components/subject-grid";
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

  // Chat lives at /subjects/<key>; every other childless route shows the grid,
  // so /subjects never falls back to the first subject's chat. The key prefers
  // backendSubjectId because backend-only rows get a fresh local id per hydrate
  // (same rule as the store's activeSubjectKey).
  const chatRouteMatch = pathname.match(/^\/subjects\/([^/]+)$/);
  const chatSubject = chatRouteMatch
    ? subjects.find(
        (subject) =>
          subject.backendSubjectId === chatRouteMatch[1] ||
          subject.id === chatRouteMatch[1],
      ) ?? null
    : null;

  const subjectKey = (id: string) => {
    const subject = subjects.find((item) => item.id === id);
    return subject?.backendSubjectId ?? id;
  };

  const selectSubject = (id: string) => {
    setActiveSubject(id);
    if (pathname !== "/mock-test") router.push(`/subjects/${subjectKey(id)}`);
    if (window.matchMedia("(max-width: 767px)").matches) {
      useSidebarStore.setState({ isCollapsed: true });
    }
  };

  const openSubject = (id: string) => {
    setActiveSubject(id);
    router.push(`/subjects/${subjectKey(id)}`);
    if (window.matchMedia("(max-width: 767px)").matches) {
      useSidebarStore.setState({ isCollapsed: true });
    }
  };

  const handleDeleteSubject = async (id: string) => {
    const key = subjectKey(id);
    await deleteSubject(id);
    if (pathname === `/subjects/${key}`) router.push("/subjects");
  };

  const grid = (
    <SubjectGrid
      subjects={subjects}
      onOpenSubject={openSubject}
      onCreateSubject={() => setIsCreateOpen(true)}
      onUpdateSubject={updateSubject}
      onDeleteSubject={handleDeleteSubject}
    />
  );

  return (
    <div className={`app${!children && chatSubject && isChatSubject(chatSubject) ? " app--chat" : ""}`}>
      {collapsed && <button type="button" className="sidebar-open" aria-label="Open sidebar" onClick={toggleSidebar}><PanelLeft size={20} /></button>}
      <Sidebar
        subjects={subjects}
        activeSubjectId={activeSubjectId}
        currentSubject={chatSubject}
        onSelectSubject={selectSubject}
        onAddSubject={() => setIsCreateOpen(true)}
        onUpdateSubject={updateSubject}
        onDeleteSubject={handleDeleteSubject}
      />

      <main className="app__main">
        {storageError && <p role="alert" className="storage-error">{storageError} {!hydrated && <button type="button" onClick={() => void hydrate()}>Retry loading</button>}</p>}
        {children ?? (!hydrated ? (
          <p role="status">Loading saved subjects…</p>
        ) : chatRouteMatch ? (
          chatSubject ? (
            <SubjectDetail
              subject={chatSubject}
              onUpdateSubject={updateSubject}
              onDeleteSubject={handleDeleteSubject}
              onBack={() => router.push("/subjects")}
            />
          ) : (
            grid
          )
        ) : (
          grid
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
