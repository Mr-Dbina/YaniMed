import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { MockTestScreen } from "@/components/mock-test/mock-test-screen";

export default function MockTestPage() {
  return (
    <AppShell>
      <Suspense fallback={<div className="mock-test" />}>
        <MockTestScreen />
      </Suspense>
    </AppShell>
  );
}
