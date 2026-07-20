/**
 * Full-color Google Chrome wheel, drawn inline so the settings/plugins
 * surfaces show the authentic logo instead of a generic panel icon.
 * Pure SVG (no external asset), scales crisply at 13–20px.
 */

type Props = {
  size?: number
  className?: string
}

export function ChromeLogoIcon({ size = 16, className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* Outer wheel: three 120° segments around the hub. */}
      {/* Red — across the top. */}
      <path d="M12 12 3.34 7A10 10 0 0 1 20.66 7Z" fill="#EA4335" />
      {/* Yellow — lower left. */}
      <path d="M12 12 3.34 7A10 10 0 0 0 12 22Z" fill="#FBBC04" />
      {/* Green — lower right. */}
      <path d="M12 12v10A10 10 0 0 0 20.66 7Z" fill="#34A853" />
      {/* Hub: white bezel + blue core. */}
      <circle cx="12" cy="12" r="5.4" fill="#fff" />
      <circle cx="12" cy="12" r="4.2" fill="#4285F4" />
    </svg>
  )
}
