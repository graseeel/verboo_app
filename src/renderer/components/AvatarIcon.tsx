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
  className?: string
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean)
  if (!parts.length) return 'V'
  return parts.slice(0, 2).map(p => p[0]?.toUpperCase()).join('')
}

export function AvatarIcon({ settings, name, size = 34, className = '' }: AvatarIconProps) {
  const kind = settings?.kind ?? 'initials'
  // The backend saves every avatar as avatar.ext (fixed name), so uploadPath
  // never changes between uploads. We derive a compound imageId from
  // path + version — this busts the browser/webview cache and lets a failed
  // load retry after a new upload (failedId !== new imageId).
  const imageId = settings?.uploadPath
    ? `${settings.uploadPath}::v${settings.uploadVersion ?? 0}`
    : undefined
  const [failedId, setFailedId] = useState<string | undefined>()

  if (kind === 'upload' && settings?.uploadPath && imageId && failedId !== imageId) {
    const uploadPath = settings.uploadPath
    const uploadVer = settings.uploadVersion ?? 0
    const url = (window.verboo?.fileUrl?.(uploadPath) ?? '') + `?v=${uploadVer}`
    const fontSize = Math.round(size * 0.42)
    return (
      <span
        className={`avatar-outer avatar-upload ${className}`}
        style={{ width: size, height: size, minWidth: size, minHeight: size, fontSize }}
      >
        {url ? (
          <img
            key={imageId}
            src={url}
            alt=""
            className="avatar-img"
            onError={() => setFailedId(imageId)}
          />
        ) : (
          <span className="avatar-inner-text">{initials(name)}</span>
        )}
      </span>
    )
  }

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
