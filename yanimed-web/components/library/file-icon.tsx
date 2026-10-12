import { FileText, FileType, Image as ImageIcon, Sheet, Presentation } from "lucide-react";
import type { LucideIcon } from "lucide-react";

const PDF: LucideIcon = FileType;
const DOC: LucideIcon = FileText;
const SHEET: LucideIcon = Sheet;
const DECK: LucideIcon = Presentation;

function resolveIcon(extension: string): { Icon: LucideIcon; tone: string } {
  switch (extension) {
    case "pdf":
      return { Icon: PDF, tone: "pdf" };
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "svg":
      return { Icon: ImageIcon, tone: "image" };
    case "csv":
    case "xls":
    case "xlsx":
      return { Icon: SHEET, tone: "sheet" };
    case "ppt":
    case "pptx":
    case "key":
      return { Icon: DECK, tone: "deck" };
    case "doc":
    case "docx":
    case "txt":
    case "md":
      return { Icon: DOC, tone: "doc" };
    default:
      return { Icon: FileText, tone: "file" };
  }
}

interface FileIconProps {
  extension: string;
  size?: "sm" | "lg";
}

export function FileIcon({ extension, size = "sm" }: FileIconProps) {
  const { Icon, tone } = resolveIcon(extension);
  return (
    <span className={`file-icon file-icon--${tone} file-icon--${size}`}>
      <Icon size={size === "lg" ? 26 : 18} strokeWidth={1.7} aria-hidden="true" />
      {size === "lg" && extension ? (
        <span className="file-icon__ext">{extension.toUpperCase()}</span>
      ) : null}
    </span>
  );
}