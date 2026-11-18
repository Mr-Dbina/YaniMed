import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";

export const instant = false;

// The subject id is read from the pathname inside AppShell, which renders the
// chat for /subjects/<id> and falls back to the grid for unknown ids.
export default function SubjectChatPage() {
  return (
    <Suspense fallback={<div className="app" aria-hidden="true" />}>
      <AppShell />
    </Suspense>
  );
}
