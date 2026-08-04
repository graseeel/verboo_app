import type { TurnActionKind } from '../../../shared/types'

const box = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

export function ThinkingIcon() {
  return <svg {...box}><circle cx="8" cy="8" r="6" opacity="0.5" /><path d="M8 4.5v3.5l2 1.5" /></svg>
}

export function ActionIcon({ kind }: { kind: TurnActionKind }) {
  switch (kind) {
    case 'read':
      return <svg {...box}><path d="M3 3.5h6l2 2v7H3z" /><path d="M9 3.5v2h2" /></svg>
    case 'search':
      return <svg {...box}><circle cx="7" cy="7" r="3.5" /><path d="M10 10l3 3" /></svg>
    case 'edit':
      return <svg {...box}><path d="M3 11l7-7 2 2-7 7H3z" /><path d="M9 5l2 2" /></svg>
    case 'create':
      return <svg {...box}><path d="M8 3v10M3 8h10" /></svg>
    case 'delete':
      return <svg {...box}><path d="M4 5h8M6.5 5V3.5h3V5M5 5l.7 8h4.6L11 5" /></svg>
    case 'command':
      return <svg {...box}><path d="M4 5l3 3-3 3M9 11h3" /></svg>
    case 'terminal':
      return <svg {...box}><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" /><path d="M5 7l2 1.5L5 10" /></svg>
    case 'image':
      return <svg {...box}><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" /><circle cx="6" cy="6.5" r="1" /><path d="M4 11l2.5-2.5L8 10l1.5-1.5L12 11" /></svg>
    case 'permission':
      return <svg {...box}><rect x="4" y="7" width="8" height="6" rx="1" /><path d="M6 7V5.5a2 2 0 0 1 4 0V7" /></svg>
    case 'agent-open':
      return <svg {...box}><circle cx="8" cy="6" r="2.5" /><path d="M3.5 13a4.5 4.5 0 0 1 9 0" /></svg>
    case 'agent-close':
      return <svg {...box}><circle cx="8" cy="6" r="2.5" opacity="0.5" /><path d="M4 13l8-8" /></svg>
    // FRENTE-A (2026-08-02): generic globe — NEVER the Google Chrome logo
    // (trademarked; the app is publicly distributed and signed under the
    // owner's name). The word "Chrome" lives in the LABEL, not the icon.
    // Same line style as the siblings: 16px stroke 1.4 round.
    case 'browser':
      return <svg {...box}><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.5 1.5 2.2 3.4 2.2 5.5S9.5 12 8 13.5C6.5 12 5.8 10.1 5.8 8S6.5 4 8 2.5" /></svg>
    default:
      return <svg {...box}><circle cx="8" cy="8" r="2" /><path d="M8 2v2M8 12v2M2 8h2M12 8h2" /></svg>
  }
}
