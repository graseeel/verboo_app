/** IPC codes from `credentials_store.rs`. The renderer localizes them. */
export const SECRET_SERVICE_UNAVAILABLE = 'secret_service_unavailable'
export const SECRET_SERVICE_FILE_FALLBACK = 'secret_service_file_fallback'

export function invokeErrorText(error: unknown): string | undefined {
  if (typeof error === 'string' && error.trim()) return error
  if (error instanceof Error && error.message.trim()) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return undefined
}

export function credentialStoreI18nKey(code: string | undefined): string | undefined {
  if (code === SECRET_SERVICE_UNAVAILABLE) return 'login.apiKeySecretServiceUnavailable'
  if (code === SECRET_SERVICE_FILE_FALLBACK) return 'login.apiKeySecretServiceFallback'
  return undefined
}
