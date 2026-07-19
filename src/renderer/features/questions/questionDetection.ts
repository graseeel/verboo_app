import type { ModelQuestion } from './QuestionWizard'

export type DetectedQuestionPrompt = {
  questions: ModelQuestion[]
  autoOpen: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function questionFromUnknown(value: unknown): ModelQuestion | undefined {
  if (!isRecord(value) || typeof value.question !== 'string' || !value.question.trim()) return undefined
  const options = Array.isArray(value.options)
    ? value.options.flatMap(option => {
        if (!isRecord(option) || typeof option.label !== 'string' || !option.label.trim()) return []
        return [{
          label: option.label.trim(),
          description: typeof option.description === 'string' && option.description.trim()
            ? option.description.trim()
            : undefined,
        }]
      })
    : []

  return {
    header: typeof value.header === 'string' && value.header.trim() ? value.header.trim() : undefined,
    question: value.question.trim(),
    multiSelect: value.multiSelect === true,
    options,
  }
}

function toolUseBlocks(payload: unknown): Record<string, unknown>[] {
  if (!isRecord(payload)) return []
  const blocks: unknown[] = []
  if (Array.isArray(payload.content)) blocks.push(...payload.content)
  if (isRecord(payload.message) && Array.isArray(payload.message.content)) {
    blocks.push(...payload.message.content)
  }
  if (isRecord(payload.event) && isRecord(payload.event.content_block)) {
    blocks.push(payload.event.content_block)
  }
  return blocks.filter(isRecord)
}

export function extractModelQuestionsFromPayload(payload: unknown): ModelQuestion[] {
  const questions: ModelQuestion[] = []
  for (const block of toolUseBlocks(payload)) {
    const name = typeof block.name === 'string' ? block.name.toLowerCase() : ''
    if (block.type !== 'tool_use' || name !== 'askuserquestion' || !isRecord(block.input)) continue
    const rawQuestions = Array.isArray(block.input.questions) ? block.input.questions : []
    for (const rawQuestion of rawQuestions) {
      const question = questionFromUnknown(rawQuestion)
      if (question) questions.push(question)
    }
  }
  return questions
}

function questionKey(question: ModelQuestion): string {
  return JSON.stringify({
    header: question.header ?? '',
    question: question.question,
    multiSelect: question.multiSelect === true,
    options: question.options.map(option => [option.label, option.description ?? '']),
  })
}

export function mergeModelQuestions(
  existing: ModelQuestion[],
  incoming: ModelQuestion[],
): ModelQuestion[] {
  const merged = existing.slice()
  const seen = new Set(existing.map(questionKey))
  for (const question of incoming) {
    const key = questionKey(question)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(question)
  }
  return merged
}

function plainLine(line: string): string {
  return line.replace(/^\s*#+\s*/, '').replace(/\*\*/g, '').trim()
}

function decisionHeader(lines: string[]): string | undefined {
  for (const line of lines) {
    const match = plainLine(line).match(/^(?:pergunta|question)\s+\d+(?:\s+(?:de|of)\s+\S+)?\s*[—–-]\s*(.+)$/i)
    if (match?.[1]?.trim()) return match[1].trim()
  }
  return undefined
}

function detectDecisionQuestion(lines: string[]): DetectedQuestionPrompt | undefined {
  const options: ModelQuestion['options'] = []
  let lastOptionLine = -1
  for (const [index, line] of lines.entries()) {
    const match = line.replace(/\*\*/g, '').match(/^\s*[-*]\s*\([a-z0-9]+\)\s+(.+?)\s*$/i)
    if (!match?.[1]?.trim()) continue
    options.push({ label: match[1].trim() })
    lastOptionLine = index
  }
  if (options.length < 2) return undefined

  const question = lines
    .map((line, index) => ({ index, text: plainLine(line) }))
    .filter(candidate => candidate.index > lastOptionLine && candidate.text.endsWith('?'))
    .at(-1)
  if (!question) return undefined

  return {
    autoOpen: true,
    questions: [{
      header: decisionHeader(lines),
      question: question.text,
      multiSelect: false,
      options,
    }],
  }
}

function detectNumberedQuestions(lines: string[]): DetectedQuestionPrompt | undefined {
  const questions: ModelQuestion[] = []
  for (const line of lines) {
    const match = line.match(/^\s*\d+[.)]\s+(.{8,})$/)
    if (!match) continue
    const question = plainLine(match[1])
    if (!question.includes('?')) continue
    questions.push({ question, options: [], multiSelect: false })
  }
  return questions.length >= 2 ? { questions, autoOpen: false } : undefined
}

export function detectTextQuestionPrompt(text: string): DetectedQuestionPrompt | undefined {
  const lines = text.split('\n')
  return detectDecisionQuestion(lines) ?? detectNumberedQuestions(lines)
}
