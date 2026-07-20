import { describe, expect, it } from 'vitest'
import {
  detectTextQuestionPrompt,
  extractModelQuestionsFromPayload,
  mergeModelQuestions,
} from './questionDetection'

describe('question detection', () => {
  it('extracts structured AskUserQuestion payloads with their options', () => {
    const questions = extractModelQuestionsFromPayload({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          name: 'AskUserQuestion',
          input: {
            questions: [{
              header: 'Estilo visual',
              question: 'Qual estilo você prefere?',
              multiSelect: false,
              options: [
                { label: 'Artesanal', description: 'Creme e marrom.' },
                { label: 'Premium', description: 'Escuro e dourado.' },
              ],
            }],
          },
        }],
      },
    })

    expect(questions).toEqual([{
      header: 'Estilo visual',
      question: 'Qual estilo você prefere?',
      multiSelect: false,
      options: [
        { label: 'Artesanal', description: 'Creme e marrom.' },
        { label: 'Premium', description: 'Escuro e dourado.' },
      ],
    }])
  })

  it('recognizes a single high-confidence decision question with lettered options', () => {
    const detected = detectTextQuestionPrompt(`
**Pergunta 2 de N — Composição do Hero**

Há algumas alternativas com trade-offs diferentes.

Você quer:
- **(A)** 3 brigadeiros grandes, texto à esquerda (recomendado)
- **(B)** 5-6 brigadeiros médios, texto à esquerda
- **(C)** 1 brigadeiro gigante central

Qual sua escolha?
`)

    expect(detected).toEqual({
      autoOpen: true,
      questions: [{
        header: 'Composição do Hero',
        question: 'Qual sua escolha?',
        multiSelect: false,
        options: [
          { label: '3 brigadeiros grandes, texto à esquerda (recomendado)' },
          { label: '5-6 brigadeiros médios, texto à esquerda' },
          { label: '1 brigadeiro gigante central' },
        ],
      }],
    })
  })

  it('keeps the existing numbered-question fallback conservative', () => {
    const detected = detectTextQuestionPrompt(`
1. Qual público devemos priorizar?
2. Qual é o prazo esperado?
`)

    expect(detected?.autoOpen).toBe(false)
    expect(detected?.questions).toHaveLength(2)
  })

  it('does not turn an ordinary closing question into a modal', () => {
    expect(detectTextQuestionPrompt(
      'A validação terminou e não encontrei erros. Quer que eu verifique o servidor?',
    )).toBeUndefined()
  })

  it('deduplicates repeated structured snapshots without dropping new questions', () => {
    const first = {
      header: 'Escopo',
      question: 'Qual escopo?',
      multiSelect: false,
      options: [{ label: 'MVP' }],
    }
    const second = {
      header: 'Prazo',
      question: 'Qual prazo?',
      multiSelect: false,
      options: [{ label: 'Esta semana' }],
    }

    expect(mergeModelQuestions([first], [first, second])).toEqual([first, second])
  })
})
