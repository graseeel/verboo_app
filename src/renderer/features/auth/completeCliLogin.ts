/** Short retries after CLI OAuth Complete so a durable secret-tool/file write can land. */

export const CLI_LOGIN_UNLOCK_RETRY_DELAYS_MS = [500, 1500] as const

export async function retryValidateAccessUntilUnlocked(
  validate: () => Promise<boolean>,
  delaysMs: readonly number[] = CLI_LOGIN_UNLOCK_RETRY_DELAYS_MS,
): Promise<boolean> {
  if (await validate()) return true
  for (const delayMs of delaysMs) {
    await new Promise<void>(resolve => {
      setTimeout(resolve, delayMs)
    })
    if (await validate()) return true
  }
  return false
}
