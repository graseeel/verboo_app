import { app } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, copyFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import sharp from 'sharp'
import { createWorker, PSM } from 'tesseract.js'
import type { AgentTurnRequest, AttachmentMeta, VerbooModel } from '../../shared/types'
import { createImageBlock } from './attachmentService'
import type { ModelService } from './modelService'

const require = createRequire(import.meta.url)
const MAX_OCR_CHARS = 12_000
const MAX_HELPER_CHARS = 12_000
const OCR_IMAGE_WIDTH = 2600
const VISION_HELPER_TIMEOUT_MS = 60_000
const DEFAULT_VISION_HELPER_MODELS: VisionCandidate[] = [
  { id: 'pro/qwen3.6-27b', displayName: 'Pro (qwen3.6-27b)' },
  { id: 'pro/deepseek-v4-flash', displayName: 'Pro (deepseek-v4-flash)' },
]
const VISION_HELPER_PROMPT = [
  'Voce e um leitor visual auxiliar do Verboo Code.',
  'Descreva a imagem para outro modelo responder ao usuario.',
  'Responda em portugues, de forma objetiva, cobrindo:',
  '- tipo de imagem: print, interface, documento, foto, grafico ou outro;',
  '- texto visivel importante;',
  '- layout, elementos principais, cores e estado da interface quando houver;',
  '- qualquer incerteza relevante.',
  'Nao use ferramentas de arquivo. Nao mencione que voce e um modelo auxiliar.',
].join('\n')

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

    try {
      for (const attachment of imageAttachments) {
        try {
          descriptions.push(await describeImageWithVisionHelper(attachment, visionCandidates, request.workingDirectory, failedVisionModels))
          continue
        } catch (visionError) {
          const visionMessage = visionError instanceof Error ? visionError.message : String(visionError)
          try {
            worker ??= await createOcrWorker()
            descriptions.push(await describeImageWithOcr(worker, attachment))
          } catch (ocrError) {
            const ocrMessage = ocrError instanceof Error ? ocrError.message : String(ocrError)
            failures.push(`${attachment.name}: helper vision falhou (${visionMessage}); OCR falhou (${ocrMessage})`)
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
): Promise<VisualDescription> {
  if (candidates.length === 0) {
    throw new Error('Nenhum modelo vision auxiliar disponivel para esta conta.')
  }

  const errors: string[] = []

  for (const candidate of candidates) {
    if (failedVisionModels.has(candidate.id)) continue
    try {
      const text = await runVisionHelper(candidate, attachment, workingDirectory)
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

  throw new Error(errors.join('; ') || 'Nenhum modelo vision auxiliar retornou descricao.')
}

async function runVisionHelper(
  candidate: VisionCandidate,
  attachment: AttachmentMeta,
  workingDirectory: string,
): Promise<string> {
  const imageBlock = await createImageBlock(attachment)
  if (!imageBlock) {
    throw new Error('Nao foi possivel preparar a imagem para o helper vision.')
  }

  const cliPath = resolveCliPath()
  const payload = `${JSON.stringify({
    type: 'user',
    session_id: '',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: VISION_HELPER_PROMPT },
        imageBlock,
      ],
    },
    parent_tool_use_id: null,
  })}\n`

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
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
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
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
      finish(new Error(`Helper vision terminou sem descricao (codigo ${exitCode ?? 'desconhecido'}): ${detail}`))
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
    throw new Error('Nao foi possivel extrair texto da imagem com OCR local.')
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
  const lines = [
    'Contexto visual dos anexos:',
    'O app analisou os anexos com um modelo vision auxiliar quando disponivel. Se o helper falhou, usou OCR local como fallback.',
    'Use este contexto visual como apoio. Se o usuario pedir algo visual, responda com base nele.',
    'Nao diga que houve falha de permissao ou falta de vision apenas porque a leitura visual foi convertida em texto. Cite incertezas somente quando a leitura estiver incompleta.',
  ]

  descriptions.forEach((description, index) => {
    const { attachment } = description
    const dimensions = attachment.width && attachment.height ? `${attachment.width}x${attachment.height}` : 'dimensoes desconhecidas'
    const sourceLine = description.mode === 'vision-helper'
      ? `Leitura visual: modelo auxiliar ${description.sourceLabel}.`
      : description.confidence === undefined
        ? 'Leitura visual: OCR local.'
        : `Leitura visual: OCR local com confianca aproximada ${description.confidence}%.`
    lines.push(
      '',
      `[Imagem ${index + 1}: ${attachment.name}]`,
      `Arquivo: ${attachment.path}`,
      `Tipo: ${attachment.mediaType ?? attachment.kind}; dimensoes: ${dimensions}`,
      sourceLine,
      description.text,
    )
  })

  if (failures.length > 0) {
    lines.push(
      '',
      'Limites da leitura visual:',
      failures.join('\n'),
    )
  }

  const imagePaths = new Set((request.attachments ?? [])
    .filter(attachment => attachment.kind === 'image')
    .map(attachment => attachment.path))

  return {
    ...request,
    message: `${lines.join('\n')}\n\nPedido original do usuario:\n${request.message}`,
    attachments: request.attachments?.filter(attachment => !imagePaths.has(attachment.path)),
  }
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

  return text.length > MAX_HELPER_CHARS ? `${text.slice(0, MAX_HELPER_CHARS)}\n[Descricao visual truncada]` : text
}

function resolveCliPath(): string {
  const packagePath = require.resolve('@verboo/code/package.json')
  return join(dirname(packagePath), 'dist', 'cli.mjs')
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
