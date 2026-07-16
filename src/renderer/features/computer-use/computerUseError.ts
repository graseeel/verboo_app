export function reportComputerUseError(
  context: string,
  error: unknown,
  controlledMessage: string,
): string {
  console.error(`[computer-use] ${context}`, error)
  return controlledMessage
}
