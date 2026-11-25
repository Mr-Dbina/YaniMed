"use client";

import { QuarantinedQuestions } from "@/components/mock-test/quarantined-questions";

export default function QuarantinedQuestionsPage() {
  return <QuarantinedQuestions onBack={() => window.history.back()} />;
}