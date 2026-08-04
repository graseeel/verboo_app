import { describe, expect, it } from 'vitest'
import { promptForConversation } from './promptRouting'

describe('prompt routing', () => {
  it('keeps simultaneous main and side prompts in their own lanes', () => {
    const prompts = [
      { id: 'permission-main', conversationId: 'main', detail: 'Main approval' },
      { id: 'question-side', conversationId: 'sidechat:1', detail: 'Side question' },
    ]

    expect(promptForConversation(prompts, 'main')?.id).toBe('permission-main')
    expect(promptForConversation(prompts, 'sidechat:1')?.id).toBe('question-side')
    expect(promptForConversation(prompts, undefined)).toBeUndefined()
  })
})
