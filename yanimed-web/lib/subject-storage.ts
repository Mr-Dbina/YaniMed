import type { Subject } from "@/lib/types";

// IndexedDB preserves the File itself; JSON/localStorage would lose its bytes.
const DATABASE = "yanimed-local-subjects";

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("subjects", { keyPath: "id" });
      request.result.createObjectStore("preferences");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Browser storage could not be opened."));
    request.onblocked = () => reject(new Error("Close other YaniMed tabs and retry browser storage."));
  });
}

export async function loadLocalSubjects(): Promise<{ subjects: Subject[]; activeSubjectId: string | null }> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["subjects", "preferences"], "readonly");
    const subjects = tx.objectStore("subjects").getAll();
    const selected = tx.objectStore("preferences").get("activeSubjectId");
    tx.oncomplete = () => {
      db.close();
      resolve({ subjects: subjects.result as Subject[], activeSubjectId: selected.result ?? null });
    };
    tx.onabort = tx.onerror = () => { db.close(); reject(new Error("Saved subjects could not be read.")); };
  });
}

export async function writeLocalSubject(subject: Subject | null, activeSubjectId: string | null, deleteId?: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["subjects", "preferences"], "readwrite");
    if (subject) tx.objectStore("subjects").put(subject);
    if (deleteId) tx.objectStore("subjects").delete(deleteId);
    tx.objectStore("preferences").put(activeSubjectId, "activeSubjectId");
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(new Error("Could not save in this browser. Check available storage and browser permissions, then retry."));
    };
  });
}
