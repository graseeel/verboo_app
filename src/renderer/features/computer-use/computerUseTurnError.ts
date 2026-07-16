export function computerUseTurnStartMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : ''
  return message.trim() || fallback
}
