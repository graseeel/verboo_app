/**
 * AvatarIcon — renders the user's profile picture based on AvatarSettings.
 *
 * kind='initials' → fallback initials (legacy/default)
 * kind='preset'   → inline SVG from the 50-icon library with user's chosen color
 * kind='upload'   → <img> from the local photo (via convertFileSrc)
 *
 * All variants are wrapped in a `.avatar-icon` span with `object-fit: cover`
 * and a circular clip so the renderer doesn't need to worry about sizing.
 */

import type { AvatarSettings } from '../../shared/types'
import { renderPreset } from '../features/profile/avatarPresets'

type AvatarIconProps = {
  settings?: AvatarSettings
  /** Fallback name used for initials when settings.kind='initials' or absent */
  name: string
  /** Optional CSS class override */
  className?: string
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean)
  if (!parts.length) return 'V'
  return parts.slice(0, 2).map(p => p[0]?.toUpperCase()).join('')
}

export function AvatarIcon({ settings, name, className = '' }: AvatarIconProps) {
  const kind = settings?.kind ?? 'initials'

  if (kind === 'preset' && settings?.presetId) {
    const color = settings.presetColor ?? '#6B7280'
    return (
      <span className={`avatar-icon avatar-preset ${className}`} style={{ color }}>
        {renderPreset(settings.presetId, color)}
      </span>
    )
  }

  if (kind === 'upload' && settings?.uploadPath) {
    const url = window.verboo?.fileUrl?.(settings.uploadPath) ?? ''
    return (
      <span className={`avatar-icon avatar-upload ${className}`}>
        {url ? <img src={url} alt="" className="avatar-img" /> : initials(name)}
      </span>
    )
  }

  // Default / initials
  return (
    <span className={`avatar-icon avatar-initials ${className}`}>
      {initials(name)}
    </span>
  )
}
