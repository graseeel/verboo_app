export const TOOL_OUTPUT_MAX = 2_000
export const TOOL_OUTPUT_MAX_ERROR = 3_200

export function stripTerminalControl(value: string): string {
  return value
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\u001b/g, '')
}

export function truncateToolOutput(output: string, isError: boolean): string {
  const trimmed = stripTerminalControl(output).trim()
  const max = isError ? TOOL_OUTPUT_MAX_ERROR : TOOL_OUTPUT_MAX
  if (trimmed.length <= max) return trimmed
  const head = trimmed.slice(0, max)
  const omitted = trimmed.length - max
  return `${head}\n\n[… ${omitted} more characters truncated]`
}
