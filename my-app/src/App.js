import { useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { SidebarProvider } from './components/SidebarContext';
import { EmptyState } from './components/EmptyState';
import { SubjectDetail } from './components/SubjectDetail';
import { CreateSubjectModal } from './components/CreateSubjectModal';
import './App.css';

function createId() {
  return window.crypto?.randomUUID?.() ?? String(Date.now());
}

function App() {
  const [subjects, setSubjects] = useState([]);
  const [activeSubjectId, setActiveSubjectId] = useState(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const activeSubject =
    subjects.find((subject) => subject.id === activeSubjectId) ?? null;

  const handleCreateSubject = () => setIsCreateOpen(true);

  const handleSubmit = ({ name, file }) => {
    const id = createId();
    setSubjects((prev) => [...prev, { id, name, file, instructions: "" }]);
    setActiveSubjectId(id);
    setIsCreateOpen(false);
  };

  const updateSubject = (id, patch) => {
    setSubjects((prev) =>
      prev.map((subject) =>
        subject.id === id ? { ...subject, ...patch } : subject
      )
    );
  };

  const deleteSubject = (id) => {
    setSubjects((prev) => prev.filter((subject) => subject.id !== id));
    setActiveSubjectId((current) => (current === id ? null : current));
  };

  return (
    <SidebarProvider>
      <div className="app">
        <Sidebar
          subjects={subjects}
          activeSubjectId={activeSubjectId}
          onSelectSubject={setActiveSubjectId}
          onAddSubject={handleCreateSubject}
        />
        <main className="app__main">
          {activeSubject ? (
            <SubjectDetail
              subject={activeSubject}
              onUpdateSubject={updateSubject}
              onDeleteSubject={deleteSubject}
              onBack={() => setActiveSubjectId(null)}
            />
          ) : (
            <EmptyState onCreateSubject={handleCreateSubject} />
          )}
        </main>
        <CreateSubjectModal
          open={isCreateOpen}
          onOpenChange={setIsCreateOpen}
          onSubmit={handleSubmit}
        />
      </div>
    </SidebarProvider>
  );
}

export default App;
