import type { ChatMessage } from "@/lib/types";

// The backend has no route that returns a chat's messages, so the thread
// (chatId plus ordered messages) is kept here until one exists. Keyed by
// backend subject id because that id survives local re-merges.
const DATABASE = "yanimed-chat-threads";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("threads", { keyPath: "subjectId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Chat storage could not be opened."));
    request.onblocked = () =>
      reject(new Error("Close other YaniMed tabs and retry browser storage."));
  });
}

export interface ChatThread {
  subjectId: string;
  chatId?: string;
  messages: ChatMessage[];
}

export async function loadChatThread(subjectId: string): Promise<ChatThread | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("threads", "readonly");
    const request = tx.objectStore("threads").get(subjectId);
    tx.oncomplete = () => {
      db.close();
      resolve((request.result as ChatThread | undefined) ?? null);
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(new Error("Saved chat could not be read."));
    };
  });
}

export async function writeChatThread(thread: ChatThread): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("threads", "readwrite");
    tx.objectStore("threads").put(thread);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(new Error("Could not save the chat in this browser."));
    };
  });
}

export async function deleteChatThread(subjectId: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("threads", "readwrite");
    tx.objectStore("threads").delete(subjectId);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(new Error("Could not clear the saved chat."));
    };
  });
}
