import type {
  ProfileActivityDay,
  ProfilePlan,
  ProfileResult,
  ProfileUsageSummary,
  ProfileUser,
} from '../../shared/types'
import { readCliOAuthAccessToken } from './cliCredentials'
import type { CredentialsStore } from './credentialsStore'

const API_BASE = 'https://code.verboo.ai/api'

type JsonRecord = Record<string, unknown>

export class ProfileService {
  constructor(private readonly credentials: CredentialsStore) {}

  async getProfile(): Promise<ProfileResult> {
    const bearerToken = await readCliOAuthAccessToken() ?? await this.credentials.getApiKey()
    if (!bearerToken) {
      return {
        status: 'unauthenticated',
        error: 'Entre com Verboo pelo CLI/app ou configure uma chave API para carregar dados reais de perfil.',
      }
    }

    const now = new Date()
    const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const usageQuery = `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(now.toISOString())}&bucket=day`

    const [meResult, groupsResult, subscriptionsResult] = await Promise.allSettled([
      this.request('/me', bearerToken),
      this.request('/me/groups', bearerToken),
      this.request('/me/subscriptions', bearerToken),
    ])

    const me = valueFrom(meResult)
    const groups = arrayFrom(valueFrom(groupsResult))
    const subscriptions = arrayFrom(valueFrom(subscriptionsResult))
    const activeGroups = groups.filter(isActiveMembership)
    const groupIds = activeGroups
      .map(group => stringValue(group.groupId) ?? stringValue(group.id))
      .filter((id): id is string => Boolean(id))

    const usageResults = await Promise.allSettled(
      groupIds.map(groupId => this.request(`/me/groups/${groupId}/usage/summary?${usageQuery}`, bearerToken)),
    )

    const summaries = usageResults.map(valueFrom).filter(Boolean)
    const summary = mergeSummaries(
      summaries.map(normalizeSummary).filter((item): item is ProfileUsageSummary => Boolean(item)),
    )
    const activity = mergeActivity(summaries.flatMap(normalizeActivity))
    const user = normalizeUser(me)
    const plan = normalizePlan(subscriptions, activeGroups, me)

    if (!me && !groups.length && !subscriptions.length && !summaries.length) {
      return {
        status: 'error',
        error: 'Nao foi possivel carregar dados reais do Verboo com a credencial atual.',
      }
    }

    return {
      status: 'ready',
      fetchedAt: Date.now(),
      user,
      plan,
      summary,
      activity,
      activeDays: activity.filter(day => day.count > 0).length,
      error: collectErrors([meResult, groupsResult, subscriptionsResult, ...usageResults]),
    }
  }

  private async request(path: string, apiKey: string): Promise<unknown> {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const payload = await response.json() as unknown
    return unwrapData(payload)
  }
}

function valueFrom<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === 'fulfilled' ? result.value : undefined
}

function collectErrors(results: PromiseSettledResult<unknown>[]): string | undefined {
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason instanceof Error ? result.reason.message : String(result.reason))
  return errors.length ? `Alguns dados nao foram retornados pela API: ${Array.from(new Set(errors)).join(', ')}` : undefined
}

function unwrapData(value: unknown): unknown {
  if (!isRecord(value)) return value
  if ('data' in value) return value.data
  return value
}

function arrayFrom(value: unknown): JsonRecord[] {
  const unwrapped = unwrapData(value)
  if (Array.isArray(unwrapped)) return unwrapped.filter(isRecord)
  if (!isRecord(unwrapped)) return []

  for (const key of ['items', 'groups', 'subscriptions', 'memberships', 'results']) {
    const nested = unwrapped[key]
    if (Array.isArray(nested)) return nested.filter(isRecord)
  }

  return []
}

function normalizeUser(value: unknown): ProfileUser | undefined {
  const record = firstRecord(value)
  if (!record) return undefined
  return {
    id: stringValue(record.id),
    name: stringValue(record.name) ?? stringValue(record.username) ?? stringValue(record.fullName),
    email: stringValue(record.email),
  }
}

function normalizePlan(
  subscriptions: JsonRecord[],
  activeGroups: JsonRecord[],
  me: unknown,
): ProfilePlan | undefined {
  const subscription = subscriptions.find(isActiveMembership) ?? subscriptions[0]
  const group = activeGroups[0]
  const userRecord = firstRecord(me)
  const planRecord = firstRecord(subscription?.plan) ?? firstRecord(subscription?.group) ?? group ?? userRecord
  if (!planRecord && !subscription) return undefined

  const priceCents =
    numberValue(subscription?.priceCents) ??
    numberValue(subscription?.amountCents) ??
    numberValue(planRecord?.priceCents) ??
    numberValue(planRecord?.monthlyPriceCents)

  return {
    id: stringValue(subscription?.id) ?? stringValue(planRecord?.id),
    name:
      stringValue(subscription?.planName) ??
      stringValue(planRecord?.name) ??
      stringValue(planRecord?.title) ??
      stringValue(userRecord?.subscriptionType),
    status: stringValue(subscription?.status) ?? stringValue(group?.status),
    priceLabel: priceCents !== undefined ? formatBrlFromCents(priceCents) : undefined,
    models: normalizeModelNames(subscription, planRecord, group),
  }
}

function normalizeModelNames(...records: Array<unknown>): string[] | undefined {
  const names = new Set<string>()
  for (const record of records) {
    if (!isRecord(record)) continue
    for (const key of ['models', 'modelIds', 'modelNames', 'allowedModels']) {
      const value = record[key]
      if (!Array.isArray(value)) continue
      for (const item of value) {
        if (typeof item === 'string') names.add(item)
        else if (isRecord(item)) {
          const name = stringValue(item.name) ?? stringValue(item.id) ?? stringValue(item.displayName)
          if (name) names.add(name)
        }
      }
    }
  }
  return names.size ? Array.from(names) : undefined
}

function normalizeSummary(value: unknown): ProfileUsageSummary | undefined {
  const record = firstRecord(value)
  if (!record) return undefined
  const total = firstRecord(record.total) ?? record
  const tokensInTotal =
    numberValue(total.tokensInTotal) ??
    numberValue(total.tokensIn) ??
    numberValue(total.inputTokens) ??
    numberValue(total.input_tokens)
  const tokensOutTotal =
    numberValue(total.tokensOutTotal) ??
    numberValue(total.tokensOut) ??
    numberValue(total.outputTokens) ??
    numberValue(total.output_tokens)
  const totalTokens =
    numberValue(total.totalTokens) ??
    numberValue(total.tokensTotal) ??
    numberValue(total.tokens) ??
    (tokensInTotal !== undefined || tokensOutTotal !== undefined
      ? (tokensInTotal ?? 0) + (tokensOutTotal ?? 0)
      : undefined)
  const reqTotal =
    numberValue(total.reqTotal) ??
    numberValue(total.requests) ??
    numberValue(total.requestCount) ??
    numberValue(total.totalRequests)

  if (
    tokensInTotal === undefined &&
    tokensOutTotal === undefined &&
    totalTokens === undefined &&
    reqTotal === undefined
  ) {
    return undefined
  }

  return { tokensInTotal, tokensOutTotal, totalTokens, reqTotal }
}

function mergeSummaries(summaries: ProfileUsageSummary[]): ProfileUsageSummary | undefined {
  if (!summaries.length) return undefined
  return {
    tokensInTotal: sumDefined(summaries.map(summary => summary.tokensInTotal)),
    tokensOutTotal: sumDefined(summaries.map(summary => summary.tokensOutTotal)),
    totalTokens: sumDefined(summaries.map(summary => summary.totalTokens)),
    reqTotal: sumDefined(summaries.map(summary => summary.reqTotal)),
  }
}

function normalizeActivity(value: unknown): ProfileActivityDay[] {
  const record = firstRecord(value)
  const buckets = Array.isArray(value)
    ? value
    : Array.isArray(record?.buckets)
      ? record.buckets
      : Array.isArray(record?.days)
        ? record.days
        : Array.isArray(record?.series)
          ? record.series
          : []

  return buckets.filter(isRecord).flatMap(bucket => {
    const date = stringValue(bucket.date) ?? stringValue(bucket.day) ?? stringValue(bucket.bucket)
    const count =
      numberValue(bucket.count) ??
      numberValue(bucket.reqTotal) ??
      numberValue(bucket.requests) ??
      numberValue(bucket.requestCount)
    if (!date || count === undefined) return []
    return [{ date: date.slice(0, 10), count }]
  })
}

function mergeActivity(days: ProfileActivityDay[]): ProfileActivityDay[] {
  const merged = new Map<string, number>()
  for (const day of days) {
    merged.set(day.date, (merged.get(day.date) ?? 0) + day.count)
  }
  return Array.from(merged, ([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date))
}

function isActiveMembership(record: JsonRecord): boolean {
  const status = stringValue(record.status)
  if (!status) return true
  return ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(status)
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined)
  if (!defined.length) return undefined
  return defined.reduce((total, value) => total + value, 0)
}

function firstRecord(value: unknown): JsonRecord | undefined {
  const unwrapped = unwrapData(value)
  if (isRecord(unwrapped)) return unwrapped
  return undefined
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function formatBrlFromCents(cents: number): string {
  return Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100)
}
