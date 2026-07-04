import { app } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, copyFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import sharp from 'sharp'
import { createWorker, PSM } from 'tesseract.js'
import type { AgentTurnRequest, AttachmentMeta, LanguageCode, VerbooModel } from '../../shared/types'
import { createImageBlock } from './attachmentService'
import type { ModelService } from './modelService'
import { createNodeRuntimeEnv, resolveNodeRuntimePath, resolvePackedJavaScriptEntryPath } from './nodeRuntime'

const require = createRequire(import.meta.url)
const MAX_OCR_CHARS = 12_000
const MAX_HELPER_CHARS = 12_000
const OCR_IMAGE_WIDTH = 2600
const VISION_HELPER_TIMEOUT_MS = 60_000
const DEFAULT_VISION_HELPER_MODELS: VisionCandidate[] = [
  { id: 'pro/qwen3.6-27b', displayName: 'Pro (qwen3.6-27b)' },
  { id: 'pro/deepseek-v4-flash', displayName: 'Pro (deepseek-v4-flash)' },
]
type TessdataPackage = {
  code: string
  langPath: string
}

type VisualDescription = {
  attachment: AttachmentMeta
  text: string
  confidence?: number
  mode: 'vision-helper' | 'ocr'
  sourceLabel: string
}

type VisionCandidate = {
  id: string
  displayName: string
}

type OcrWorker = Awaited<ReturnType<typeof createWorker>>

export class VisionFallbackService {
  constructor(private readonly modelService: ModelService) {}

  async prepareRequest(request: AgentTurnRequest): Promise<AgentTurnRequest> {
    const imageAttachments = request.attachments?.filter(attachment => attachment.kind === 'image') ?? []
    if (imageAttachments.length === 0) return request
    if (request.modelSupportsVision === true) return request

    const descriptions: VisualDescription[] = []
    const failures: string[] = []
    let worker: OcrWorker | undefined
    const failedVisionModels = new Set<string>()
    const visionCandidates = await this.resolveVisionCandidates(request.model)
    const language = request.responseLanguage ?? 'en-US'

    try {
      for (const attachment of imageAttachments) {
        try {
          descriptions.push(await describeImageWithVisionHelper(attachment, visionCandidates, request.workingDirectory, failedVisionModels, language))
          continue
        } catch (visionError) {
          const visionMessage = visionError instanceof Error ? visionError.message : String(visionError)
          try {
            worker ??= await createOcrWorker()
            descriptions.push(await describeImageWithOcr(worker, attachment))
          } catch (ocrError) {
            const ocrMessage = ocrError instanceof Error ? ocrError.message : String(ocrError)
            failures.push(language === 'pt-BR'
              ? `${attachment.name}: helper vision falhou (${visionMessage}); OCR falhou (${ocrMessage})`
              : `${attachment.name}: vision helper failed (${visionMessage}); OCR failed (${ocrMessage})`)
          }
        }
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    } finally {
      await worker?.terminate().catch(() => undefined)
    }

    return withVisualContext(request, descriptions, failures)
  }

  private async resolveVisionCandidates(selectedModel?: string): Promise<VisionCandidate[]> {
    const discovered = await this.modelService
      .listModels(false)
      .then(result => result.models.filter(model => model.supportsVision === true))
      .catch(() => [])
    const configuredModel = process.env.VERBOO_VISION_HELPER_MODEL?.trim()
    const candidates: VisionCandidate[] = []
    const seen = new Set<string>()

    const add = (candidate?: VisionCandidate, allowSelected = false) => {
      if (!candidate?.id || seen.has(candidate.id)) return
      if (!allowSelected && selectedModel && candidate.id === selectedModel) return
      seen.add(candidate.id)
      candidates.push(candidate)
    }

    discovered.forEach(model => add(toVisionCandidate(model)))
    if (configuredModel) add({ id: configuredModel, displayName: configuredModel })
    DEFAULT_VISION_HELPER_MODELS.forEach(candidate => add(candidate))
    DEFAULT_VISION_HELPER_MODELS.forEach(candidate => add(candidate, true))

    return candidates
  }
}

async function describeImageWithVisionHelper(
  attachment: AttachmentMeta,
  candidates: VisionCandidate[],
  workingDirectory: string,
  failedVisionModels: Set<string>,
  language: LanguageCode,
): Promise<VisualDescription> {
  if (candidates.length === 0) {
    throw new Error(language === 'pt-BR'
      ? 'Nenhum modelo vision auxiliar disponível para esta conta.'
      : 'No auxiliary vision model is available for this account.')
  }

  const errors: string[] = []

  for (const candidate of candidates) {
    if (failedVisionModels.has(candidate.id)) continue
    try {
      const text = await runVisionHelper(candidate, attachment, workingDirectory, language)
      return {
        attachment,
        text,
        mode: 'vision-helper',
        sourceLabel: candidate.displayName,
      }
    } catch (error) {
      failedVisionModels.add(candidate.id)
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${candidate.displayName}: ${message}`)
    }
  }

  throw new Error(errors.join('; ') || (language === 'pt-BR'
    ? 'Nenhum modelo vision auxiliar retornou descrição.'
    : 'No auxiliary vision model returned a description.'))
}

async function runVisionHelper(
  candidate: VisionCandidate,
  attachment: AttachmentMeta,
  workingDirectory: string,
  language: LanguageCode,
): Promise<string> {
  const imageBlock = await createImageBlock(attachment)
  if (!imageBlock) {
    throw new Error(language === 'pt-BR'
      ? 'Não foi possível preparar a imagem para o helper vision.'
      : 'Could not prepare the image for the vision helper.')
  }

  const cliPath = resolveCliPath()
  const nodePath = await resolveNodeRuntimePath()
  const payload = `${JSON.stringify({
    type: 'user',
    session_id: '',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: visionHelperPrompt(language) },
        imageBlock,
      ],
    },
    parent_tool_use_id: null,
  })}\n`

  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [
      cliPath,
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--max-turns',
      '1',
      '--model',
      candidate.id,
      '--tools',
      '',
      '--no-session-persistence',
    ], {
      cwd: workingDirectory || app.getPath('home'),
      env: createNodeRuntimeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const stdoutLines: string[] = []
    const stderrLines: string[] = []
    let resultText = ''
    let assistantText = ''
    let deltaText = ''
    let settled = false

    const finish = (error?: Error, text?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        reject(error)
      } else {
        resolve(text ?? '')
      }
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(new Error('Tempo limite atingido ao chamar o helper vision.'))
    }, VISION_HELPER_TIMEOUT_MS)

    createInterface({ input: child.stdout }).on('line', line => {
      const cleanLine = cleanTerminalText(line)
      stdoutLines.push(cleanLine)
      const parsed = parseJsonLine(cleanLine)
      if (!isRecord(parsed)) return
      const text = extractPayloadText(parsed)
      if (parsed.type === 'result' && text) resultText = text
      if (parsed.type === 'assistant' && text) assistantText = text
      if (parsed.type === 'stream_event' && text) deltaText += text
    })

    createInterface({ input: child.stderr }).on('line', line => {
      const cleanLine = cleanTerminalText(line)
      if (cleanLine.trim()) stderrLines.push(cleanLine)
    })

    child.stdin.on('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'EPIPE') return
      stderrLines.push(error.message)
    })
    child.stdin.end(payload)

    child.on('error', error => {
      finish(error)
    })

    child.on('close', exitCode => {
      if (settled) return
      const output = normalizeHelperText(resultText || assistantText || deltaText)
      if (exitCode === 0 && output) {
        finish(undefined, output)
        return
      }
      const stderr = stderrLines.join('\n').trim()
      const stdout = stdoutLines.join('\n').trim()
      const detail = stderr || summarizeHelperOutput(stdout) || 'sem saida util'
      finish(new Error(`Helper vision terminou sem descrição (código ${exitCode ?? 'desconhecido'}): ${detail}`))
    })
  })
}

async function createOcrWorker(): Promise<OcrWorker> {
  const tessdataDir = await prepareTessdataDir()
  const worker = await createWorker(['eng', 'por'], 1, {
    langPath: tessdataDir,
    cacheMethod: 'none',
    gzip: true,
  })
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    preserve_interword_spaces: '1',
    user_defined_dpi: '180',
  })
  return worker
}

async function prepareTessdataDir(): Promise<string> {
  const engData = require('@tesseract.js-data/eng') as TessdataPackage
  const porData = require('@tesseract.js-data/por') as TessdataPackage
  const dir = join(app.getPath('userData'), 'tessdata')
  await mkdir(dir, { recursive: true })

  await copyIfMissing(join(engData.langPath, 'eng.traineddata.gz'), join(dir, 'eng.traineddata.gz'))
  await copyIfMissing(join(porData.langPath, 'por.traineddata.gz'), join(dir, 'por.traineddata.gz'))

  return dir
}

async function copyIfMissing(source: string, destination: string): Promise<void> {
  try {
    await access(destination)
  } catch {
    await copyFile(source, destination)
  }
}

async function describeImageWithOcr(worker: OcrWorker, attachment: AttachmentMeta): Promise<VisualDescription> {
  const image = await sharp(attachment.path)
    .rotate()
    .resize({ width: OCR_IMAGE_WIDTH, withoutEnlargement: true })
    .grayscale()
    .normalize()
    .sharpen()
    .png()
    .toBuffer()

  const result = await worker.recognize(image)
  const text = normalizeOcrText(result.data.text)
  const confidence = typeof result.data.confidence === 'number' ? Math.round(result.data.confidence) : undefined

  if (!text) {
    throw new Error('Não foi possível extrair texto da imagem com OCR local.')
  }

  return {
    attachment,
    text,
    confidence,
    mode: 'ocr',
    sourceLabel: 'OCR local',
  }
}

function withVisualContext(
  request: AgentTurnRequest,
  descriptions: VisualDescription[],
  failures: string[],
): AgentTurnRequest {
  const language = request.responseLanguage ?? 'en-US'
  const lines = visualContextHeader(language)

  descriptions.forEach((description, index) => {
    const { attachment } = description
    const dimensions = attachment.width && attachment.height
      ? `${attachment.width}x${attachment.height}`
      : language === 'pt-BR' ? 'dimensões desconhecidas' : 'unknown dimensions'
    const sourceLine = description.mode === 'vision-helper'
      ? language === 'pt-BR'
        ? `Leitura visual: modelo auxiliar ${description.sourceLabel}.`
        : `Visual reading: auxiliary model ${description.sourceLabel}.`
      : description.confidence === undefined
        ? language === 'pt-BR' ? 'Leitura visual: OCR local.' : 'Visual reading: local OCR.'
        : language === 'pt-BR'
          ? `Leitura visual: OCR local com confiança aproximada ${description.confidence}%.`
          : `Visual reading: local OCR with approximate confidence ${description.confidence}%.`
    lines.push(
      '',
      language === 'pt-BR' ? `[Imagem ${index + 1}: ${attachment.name}]` : `[Image ${index + 1}: ${attachment.name}]`,
      language === 'pt-BR' ? `Arquivo: ${attachment.path}` : `File: ${attachment.path}`,
      language === 'pt-BR'
        ? `Tipo: ${attachment.mediaType ?? attachment.kind}; dimensões: ${dimensions}`
        : `Type: ${attachment.mediaType ?? attachment.kind}; dimensions: ${dimensions}`,
      sourceLine,
      description.text,
    )
  })

  if (failures.length > 0) {
    lines.push(
      '',
      language === 'pt-BR' ? 'Limites da leitura visual:' : 'Visual reading limits:',
      failures.join('\n'),
    )
  }

  const imagePaths = new Set((request.attachments ?? [])
    .filter(attachment => attachment.kind === 'image')
    .map(attachment => attachment.path))

  return {
    ...request,
    message: `${lines.join('\n')}\n\n${language === 'pt-BR' ? 'Pedido original do usuário:' : 'Original user request:'}\n${request.message}`,
    attachments: request.attachments?.filter(attachment => !imagePaths.has(attachment.path)),
  }
}

function visionHelperPrompt(language: LanguageCode): string {
  if (language === 'pt-BR') {
    return [
      'Você é um leitor visual auxiliar do Verboo Code.',
      'Descreva a imagem para outro modelo responder ao usuário.',
      'Responda em português do Brasil, de forma objetiva, cobrindo:',
      '- tipo de imagem: print, interface, documento, foto, gráfico ou outro;',
      '- texto visível importante;',
      '- layout, elementos principais, cores e estado da interface quando houver;',
      '- qualquer incerteza relevante.',
      'Não use ferramentas de arquivo. Não mencione que você é um modelo auxiliar.',
    ].join('\n')
  }

  return [
    'You are an auxiliary visual reader for Verboo Code.',
    'Describe the image so another model can answer the user.',
    'Respond in English, objectively covering:',
    '- image type: screenshot, interface, document, photo, chart, or other;',
    '- important visible text;',
    '- layout, main elements, colors, and interface state when relevant;',
    '- any relevant uncertainty.',
    'Do not use file tools. Do not mention that you are an auxiliary model.',
  ].join('\n')
}

function visualContextHeader(language: LanguageCode): string[] {
  if (language === 'pt-BR') {
    return [
      'Contexto visual dos anexos:',
      'O app analisou os anexos com um modelo vision auxiliar quando disponível. Se o helper falhou, usou OCR local como fallback.',
      'Use este contexto visual como apoio. Se o usuário pedir algo visual, responda com base nele.',
      'Não diga que houve falha de permissão ou falta de vision apenas porque a leitura visual foi convertida em texto. Cite incertezas somente quando a leitura estiver incompleta.',
    ]
  }

  return [
    'Visual context from attachments:',
    'The app analyzed attachments with an auxiliary vision model when available. If the helper failed, it used local OCR as fallback.',
    'Use this visual context as support. If the user asks about something visual, answer based on it.',
    'Do not say there was a permission or vision capability failure only because the visual reading was converted to text. Mention uncertainty only when the reading is incomplete.',
  ]
}

function normalizeOcrText(value: string): string {
  const text = value
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')

  return text.length > MAX_OCR_CHARS ? `${text.slice(0, MAX_OCR_CHARS)}\n[OCR truncado]` : text
}

function normalizeHelperText(value: string): string {
  const text = cleanTerminalText(value)
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .join('\n')
    .trim()

  return text.length > MAX_HELPER_CHARS ? `${text.slice(0, MAX_HELPER_CHARS)}\n[Descrição visual truncada]` : text
}

function resolveCliPath(): string {
  const packagePath = require.resolve('@verboo/code/package.json')
  const packageJson = require(packagePath) as { bin?: string | Record<string, string> }
  const binPath = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.verboo
  return resolvePackedJavaScriptEntryPath(join(dirname(packagePath), binPath ?? 'dist/cli.mjs'))
}

function toVisionCandidate(model: VerbooModel): VisionCandidate {
  return {
    id: model.id,
    displayName: model.displayName || model.id,
  }
}

function parseJsonLine(line: string): unknown | undefined {
  try {
    return JSON.parse(cleanTerminalText(line))
  } catch {
    return undefined
  }
}

function extractPayloadText(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.result === 'string') return cleanTerminalText(payload.result)
  if (payload.type === 'stream_event' && isRecord(payload.event)) {
    const delta = isRecord(payload.event.delta) ? payload.event.delta : undefined
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') return cleanTerminalText(delta.text)
  }
  if (payload.type === 'assistant' && isRecord(payload.message)) {
    const content = payload.message.content
    if (Array.isArray(content)) {
      const text = content
        .map(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '')
        .filter(Boolean)
        .join('')
      return text ? cleanTerminalText(text) : undefined
    }
  }
  if (typeof payload.content === 'string') return cleanTerminalText(payload.content)
  if (typeof payload.text === 'string') return cleanTerminalText(payload.text)
  return undefined
}

function summarizeHelperOutput(value: string): string | undefined {
  const clean = value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' ')
  return clean ? clean.slice(0, 600) : undefined
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
}

function cleanTerminalText(value: string): string {
  return stripAnsi(value)
    .replace(/\u001b/g, '')
    .replace(/\[\?2026[hl]/g, '')
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null
}
