const MAX_ICON_BASE64_BYTES = 87_384
const PNG_BASE64_PREFIX = 'iVBORw0KGgo'
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

export function computerUseIconDataUrl(iconBase64?: string): string | undefined {
  if (!iconBase64
    || iconBase64.length > MAX_ICON_BASE64_BYTES
    || iconBase64.length % 4 !== 0
    || !iconBase64.startsWith(PNG_BASE64_PREFIX)
    || !BASE64.test(iconBase64)) return undefined
  return `data:image/png;base64,${iconBase64}`
}
