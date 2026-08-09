/**
 * Preserve a cancelled turn as model context without presenting it as a
 * completed assistant answer to the user.
 */
export function recordInterruptedTurn(_history, pending, interruption, limit = 12) {
  if (!pending?.userMessage) return []
  const completedSteps = Math.max(0, Number(interruption?.completedSteps) || 0)
  const content = completedSteps > 0
    ? `Execução interrompida pelo usuário após ${completedSteps} etapas. O pedido ainda não foi concluído; retome a partir do estado atual da página quando o usuário pedir para continuar.`
    : 'Execução interrompida pelo usuário. O pedido ainda não foi concluído; retome a partir do estado atual da página quando o usuário pedir para continuar.'
  return [
    { role: 'user', content: String(pending.userMessage) },
    { role: 'assistant', content },
  ].slice(-limit)
}
