import { app, shell } from 'electron'
import type { FeedbackRequest, FeedbackResult } from '../../shared/types'

const FEEDBACK_EMAIL = 'grasel.moura05@gmail.com'

export class FeedbackService {
  async sendFeedback(request: FeedbackRequest): Promise<FeedbackResult> {
    const normalized = normalizeRequest(request)
    const endpoint = process.env.VERBOO_FEEDBACK_ENDPOINT?.trim()
    const publicKey = process.env.VERBOO_FEEDBACK_PUBLIC_KEY?.trim() || process.env.VERBOO_FEEDBACK_ANON_KEY?.trim()

    if (endpoint) {
      try {
        await postToSupabase(endpoint, publicKey, normalized)
        return {
          ok: true,
          channel: 'supabase',
          message: 'Feedback enviado.',
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Falha desconhecida ao enviar pelo Supabase.'
        await openMailto(normalized, message)
        return {
          ok: true,
          channel: 'mailto',
          message: 'Não foi possível enviar pelo Supabase. Um e-mail preenchido foi aberto como fallback.',
          error: message,
        }
      }
    }

    await openMailto(normalized, 'VERBOO_FEEDBACK_ENDPOINT não configurado.')
    return {
      ok: true,
      channel: 'mailto',
      message: 'Supabase não está configurado neste build. Um e-mail preenchido foi aberto.',
    }
  }
}

async function postToSupabase(endpoint: string, publicKey: string | undefined, request: FeedbackRequest): Promise<void> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(publicKey ? { authorization: `Bearer ${publicKey}`, apikey: publicKey } : {}),
    },
    body: JSON.stringify({
      ...request,
      appVersion: app.getVersion(),
      platform: process.platform,
      systemVersion: process.getSystemVersion(),
    }),
  })

  if (response.ok) return

  const details = await response.text().catch(() => '')
  throw new Error(`HTTP ${response.status}${details ? `: ${details.slice(0, 220)}` : ''}`)
}

async function openMailto(request: FeedbackRequest, fallbackReason: string): Promise<void> {
  const subject = `[Verboo Code Desktop] ${labelForCategory(request.category)}: ${request.title}`
  const body = [
    request.description,
    '',
    `Contato: ${request.contact || 'não informado'}`,
    `Canal principal: ${fallbackReason}`,
    '',
    'Diagnosticos:',
    request.includeDiagnostics && request.diagnostics
      ? JSON.stringify(request.diagnostics, null, 2)
      : 'não incluídos',
  ].join('\n')

  const url = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  await shell.openExternal(url)
}

function normalizeRequest(request: FeedbackRequest): FeedbackRequest {
  const title = request.title.trim().slice(0, 160)
  const description = request.description.trim().slice(0, 8000)
  const contact = request.contact?.trim().slice(0, 160)

  return {
    ...request,
    title: title || labelForCategory(request.category),
    description,
    contact: contact || undefined,
    diagnostics: request.includeDiagnostics ? request.diagnostics : undefined,
  }
}

function labelForCategory(category: FeedbackRequest['category']): string {
  if (category === 'bug') return 'Bug'
  if (category === 'question') return 'Dúvida'
  return 'Feedback'
}
