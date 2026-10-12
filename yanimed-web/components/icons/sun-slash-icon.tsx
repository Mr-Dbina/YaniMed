interface SunSlashIconProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
}

/**
 * Sun crossed by a diagonal slash with a crescent behind it. Hand-authored to
 * match the supplied artwork, which has no background to strip because it is
 * drawn inline rather than loaded as an image.
 */
export function SunSlashIcon({ size = 18, strokeWidth = 1.75, className }: SunSlashIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 2v2" />
      <path d="m4.9 4.9 1.4 1.4" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m19.1 4.9-1.4 1.4" />
      <path d="M15.9 15.9a5 5 0 1 1-6.6-6.6" />
      <path d="M18.4 18.4a5 5 0 0 0 1.6-9.6" />
      <path d="m3 21 18-18" />
    </svg>
  );
}