// Friendly display names for known marketplaces. Raw names from the CLI are
// machine-readable (e.g. "claude-plugins-official"); this maps them to
// human-friendly labels. Unknown marketplaces fall back to the raw name.
const FRIENDLY_NAMES: Record<string, string> = {
  'claude-plugins-official': 'Claude Official',
  'superpowers-marketplace': 'Superpowers',
  'verboo-plugins': 'Verboo',
}

export function marketplaceFriendlyName(raw: string): string {
  return FRIENDLY_NAMES[raw] ?? raw
}
