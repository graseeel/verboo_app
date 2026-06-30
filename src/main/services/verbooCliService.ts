import { app, powerSaveBlocker } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { AgentEvent, AgentTurnRequest, AttachmentMeta, CliAuthStatus, LoginResult, UserSettings } from '../../shared/types'
import { accessModeConfig } from '../security/accessModes'
import { createImageBlock, type CliImageBlock } from './attachmentService'

type AgentEventHandler = (event: AgentEvent) => void

const require = createRequire(import.meta.url)
const STRUCTURED_INPUT_WRAPPER = `
const { spawn } = require('node:child_process');
const { createReadStream } = require('node:fs');
const [payloadPath, cliPath, ...cliArgs] = process.argv.slice(1);
const child = spawn(process.execPath, [cliPath, ...cliArgs], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['pipe', 'inherit', 'inherit'],
});
const input = createReadStream(payloadPath);
input.on('error', error => {
  console.error(error.message);
  child.kill('SIGTERM');
});
input.pipe(child.stdin);
child.stdin.on('error', error => {
  if (error && error.code !== 'EPIPE') console.error(error.message);
});
child.on('error', error => {
  console.error(error.message);
  process.exit(1);
});
child.on('close', code => {
  process.exit(code ?? 1);
});
`

export class VerbooCliService {
  private activeProcess: ChildProcessWithoutNullStreams | undefined
  private powerBlockerId: number | undefined

  async sendTurn(request: AgentTurnRequest, onEvent: AgentEventHandler, settings?: UserSettings): Promise<string> {
    const turnId = randomUUID()
    onEvent({ type: 'started', turnId })
    this.startPowerBlocker(settings)

    const cliPath = this.resolveCliPath()
    const prompt = buildPrompt(request)
    const inputBlocks = await buildStructuredInputBlocks(request, prompt)
    const usesStructuredInput = inputBlocks.length > 0
    const structuredPayload = usesStructuredInput
      ? `${JSON.stringify({
          type: 'user',
          session_id: '',
          message: {
            role: 'user',
            content: inputBlocks,
          },
          parent_tool_use_id: null,
        })}\n`
      : undefined
    const cliArgs = [
      '--print',
      ...(usesStructuredInput ? [] : [prompt]),
      ...(usesStructuredInput ? ['--input-format', 'stream-json'] : []),
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      ...(request.model ? ['--model', request.model] : []),
      ...accessModeConfig[request.accessMode].cliArgs,
    ]
    let childArgs = [cliPath, ...cliArgs]
    let payloadDir: string | undefined

    if (usesStructuredInput && structuredPayload) {
      const payloadFile = await createStructuredPayloadFile(structuredPayload)
      payloadDir = payloadFile.dir
      childArgs = ['-e', STRUCTURED_INPUT_WRAPPER, payloadFile.path, cliPath, ...cliArgs]
    }

    this.activeProcess = spawn(process.execPath, childArgs, {
      cwd: request.workingDirectory || app.getPath('home'),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ...(request.contextWindow ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(request.contextWindow) } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const child = this.activeProcess
    child.stdin.end()

    let emittedStreamText = false

    createInterface({ input: child.stdout }).on('line', line => {
      const cleanLine = cleanTerminalText(line)
      const parsed = parseJsonLine(cleanLine)
      if (parsed) {
        onEvent({ type: 'json', turnId, payload: parsed })
        const text = extractText(parsed, emittedStreamText)
        if (isStreamTextPayload(parsed)) emittedStreamText = true
        if (text) onEvent({ type: 'stdout', turnId, text })
      } else if (cleanLine.trim()) {
        onEvent({ type: 'stdout', turnId, text: `${cleanLine}\n` })
      }
    })

    createInterface({ input: child.stderr }).on('line', line => {
      const cleanLine = cleanTerminalText(line)
      if (cleanLine.trim()) onEvent({ type: 'stderr', turnId, text: `${cleanLine}\n` })
    })

    child.on('error', error => {
      this.stopPowerBlocker()
      void cleanupPayloadDir(payloadDir)
      onEvent({ type: 'error', turnId, message: error.message })
    })

    child.on('close', exitCode => {
      if (this.activeProcess === child) this.activeProcess = undefined
      this.stopPowerBlocker()
      void cleanupPayloadDir(payloadDir)
      onEvent({ type: 'done', turnId, exitCode })
    })

    return turnId
  }

  startCliLogin(): Promise<LoginResult> {
    return this.getAuthStatus().then(async currentStatus => {
      if (currentStatus.loggedIn) {
        return {
          ok: true,
          message: currentStatus.email ? `CLI autenticado como ${currentStatus.email}.` : 'CLI ja esta autenticado.',
          status: currentStatus,
        }
      }

      const result = await this.runCli(['auth', 'login'], 180_000)
      const nextStatus = await this.getAuthStatus()
      const message = result.output || result.error || (nextStatus.loggedIn ? 'Login concluido.' : 'Login nao concluido.')
      return {
        ok: nextStatus.loggedIn || result.exitCode === 0,
        message,
        status: nextStatus,
      }
    })
  }

  async logout(): Promise<LoginResult> {
    const result = await this.runCli(['auth', 'logout'], 30_000)
    const nextStatus = await this.getAuthStatus()
    return {
      ok: !nextStatus.loggedIn,
      message: result.output || result.error || (!nextStatus.loggedIn ? 'Sessao Verboo encerrada.' : 'Nao foi possivel encerrar a sessao Verboo.'),
      status: nextStatus,
    }
  }

  async getAuthStatus(): Promise<CliAuthStatus> {
    const result = await this.runCli(['auth', 'status', '--json'], 12_000)
    const parsed = parseJsonLine(result.output)
    if (isRecord(parsed) && typeof parsed.loggedIn === 'boolean') {
      return {
        loggedIn: parsed.loggedIn,
        authMethod: asString(parsed.authMethod),
        apiProvider: asString(parsed.apiProvider),
        email: asString(parsed.email),
        orgId: asString(parsed.orgId),
        orgName: asNullableString(parsed.orgName),
        subscriptionType: asNullableString(parsed.subscriptionType),
      }
    }
    return {
      loggedIn: false,
      error: result.error || result.output || 'Nao foi possivel ler o status do CLI Verboo.',
    }
  }

  interrupt(): void {
    this.activeProcess?.kill('SIGINT')
  }

  private startPowerBlocker(settings?: UserSettings): void {
    if (!settings?.preventSleepWhileRunning || this.powerBlockerId !== undefined) return
    this.powerBlockerId = powerSaveBlocker.start('prevent-app-suspension')
  }

  private stopPowerBlocker(): void {
    if (this.powerBlockerId === undefined) return
    if (powerSaveBlocker.isStarted(this.powerBlockerId)) {
      powerSaveBlocker.stop(this.powerBlockerId)
    }
    this.powerBlockerId = undefined
  }

  private resolveCliPath(): string {
    const packagePath = require.resolve('@verboo/code/package.json')
    return join(dirname(packagePath), 'dist', 'cli.mjs')
  }

  private runCli(args: string[], timeoutMs: number): Promise<{ exitCode: number | null; output: string; error: string }> {
    const cliPath = this.resolveCliPath()
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: app.getPath('home'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    return new Promise(resolve => {
      const output: string[] = []
      const errors: string[] = []
      let settled = false
      const finish = (value: { exitCode: number | null; output: string; error: string }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        finish({
          exitCode: null,
          output: output.join('\n'),
          error: errors.join('\n') || 'Tempo limite atingido ao executar o CLI Verboo.',
        })
      }, timeoutMs)

      createInterface({ input: child.stdout }).on('line', line => {
        output.push(line)
      })
      createInterface({ input: child.stderr }).on('line', line => {
        errors.push(line)
      })
      child.on('error', error => {
        finish({ exitCode: null, output: output.join('\n'), error: error.message })
      })
      child.on('close', exitCode => {
        finish({
          exitCode,
          output: output.join('\n'),
          error: errors.join('\n'),
        })
      })
    })
  }
}

async function createStructuredPayloadFile(payload: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'verboo-code-input-'))
  const path = join(dir, 'payload.jsonl')
  await writeFile(path, payload, 'utf8')
  return { dir, path }
}

async function cleanupPayloadDir(dir?: string): Promise<void> {
  if (!dir) return
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
}

function buildPrompt(request: AgentTurnRequest): string {
  const contextInstruction = request.contextWindow
    ? [`O app configurou a janela efetiva de autocompactacao em ${request.contextWindow} tokens para este modelo. Priorize informacao relevante dentro desse orcamento.`]
    : []
  const personalization = [
    request.personality ? `Personalidade preferida: ${personalityLabel(request.personality)}.` : '',
    request.customInstructions?.trim()
      ? `Instrucoes personalizadas do usuario:\n${request.customInstructions.trim()}`
      : '',
    request.memoryContext?.trim()
      ? `Memoria local relevante deste app:\n${request.memoryContext.trim()}`
      : '',
  ].filter(Boolean)
  const attachmentLines = buildAttachmentLines(request.attachments)

  if (request.skills.length === 0) {
    return [...contextInstruction, ...personalization, ...attachmentLines, request.message].join('\n\n')
  }

  const skillLines = request.skills.map(skill => `- /${skill.name}: ${skill.description}`).join('\n')
  return [
    ...contextInstruction,
    ...personalization,
    'Use as skills selecionadas para esta tarefa:',
    skillLines,
    '',
    ...attachmentLines,
    request.message,
  ].join('\n')
}

async function buildStructuredInputBlocks(
  request: AgentTurnRequest,
  prompt: string,
): Promise<Array<{ type: 'text'; text: string } | CliImageBlock>> {
  if (request.modelSupportsVision !== true) return []

  const imageAttachments = request.attachments?.filter(attachment => attachment.kind === 'image') ?? []
  if (imageAttachments.length === 0) return []

  const blocks = await Promise.all(imageAttachments.map(attachment => createImageBlock(attachment)))
  const imageBlocks = blocks.filter((block): block is CliImageBlock => Boolean(block))
  if (imageBlocks.length === 0) return []

  return [
    { type: 'text', text: prompt },
    ...imageBlocks,
  ]
}

function buildAttachmentLines(attachments?: AttachmentMeta[]): string[] {
  if (!attachments?.length) return []
  return [
    'Anexos selecionados:',
    attachments.map(attachment => {
      const dimensions = attachment.width && attachment.height ? `, ${attachment.width}x${attachment.height}` : ''
      const type = attachment.mediaType ? `${attachment.mediaType}${dimensions}` : `${attachment.kind}${dimensions}`
      return `- ${attachment.name} (${type}): ${attachment.path}`
    }).join('\n'),
  ]
}

function parseJsonLine(line: string): unknown | undefined {
  try {
    return JSON.parse(cleanTerminalText(line))
  } catch {
    return undefined
  }
}

function extractText(payload: unknown, suppressAssistantSnapshot = false): string | undefined {
  if (!isRecord(payload)) return undefined
  if (payload.type === 'stream_event' && isRecord(payload.event)) {
    const delta = isRecord(payload.event.delta) ? payload.event.delta : undefined
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') return cleanTerminalText(delta.text)
    return undefined
  }
  if (typeof payload.content === 'string') return cleanTerminalText(payload.content)
  if (typeof payload.text === 'string') return cleanTerminalText(payload.text)
  if (payload.type === 'assistant' && isRecord(payload.message)) {
    if (suppressAssistantSnapshot) return undefined
    const content = payload.message.content
    if (Array.isArray(content)) {
      const text = content
        .map(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '')
        .filter(Boolean)
        .join('')
      return text ? cleanTerminalText(text) : undefined
    }
  }
  if (payload.type === 'assistant' || payload.type === 'result') return undefined
  return undefined
}

function isStreamTextPayload(payload: unknown): boolean {
  if (!isRecord(payload) || payload.type !== 'stream_event' || !isRecord(payload.event)) return false
  const delta = isRecord(payload.event.delta) ? payload.event.delta : undefined
  return delta?.type === 'text_delta' && typeof delta.text === 'string'
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
}

function cleanTerminalText(value: string): string {
  return stripAnsi(value)
    .replace(/\u001b/g, '')
    .replace(/\[\?2026[hl]/g, '')
}

function personalityLabel(value: NonNullable<AgentTurnRequest['personality']>): string {
  if (value === 'concise') return 'concisa e direta'
  if (value === 'explanatory') return 'explicativa, com contexto quando ajuda'
  return 'pragmatica, objetiva e orientada a execucao'
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === null) return null
  return asString(value)
}
