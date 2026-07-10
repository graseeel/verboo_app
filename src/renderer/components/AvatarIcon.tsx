/**
 * AvatarIcon — renders the user's profile picture.
 *
 * kind='initials' → initials on gradient background (default)
 * kind='preset'   → inline SVG from the 50-icon library with chosen color
 * kind='upload'   → <img> from local photo (convertFileSrc), onError → initials
 *
 * All variants render as a perfect circle (width=height, border-radius: 50%).
 * Supply `size` to set the outer dimension (default 34px).
 * Supply `className` to override the outer wrapper's class.
 */

import { useState } from 'react'
import type { AvatarSettings } from '../../shared/types'
import { renderPreset } from '../features/profile/avatarPresets'

type AvatarIconProps = {
  settings?: AvatarSettings
  /** Fallback name shown as initials when no preset/upload is set */
  name: string
  /** Outer dimension in pixels (default 34). The avatar is always a circle. */
  size?: number
  /** Optional CSS class added to the outer wrapper */
  className?: string
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean)
  if (!parts.length) return 'V'
  return parts.slice(0, 2).map(p => p[0]?.toUpperCase()).join('')
}

export function AvatarIcon({ settings, name, size = 34, className = '' }: AvatarIconProps) {
  const kind = settings?.kind ?? 'initials'
  // Upload img error state → fall back to initials
  const [imgFailed, setImgFailed] = useState(false)

  // ── Uploaded photo (with fallback) ─────────────────────────
  if (kind === 'upload' && settings?.uploadPath && !imgFailed) {
    const url = window.verboo?.fileUrl?.(settings.uploadPath) ?? ''
    const fontSize = Math.round(size * 0.42)
    return (
      <span
        className={`avatar-outer avatar-upload ${className}`}
        style={{ width: size, height: size, minWidth: size, minHeight: size, fontSize }}
      >
        {url ? (
          <img
            src={url}
            alt=""
            className="avatar-img"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <span className="avatar-inner-text">{initials(name)}</span>
        )}
      </span>
    )
  }

  // ── Preset icon ────────────────────────────────────────────
  if (kind === 'preset' && settings?.presetId) {
    const color = settings.presetColor ?? '#6B7280'
    return (
      <span
        className={`avatar-outer avatar-preset ${className}`}
        style={{
          width: size, height: size, minWidth: size, minHeight: size,
          color, backgroundColor: color,
        }}
      >
        {renderPreset(settings.presetId, '#fff')}
      </span>
    )
  }

  // ── Initials (default) ─────────────────────────────────────
  const fontSize = Math.round(size * 0.42)
  return (
    <span
      className={`avatar-outer avatar-initials ${className}`}
      style={{ width: size, height: size, minWidth: size, minHeight: size, fontSize }}
    >
      <span className="avatar-inner-text">{initials(name)}</span>
    </span>
  )
}
