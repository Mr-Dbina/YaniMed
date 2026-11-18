import { AppShell } from "@/components/app-shell";

// AppShell resolves the chat from usePathname(), which cannot be prerendered.
export const instant = false;

// The subject id is read from the pathname inside AppShell, which renders the
// chat for /subjects/<id> and falls back to the grid for unknown ids.
export default function SubjectChatPage() {
  return <AppShell />;
}
