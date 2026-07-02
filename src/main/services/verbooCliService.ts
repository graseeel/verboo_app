import { app, powerSaveBlocker } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { type FileHandle, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { AgentEvent, AgentResultSnapshot, AgentTurnRequest, AttachmentMeta, CliAuthStatus, GoalEvaluationInput, GoalEvaluationResult, LoginResult, TokenUsage, UserSettings } from '../../shared/types'
import { accessModeConfig } from '../security/accessModes'
import { createImageBlock, type CliImageBlock } from './attachmentService'
import { getCliOAuthAccessToken, refreshCliOAuthAccessToken } from './cliCredentials'
import type { CredentialsStore } from './credentialsStore'
import { createNodeRuntimeEnv, resolveExternalNodePath, resolveNodeRuntimePath } from './nodeRuntime'

type AgentEventHandler = (event: AgentEvent) => void
type AuthTokenPipe = {
  dir: string
  handle: FileHandle
  fd: number
  envVar: 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'
}

const require = createRequire(import.meta.url)
const STRUCTURED_INPUT_WRAPPER = `
const { spawn } = require('node:child_process');
const { createReadStream } = require('node:fs');
const [payloadPath, nodePath, cliPath, ...cliArgs] = process.argv.slice(1);
const authTokenFd = Number(process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR);
const extraStdio = Number.isInteger(authTokenFd) && authTokenFd >= 3 ? [authTokenFd] : [];
const child = spawn(nodePath, [cliPath, ...cliArgs], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['pipe', 'inherit', 'inherit', ...extraStdio],
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

  constructor(private readonly credentials?: CredentialsStore) {}

  async sendTurn(request: AgentTurnRequest, onEvent: AgentEventHandler, settings?: UserSettings, resumeSessionId?: string): Promise<string> {
    const turnId = randomUUID()
    onEvent({ type: 'started', turnId })
    this.startPowerBlocker(settings)

    const nodePath = await resolveNodeRuntimePath()
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
      ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
      ...(request.model ? ['--model', request.model] : []),
      ...accessModeConfig[request.accessMode].cliArgs,
    ]
    let childArgs = [cliPath, ...cliArgs]
    let payloadDir: string | undefined

    if (usesStructuredInput && structuredPayload) {
      const payloadFile = await createStructuredPayloadFile(structuredPayload)
      payloadDir = payloadFile.dir
      childArgs = ['-e', STRUCTURED_INPUT_WRAPPER, payloadFile.path, nodePath, cliPath, ...cliArgs]
    }

    const authTokenPipe = await createAuthTokenPipe(this.credentials)
    const child = spawn(nodePath, childArgs, {
      cwd: request.workingDirectory || app.getPath('home'),
      env: createNodeRuntimeEnv({
        ...(authTokenPipe ? { [authTokenPipe.envVar]: String(authTokenPipe.fd) } : {}),
        ...(request.contextWindow ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(request.contextWindow) } : {}),
      }),
      stdio: authTokenPipe ? ['pipe', 'pipe', 'pipe', authTokenPipe.handle.fd] : ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams
    this.activeProcess = child
    child.stdin.end()

    let emittedStreamText = false
    let resultSnapshot: AgentResultSnapshot | undefined

    createInterface({ input: child.stdout }).on('line', line => {
      const cleanLine = cleanTerminalText(line)
      const parsed = parseJsonLine(cleanLine)
      if (parsed) {
        if (isResultPayload(parsed)) {
          resultSnapshot = toAgentResultSnapshot(turnId, parsed)
          onEvent({ type: 'result', turnId, result: resultSnapshot })
        }
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
      void cleanupAuthTokenPipe(authTokenPipe)
      onEvent({ type: 'error', turnId, message: error.message })
    })

    child.on('close', exitCode => {
      if (this.activeProcess === child) this.activeProcess = undefined
      this.stopPowerBlocker()
      void cleanupPayloadDir(payloadDir)
      void cleanupAuthTokenPipe(authTokenPipe)
      if (resultSnapshot) {
        onEvent({
          type: 'result',
          turnId,
          result: { ...resultSnapshot, exitCode },
        })
      }
      onEvent({ type: 'done', turnId, exitCode })
    })

    return turnId
  }

  startCliLogin(): Promise<LoginResult> {
    return Promise.resolve().then(async () => {
      const result = await this.runCli(['auth', 'login'], 180_000)
      const nextStatus = await this.getAuthStatus()
      const message = result.output || result.error || (nextStatus.loggedIn ? 'Login concluído.' : 'Login não concluído.')
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
      message: result.output || result.error || (!nextStatus.loggedIn ? 'Sessão Verboo encerrada.' : 'Não foi possível encerrar a sessão Verboo.'),
      status: nextStatus,
    }
  }

  async getAuthStatus(): Promise<CliAuthStatus> {
    const result = await this.runCli(['auth', 'status', '--json'], 12_000)
    const parsed = parseAuthStatusPayload(result.output)
    if (parsed) {
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
      error: result.error || result.output || 'Não foi possível ler o status do CLI Verboo.',
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
    const packageJson = require(packagePath) as { bin?: string | Record<string, string> }
    const binPath = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.verboo
    return resolveExternalNodePath(join(dirname(packagePath), binPath ?? 'dist/cli.mjs'))
  }

  private async runCli(args: string[], timeoutMs: number): Promise<{ exitCode: number | null; output: string; error: string }> {
    const nodePath = await resolveNodeRuntimePath()
    const cliPath = this.resolveCliPath()
    const child = spawn(nodePath, [cliPath, ...args], {
      cwd: app.getPath('home'),
      env: createNodeRuntimeEnv(),
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

async function createAuthTokenPipe(credentials?: CredentialsStore): Promise<AuthTokenPipe | undefined> {
  const token = await refreshCliOAuthAccessToken() ?? await getCliOAuthAccessToken() ?? await credentials?.getApiKey()
  if (!token) return undefined

  const dir = await mkdtemp(join(tmpdir(), 'verboo-code-auth-'))
  const path = join(dir, 'token')
  await writeFile(path, token, { encoding: 'utf8', mode: 0o600 })
  const handle = await open(path, 'r')
  return { dir, handle, fd: 3, envVar: 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR' }
}

async function cleanupAuthTokenPipe(pipe?: AuthTokenPipe): Promise<void> {
  if (!pipe) return
  await pipe.handle.close().catch(() => undefined)
  await rm(pipe.dir, { recursive: true, force: true }).catch(() => undefined)
}

function buildPrompt(request: AgentTurnRequest): string {
  const appInstructions = [
    'Responda no mesmo idioma do usuário; se o usuário escrever em português, use português do Brasil.',
    'Estruture respostas longas com parágrafos curtos, listas e resumos finais quando isso ajudar a leitura.',
    'Antes de usar ferramentas em uma tarefa nova, escreva uma frase curta em prosa normal dizendo o que você vai fazer.',
    'Não exponha raciocínio interno, texto de pensamento, pesquisa bruta ou logs de ferramentas como se fossem resposta final.',
    'Não narre leituras, buscas, comandos ou edições apenas para registrar atividade; a interface já mostra essas ações em um painel estruturado.',
    'Durante a execução, escreva apenas atualizações úteis ao usuário; não cole sequências de tool calls, nomes internos de ferramentas ou progresso bruto no texto principal.',
    'Quando precisar de permissão, faça uma solicitação objetiva e separada, explicando exatamente a ação e o motivo.',
    'Ao finalizar uma tarefa, entregue um resumo curto no estilo Codex: o que foi feito, referências verificadas quando houver, validação feita quando houver e qualquer ressalva relevante.',
    'Não despeje listas completas de arquivos, comandos ou passos executados no texto principal; esses detalhes devem ficar no painel expansível da interface quando existirem.',
  ]
  const contextInstruction = request.contextWindow
    ? [`O app configurou a janela efetiva de autocompactação em ${request.contextWindow} tokens para este modelo. Priorize informação relevante dentro desse orçamento.`]
    : []
  const personalization = [
    request.personality ? `Personalidade preferida: ${personalityLabel(request.personality)}.` : '',
    request.customInstructions?.trim()
      ? `Instruções personalizadas do usuário:\n${request.customInstructions.trim()}`
      : '',
    request.memoryContext?.trim()
      ? `Memória local relevante deste app:\n${request.memoryContext.trim()}`
      : '',
  ].filter(Boolean)
  const attachmentLines = buildAttachmentLines(request.attachments)

  if (request.skills.length === 0) {
    return [...appInstructions, ...contextInstruction, ...personalization, ...attachmentLines, request.message].join('\n\n')
  }

  const skillLines = request.skills.map(skill => `- /${skill.name}: ${skill.description}`).join('\n')
  return [
    ...contextInstruction,
    ...appInstructions,
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

// `verboo auth status --json` prints its object pretty-printed across several
// lines, and may also emit extra lines (update notices, warnings) around it. A
// whole-output JSON.parse broke whenever any noise was present, making the app
// read a logged-in user as logged out. Try, in order: the span from the first
// `{` to the last `}` (handles noise wrapped around a multi-line object), the
// whole output, then each individual line. First object with a boolean
// `loggedIn` wins, so surrounding noise is ignored.
function parseAuthStatusPayload(output: string): (Record<string, unknown> & { loggedIn: boolean }) | undefined {
  const firstBrace = output.indexOf('{')
  const lastBrace = output.lastIndexOf('}')
  const candidates = [
    firstBrace !== -1 && lastBrace > firstBrace ? output.slice(firstBrace, lastBrace + 1) : '',
    output,
    ...output.split(/\r?\n/),
  ]
  for (const candidate of candidates) {
    if (!candidate.trim()) continue
    const parsed = parseJsonLine(candidate)
    if (isRecord(parsed) && typeof parsed.loggedIn === 'boolean') {
      return parsed as Record<string, unknown> & { loggedIn: boolean }
    }
  }
  return undefined
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
  if (payload.type === 'result' && !suppressAssistantSnapshot && typeof payload.result === 'string') {
    return cleanTerminalText(payload.result)
  }
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
  return 'pragmática, objetiva e orientada a execução'
}

function isResultPayload(payload: unknown): payload is Record<string, unknown> {
  return isRecord(payload) && payload.type === 'result'
}

function toAgentResultSnapshot(turnId: string, payload: Record<string, unknown>): AgentResultSnapshot {
  return {
    turnId,
    exitCode: null,
    sessionId: asOptionalString(payload.session_id),
    stopReason: asOptionalString(payload.stop_reason),
    isError: typeof payload.is_error === 'boolean' ? payload.is_error : undefined,
    usage: isRecord(payload.usage) ? payload.usage as TokenUsage : undefined,
    permissionDenials: Array.isArray(payload.permission_denials) ? payload.permission_denials : undefined,
    errors: Array.isArray(payload.errors) ? payload.errors.filter((item): item is string => typeof item === 'string') : undefined,
    rawResult: payload,
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
function asNullableString(value: unknown): string | null | undefined {
  if (value === null) return null
  return asString(value)
}
