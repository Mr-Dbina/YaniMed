export type MessageRole = "user" | "assistant";

export interface Subject {
  id: string;
  name: string;
  file: File | null;
  instructions: string;
  /**
   * Most recent question asked in this subject, shown under the sidebar row.
   * Undefined until chat is built - the row simply renders without a preview.
   */
  lastMessage?: string;
}