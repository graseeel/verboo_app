export type AccessMode = 'approval' | 'auto' | 'full'
export type ThemeMode = 'dark' | 'light'
export type SettingsTab =
  | 'permissions'
  | 'app'
  | 'notifications'
  | 'personalization'
  | 'memory'
  | 'archived'
export type PersonalityMode = 'pragmatic' | 'concise' | 'explanatory'
export type CompletionNotificationMode = 'always' | 'background' | 'never'

export type SkillSource = 'project' | 'user' | 'legacy' | 'managed'

export type SkillSummary = {
  id: string
  name: string
  description: string
  path: string
  source: SkillSource
  trusted: boolean
}

export type TranscriptItem = {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
  timestamp: number
  modelId?: string
  modelDisplayName?: string
  streaming?: boolean
  skills?: SkillSummary[]
}

export type ChatProject = {
  id: string
  name: string
  path?: string
  collapsed: boolean
  createdAt: number
  updatedAt: number
  archivedAt?: number
}

export type StoredConversation = {
  id: string
  title: string
  projectId?: string
  items: TranscriptItem[]
  createdAt: number
  updatedAt: number
  archivedAt?: number
}

export type ChatStore = {
  version: 1
  projects: ChatProject[]
  conversations: StoredConversation[]
}

export type VerbooModel = {
  id: string
  displayName: string
  contextWindow?: number
  maxOutputTokens?: number
  supportsVision?: boolean
  visionSupportSource?: 'router' | 'raw-capabilities' | 'heuristic'
  raw: unknown
}

export type ModelDiscoveryResult = {
  models: VerbooModel[]
  source: 'cli' | 'api-key' | 'cache' | 'none'
  stale: boolean
  error?: string
}

export type UserSettings = {
  defaultAccessMode: AccessMode
  showInMenuBar: boolean
  showMenuBarText: boolean
  preventSleepWhileRunning: boolean
  completionNotifications: CompletionNotificationMode
  permissionNotifications: boolean
  questionNotifications: boolean
  personality: PersonalityMode
  customInstructions: string
  memoriesEnabled: boolean
  chroniclePreview: boolean
  ignoreToolChatsForMemory: boolean
}

export type MenuBarState = {
  execution: 'idle' | 'thinking' | 'tool' | 'permission' | 'done' | 'error'
  label?: string
  startedAt?: number
  modelId?: string
  modelDisplayName?: string
  contextWindow?: number
  contextUsage?: number
  workingDirectory?: string
  loggedIn?: boolean
  email?: string
}

export type TokenUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export type ContextUsageSnapshot = {
  usedTokens: number
  maxTokens?: number
  percentage?: number
  inputTokens?: number
  outputTokens?: number
  source: 'cli-usage'
  updatedAt: number
}

export type CredentialStatus = {
  hasApiKey: boolean
  apiKeyHint?: string
}

export type CliAuthStatus = {
  loggedIn: boolean
  authMethod?: string
  apiProvider?: string
  email?: string
  orgId?: string
  orgName?: string | null
  subscriptionType?: string | null
  error?: string
}

export type LoginResult = {
  ok: boolean
  message: string
  status?: CliAuthStatus
}

export type ProfileUsageSummary = {
  tokensInTotal?: number
  tokensOutTotal?: number
  totalTokens?: number
  reqTotal?: number
}

export type ProfileActivityDay = {
  date: string
  count: number
}

export type ProfilePlan = {
  id?: string
  name?: string
  status?: string
  priceLabel?: string
  models?: string[]
}

export type ProfileUser = {
  id?: string
  name?: string
  email?: string
}

export type ProfileResult = {
  status: 'ready' | 'unauthenticated' | 'error'
  fetchedAt?: number
  user?: ProfileUser
  plan?: ProfilePlan
  summary?: ProfileUsageSummary
  activity?: ProfileActivityDay[]
  activeDays?: number
  error?: string
}

export type AttachmentKind = 'image' | 'file'

export type AttachmentMeta = {
  path: string
  name: string
  size: number
  kind: AttachmentKind
  mediaType?: string
  width?: number
  height?: number
}

export type AgentTurnRequest = {
  message: string
  model?: string
  modelSupportsVision?: boolean
  contextWindow?: number
  accessMode: AccessMode
  workingDirectory: string
  skills: SkillSummary[]
  attachments?: AttachmentMeta[]
  personality?: PersonalityMode
  customInstructions?: string
  memoryContext?: string
}

export type FeedbackCategory = 'bug' | 'feedback' | 'question'

export type FeedbackDiagnostics = {
  appVersion: string
  platform: string
  appSource: 'desktop'
  projectName?: string
  activeView?: string
  modelId?: string
  modelDisplayName?: string
  modelSource?: ModelDiscoveryResult['source']
  accessMode?: AccessMode
  contextWindow?: number
  contextUsage?: ContextUsageSnapshot
  authMethod?: string
  cliLoggedIn?: boolean
  hasApiKey?: boolean
}

export type FeedbackRequest = {
  category: FeedbackCategory
  title: string
  description: string
  contact?: string
  includeDiagnostics: boolean
  diagnostics?: FeedbackDiagnostics
}

export type FeedbackResult = {
  ok: boolean
  channel: 'supabase' | 'mailto'
  message: string
  error?: string
}

export type AgentEvent =
  | { type: 'started'; turnId: string }
  | { type: 'stdout'; turnId: string; text: string }
  | { type: 'stderr'; turnId: string; text: string }
  | { type: 'json'; turnId: string; payload: unknown }
  | { type: 'error'; turnId: string; message: string }
  | { type: 'done'; turnId: string; exitCode: number | null }

export type AppConfig = {
  workingDirectory: string
  accessMode: AccessMode
  selectedModel?: string
}
