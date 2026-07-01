import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  AgentTurnRequest,
  ResearchSubagentRequest,
  ResearchSubagentResult,
  ResearchSubagentsRunRequest,
  UserSettings,
} from '../../shared/types'
import type { CredentialsStore } from './credentialsStore'
import { VerbooCliService } from './verbooCliService'

const MAX_RESEARCH_SUBAGENTS = 2
const DISALLOWED_RESEARCH_TOOLS = new Set(['edit', 'write', 'multiedit', 'multi_edit', 'notebookedit'])

export class ResearchSubagentService {
  constructor(private readonly credentials?: CredentialsStore) {}

  async runMany(payload: ResearchSubagentsRunRequest, settings?: UserSettings): Promise<ResearchSubagentResult[]> {
    const count = clamp(Math.round(payload.count || 1), 1, MAX_RESEARCH_SUBAGENTS)
    const requests = Array.from({ length: count }, (_, index): ResearchSubagentRequest => ({
      id: randomUUID(),
      index: index + 1,
      total: count,
      topic: researchTopicFor(index + 1, count, payload.baseRequest.message),
      baseRequest: payload.baseRequest,
    }))

    return Promise.all(requests.map(request => this.runOne(request, settings)))
  }

  private async runOne(request: ResearchSubagentRequest, settings?: UserSettings): Promise<ResearchSubagentResult> {
    const childCli = new VerbooCliService(this.credentials)
    const output: string[] = []
    const sources = new Set<string>()
    let violation: string | undefined

    const childRequest: AgentTurnRequest = {
      ...request.baseRequest,
      message: buildResearchPrompt(request),
      accessMode: researchAccessMode(request.baseRequest.accessMode),
      attachments: [],
    }

    return new Promise(resolve => {
      let settled = false
      const finish = (result: ResearchSubagentResult) => {
        if (settled) return
        settled = true
        resolve(result)
      }

      childCli.sendTurn(childRequest, event => {
        if (event.type === 'stdout') {
          output.push(event.text)
          return
        }

        if (event.type === 'json') {
          const source = sourceFromToolPayload(event.payload)
          if (source) sources.add(source)

          const nextViolation = detectReadOnlyViolation(event.payload)
          if (nextViolation && !violation) {
            violation = nextViolation
            childCli.interrupt()
          }
          return
        }

        if (event.type === 'error') {
          finish(failedResult(request, event.message, sources))
          return
        }

        if (event.type === 'done') {
          if (violation) {
            finish(failedResult(request, violation, sources))
            return
          }

          const text = cleanupOutput(output.join(''))
          if (event.exitCode !== 0) {
            finish(failedResult(request, text || `Processo terminou com codigo ${event.exitCode ?? 'desconhecido'}.`, sources))
            return
          }

          finish({
            id: request.id,
            index: request.index,
            status: 'complete',
            summary: summarizeOutput(text),
            findings: extractFindings(text),
            sources: Array.from(sources).slice(0, 8),
          })
        }
      }, settings).catch(error => {
        finish(failedResult(request, error instanceof Error ? error.message : String(error), sources))
      })
    })
  }
}

function buildResearchPrompt(request: ResearchSubagentRequest): string {
  return [
    'Voce e um subagente de pesquisa do Verboo Code.',
    'Sua funcao e somente investigar e resumir informacoes para o agente principal.',
    '',
    'Regras obrigatorias:',
    '- Nao edite arquivos.',
    '- Nao crie arquivos.',
    '- Nao apague arquivos.',
    '- Nao rode comandos que alterem o filesystem.',
    '- Use somente leitura, busca, listagem, pesquisa e resumo.',
    '- Responda com achados objetivos, fontes e riscos.',
    '',
    `Subagente: ${request.index} de ${request.total}`,
    `Foco desta pesquisa: ${request.topic}`,
    '',
    'Mensagem original do usuario:',
    request.baseRequest.message,
  ].join('\n')
}

function researchTopicFor(index: number, total: number, message: string): string {
  if (total === 1) return `Pesquisar o pedido completo do usuario: ${snippet(message, 240)}`
  if (index === 1) return 'Pesquisar o codigo local, arquivos relevantes, contratos e riscos de implementacao.'
  return 'Pesquisar contexto complementar, documentacao, comportamento esperado e pontos de validacao.'
}

function researchAccessMode(accessMode: AgentTurnRequest['accessMode']): AgentTurnRequest['accessMode'] {
  return accessMode === 'approval' ? 'approval' : 'auto'
}

function detectReadOnlyViolation(payload: unknown): string | undefined {
  const block = extractToolBlock(payload)
  if (!block) return undefined

  const toolName = textValue(block.name) || textValue(block.tool_name)
  const normalizedTool = toolName.toLowerCase()
  if (DISALLOWED_RESEARCH_TOOLS.has(normalizedTool)) {
    return `Subagente tentou usar ferramenta de escrita: ${toolName}.`
  }

  if (normalizedTool !== 'bash' && normalizedTool !== 'shell' && normalizedTool !== 'exec_command') {
    return undefined
  }

  const input = toolInput(block)
  const command = textValue(input?.command) || textValue(input?.cmd)
  if (!command || isReadOnlyShellCommand(command)) return undefined
  return `Subagente tentou executar comando fora da lista read-only: ${command}.`
}

function isReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  if (/[>|;&]/.test(trimmed)) return false
  if (/\b(rm|mv|cp|mkdir|touch|chmod|chown|npm|pnpm|yarn|bun|node|python|python3|pip|uv|make|cargo|go|swift|xcodebuild|electron-builder)\b/i.test(trimmed)) {
    return false
  }
  if (/\bgit\s+(commit|push|checkout|reset|clean|merge|rebase|apply|am|pull|fetch)\b/i.test(trimmed)) return false

  const allowedPrefixes = [
    'ls',
    'pwd',
    'cat',
    'sed -n',
    'rg',
    'grep',
    'find',
    'git status',
    'git diff',
    'git grep',
    'git show',
    'wc',
    'head',
    'tail',
  ]
  return allowedPrefixes.some(prefix => trimmed === prefix || trimmed.startsWith(`${prefix} `))
}

function sourceFromToolPayload(payload: unknown): string | undefined {
  const block = extractToolBlock(payload)
  if (!block) return undefined
  const toolName = textValue(block.name) || textValue(block.tool_name)
  const input = toolInput(block)
  if (!toolName || !input) return undefined

  const normalized = toolName.toLowerCase()
  if (normalized === 'bash' || normalized === 'shell' || normalized === 'exec_command') {
    return snippet(textValue(input.command) || textValue(input.cmd))
  }
  if (normalized === 'webfetch') return snippet(textValue(input.url))
  if (normalized === 'websearch') return snippet(textValue(input.query))
  return snippet(textValue(input.file_path) || textValue(input.filePath) || textValue(input.path) || textValue(input.pattern))
}

function failedResult(request: ResearchSubagentRequest, reason: string, sources: Set<string>): ResearchSubagentResult {
  return {
    id: request.id,
    index: request.index,
    status: 'failed',
    summary: snippet(cleanupOutput(reason), 360) || 'Subagente falhou sem mensagem detalhada.',
    findings: [],
    sources: Array.from(sources).slice(0, 8),
  }
}

function summarizeOutput(text: string): string {
  if (!text) return 'Pesquisa concluida sem resumo textual.'
  const paragraphs = text
    .split(/\n{2,}/)
    .map(line => line.trim())
    .filter(Boolean)
  return snippet(paragraphs[0] ?? text, 420)
}

function extractFindings(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim().replace(/^[-*]\s*/, ''))
    .filter(line => line.length > 0)
    .filter(line => !/^```/.test(line))

  const preferred = lines.filter(line =>
    /arquivo|file|risco|risk|encontr|found|precisa|should|deve|source|fonte|valid/i.test(line),
  )
  return (preferred.length ? preferred : lines).slice(0, 8).map(line => snippet(line, 280))
}

function cleanupOutput(text: string): string {
  return text
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\u001b/g, '')
    .replace(/\[\?2026[hl]/g, '')
    .trim()
}

function extractToolBlock(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined
  if (hasToolShape(payload)) return payload

  const event = isRecord(payload.event) ? payload.event : undefined
  const contentBlock = isRecord(event?.content_block) ? event.content_block : undefined
  if (hasToolShape(contentBlock)) return contentBlock

  const message = isRecord(payload.message) ? payload.message : undefined
  const content = Array.isArray(message?.content) ? message.content : undefined
  return content?.find((block): block is Record<string, unknown> => isRecord(block) && hasToolShape(block))
}

function hasToolShape(value: unknown): boolean {
  if (!isRecord(value)) return false
  const type = textValue(value.type).toLowerCase()
  return type.includes('tool_use') || Boolean(textValue(value.name) || textValue(value.tool_name))
}

function toolInput(block: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(block.input)) return block.input
  if (isRecord(block.arguments)) return block.arguments
  const inputJson = textValue(block.input_json) || textValue(block.arguments_json)
  if (!inputJson) return undefined
  try {
    const parsed = JSON.parse(inputJson) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function snippet(value: string, maxLength = 180): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}...` : compact
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
