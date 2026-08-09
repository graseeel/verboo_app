import { test } from 'node:test'
import assert from 'node:assert/strict'

test('an interrupted turn remains in bounded history so a later continue has context', async () => {
  const conversationState = await import('./conversationState.js').catch(() => ({}))
  assert.equal(typeof conversationState.recordInterruptedTurn, 'function')

  const history = conversationState.recordInterruptedTurn(
    [{ role: 'user', content: 'older' }, { role: 'assistant', content: 'older answer' }],
    { turnId: 'turn-1', userMessage: 'preencha todos os campos do formulário' },
    { reason: 'cancelled', completedSteps: 12 },
    4,
  )

  assert.deepEqual(history, [
    { role: 'user', content: 'preencha todos os campos do formulário' },
    {
      role: 'assistant',
      content: 'Execução interrompida pelo usuário após 12 etapas. O pedido ainda não foi concluído; retome a partir do estado atual da página quando o usuário pedir para continuar.',
    },
  ])
})
