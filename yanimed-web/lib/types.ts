export type MessageRole = "user" | "assistant";

export interface Subject {
  id: string;
  name: string;
  file: File | null;
  instructions: string;
}