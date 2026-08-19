/**
 * Comprehensive mock of window.verboo bridge for E2E testing.
 * Injected via Playwright addInitScript before the app loads.
 */
window.verboo = {
  // ─── Config ───────────────────────────────────────────────────────
  getConfig: () => Promise.resolve({
    workingDirectory: '/c/test/project',
    accessMode: 'full',
    platform: 'win32',
  }),
  getDefaultWorkingDirectory: () => Promise.resolve('/c/test'),
  getBundledCliVersion: () => Promise.resolve('0.15.14'),

  // ─── Auth ─────────────────────────────────────────────────────────
  getCredentialStatus: () => Promise.resolve({ hasApiKey: true, authMethod: 'api-key' }),
  setApiKey: () => Promise.resolve({ hasApiKey: true, authMethod: 'api-key' }),
  clearApiKey: () => Promise.resolve({ hasApiKey: false }),
  getCliAuthStatus: () => Promise.resolve({ loggedIn: true }),
  startCliLogin: () => Promise.resolve({ url: 'https://example.com/login', status: 'ok' }),
  logout: () => Promise.resolve({ url: '', status: 'ok' }),
  openDashboard: () => Promise.resolve(true),
  openSubscriptions: () => Promise.resolve(true),
  openSignup: () => Promise.resolve(true),

  // ─── Profile ──────────────────────────────────────────────────────
  getProfile: () => Promise.resolve({
    displayName: 'Test User',
    email: 'test@example.com',
    avatarUrl: undefined,
  }),

  // ─── Models ───────────────────────────────────────────────────────
  listModels: (forceRefresh = false) => Promise.resolve({
    models: [
      {
        id: 'deepseek-v4-flash',
        displayName: 'DeepSeek V4 Flash',
        contextWindow: 128000,
        maxOutputTokens: 4096,
        supportsVision: false,
        raw: {},
      },
      {
        id: 'mimo-v2.5',
        displayName: 'MiMo v2.5',
        contextWindow: 1000000,
        maxOutputTokens: 8192,
        supportsVision: true,
        visionSupportSource: 'router',
        raw: {},
      },
      {
        id: 'qwen3.6-27b',
        displayName: 'Qwen 3.6 27B',
        contextWindow: 262000,
        maxOutputTokens: 4096,
        supportsVision: false,
        raw: {},
      },
    ],
    source: 'cli',
    stale: false,
  }),

  // ─── Settings ─────────────────────────────────────────────────────
  getUserSettings: () => Promise.resolve({
    language: 'pt-BR',
    defaultAccessMode: 'full',
    lastSelectedModelId: 'deepseek-v4-flash',
    showInMenuBar: true,
    staySignedIn: true,
    memoriesEnabled: true,
    customInstructions: '',
    personality: 'pragmatic',
    responseEnhancementsEnabled: false,
    trustedSkills: [],
  }),
  updateUserSettings: (patch) => Promise.resolve({ ...patch }),
  resetUserSettings: () => Promise.resolve({}),

  // ─── Skills ───────────────────────────────────────────────────────
  listSkills: (wd) => Promise.resolve([
    {
      id: 'user:deep-analysis',
      name: 'deep-analysis',
      description: 'Análise profunda multi-domínio',
      path: '/skills/deep-analysis/SKILL.md',
      source: 'user',
      trusted: true,
    },
    {
      id: 'user:screen-analysis',
      name: 'screen-analysis-v2',
      description: 'Análise de tela em 3 camadas',
      path: '/skills/screen-analysis-v2/SKILL.md',
      source: 'user',
      trusted: true,
    },
  ]),
  openUserSkillsFolder: () => Promise.resolve('/c/users/test/.verboo/skills'),
  checkSkillApproval: () => Promise.resolve([]),
  approveSkill: () => Promise.resolve({}),

  // ─── Plugins ──────────────────────────────────────────────────────
  pluginList: () => Promise.resolve([
    {
      id: 'chrome-devtools-mcp@claude-plugins-official',
      name: 'Chrome DevTools',
      enabled: true,
      installed: true,
      version: '1.5.0',
      scope: 'user',
    },
  ]),
  pluginAvailable: () => Promise.resolve({ available: [], installed: [] }),
  pluginInstall: () => Promise.resolve({ success: true }),
  pluginEnable: () => Promise.resolve({ success: true }),
  pluginDisable: () => Promise.resolve({ success: true }),
  pluginUninstall: () => Promise.resolve({ success: true }),
  pluginUpdate: () => Promise.resolve({}),
  pluginValidate: () => Promise.resolve({ valid: true }),
  pluginDetail: () => Promise.resolve(null),
  pluginSkills: () => Promise.resolve([]),
  pluginIcon: () => Promise.resolve(null),
  marketplaceList: () => Promise.resolve([]),
  marketplaceAdd: () => Promise.resolve({}),
  marketplaceRemove: () => Promise.resolve(),
  marketplaceManifests: () => Promise.resolve({}),

  // ─── Chrome Integration ───────────────────────────────────────────
  chromeIntegrationStatus: () => Promise.resolve({
    extension: 'missing',
    bridge: 'missing',
    mcp: 'missing',
    connection: 'waitingForChrome',
    panelState: 'unknown',
    aggregate: 'notConfigured',
    availableVersion: '1.0.0',
    canConfigure: true,
    canRepair: false,
    canRemove: false,
    storeUrlAvailable: true,
    developmentBuild: false,
    extensionIdSource: 'none',
  }),
  chromeIntegrationConfigure: () => Promise.resolve({}),
  chromeIntegrationRepair: () => Promise.resolve({}),
  chromeIntegrationTest: () => Promise.resolve({ helper: true, extension: false, mcp: false }),
  chromeIntegrationRemove: () => Promise.resolve({}),
  openChromeExtensionStore: () => Promise.resolve(true),

  // ─── Chat / Turn ──────────────────────────────────────────────────
  sendTurn: () => Promise.resolve('turn-id-123'),
  interrupt: () => Promise.resolve(true),
  runResearchSubagents: () => Promise.resolve([]),
  cancelResearchSubagents: () => Promise.resolve(true),

  // ─── Events (return cleanup fn) ───────────────────────────────────
  onAgentEvent: () => () => {},
  onRefreshDataRequest: () => () => {},
  onProviderLoginEvent: () => () => {},
  onVideoTranscriberProgress: () => () => {},
  onVideoOcrRequest: () => () => {},
  onUpdateStatus: () => () => {},
  onTerminalData: () => () => {},
  onTerminalExit: () => () => {},
  onTerminalError: () => () => {},
  listenForNotificationClick: () => Promise.resolve(() => {}),

  // ─── File / Attachment ────────────────────────────────────────────
  pickFiles: () => Promise.resolve([]),
  inspectFiles: () => Promise.resolve([]),
  inspectDroppedFiles: () => Promise.resolve([]),
  pasteImageBlob: () => Promise.resolve([]),
  beginPastedFileUpload: () => Promise.resolve({ uploadId: 'up-1' }),
  appendPastedFileChunk: () => Promise.resolve(),
  finishPastedFileUpload: () => Promise.resolve({}),
  abortPastedFileUpload: () => Promise.resolve(),
  allowMediaPreviewFile: () => Promise.resolve('/tmp/test.png'),
  fileUrl: (p) => `asset://localhost/${p}`,
  saveAvatarBlob: () => Promise.resolve('/tmp/avatar.png'),
  recordFileRead: () => Promise.resolve(),
  recordFileWrite: () => Promise.resolve(),
  listStaleFiles: () => Promise.resolve([]),
  clearStaleFiles: () => Promise.resolve(),
  listWorkspaceFiles: () => Promise.resolve([]),

  // ─── Project Instructions ─────────────────────────────────────────
  listProjectInstructionFiles: () => Promise.resolve([]),
  readProjectInstructionFile: () => Promise.resolve({ content: '' }),
  writeProjectInstructionFile: () => Promise.resolve(),

  // ─── Workspace ────────────────────────────────────────────────────
  getWorkspaceChanges: () => Promise.resolve({ files: [], ahead: 0, behind: 0 }),
  getWorkspaceBranches: () => Promise.resolve({ current: 'main', branches: ['main'] }),
  switchWorkspaceBranch: () => Promise.resolve({ success: true }),
  commitWorkspaceChanges: () => Promise.resolve({ success: true }),
  createWorkspacePullRequest: () => Promise.resolve({ url: '' }),
  pushWorkspaceChanges: () => Promise.resolve({ success: true }),
  getWorkspaceReviewMetadata: () => Promise.resolve(null),
  getFileDiff: () => Promise.resolve({ diff: '' }),
  revertFile: () => Promise.resolve({ ok: true }),
  openExternalFile: () => Promise.resolve({ ok: true }),

  // ─── Terminal ─────────────────────────────────────────────────────
  terminalStart: () => Promise.resolve({ sessionId: 'term-1' }),
  terminalWrite: () => Promise.resolve(true),
  terminalResize: () => Promise.resolve(true),
  terminalStop: () => Promise.resolve(true),
  terminalGetState: () => Promise.resolve(undefined),

  // ─── Clipboard ────────────────────────────────────────────────────
  clipboardReadText: () => Promise.resolve(''),
  clipboardWriteText: () => Promise.resolve(true),

  // ─── Goal ─────────────────────────────────────────────────────────
  evaluateGoal: () => Promise.resolve({ status: 'idle' }),

  // ─── Updates ──────────────────────────────────────────────────────
  getUpdateStatus: () => Promise.resolve({ status: 'idle' }),
  bootstrapCli: () => Promise.resolve({ status: 'idle' }),
  checkForUpdates: () => Promise.resolve({ status: 'idle' }),
  downloadUpdate: () => Promise.resolve({ status: 'idle' }),
  installUpdate: () => Promise.resolve({ success: true }),

  // ─── Whats New ────────────────────────────────────────────────────
  getWhatsNewStatus: () => Promise.resolve({ lastSeenVersion: '0.7.2-beta' }),
  acknowledgeWhatsNew: () => Promise.resolve({}),

  // ─── Vision / Video ───────────────────────────────────────────────
  getVisionFallbackState: () => Promise.resolve({ consent: 'ask' }),
  setVisionFallbackConsent: () => Promise.resolve({}),
  getVideoComponentState: () => Promise.resolve({ installed: false }),
  downloadVideoTranscriber: () => Promise.resolve(),
  removeVideoTranscriber: () => Promise.resolve(),
  readVideoFrame: () => Promise.resolve(new ArrayBuffer(0)),
  completeVideoOcrBatch: () => Promise.resolve(),

  // ─── Menu Bar ─────────────────────────────────────────────────────
  updateMenuBar: () => Promise.resolve(true),
  forceIdleMenuBar: () => Promise.resolve(true),
  heartbeatMenuBar: () => Promise.resolve('ok'),
  toggleWindowZoom: () => Promise.resolve(true),

  // ─── Provider ─────────────────────────────────────────────────────
  providerAuthStatus: () => Promise.resolve([]),
  providerLoginStart: () => Promise.resolve(''),
  providerLoginConfirmRisk: () => Promise.resolve(),
  providerLoginCancel: () => Promise.resolve(),
  providerCapabilities: () => Promise.resolve({ providers: [] }),
  providerAccountsList: () => Promise.resolve([]),
  providerAccountsUsage: () => Promise.resolve([]),
  providerAccountModels: () => Promise.resolve([]),
  providerAccountSetDefault: () => Promise.resolve(),
  providerAccountRemove: () => Promise.resolve(),

  // ─── Feedback ─────────────────────────────────────────────────────
  sendFeedback: () => Promise.resolve({ success: true }),

  // ─── Notifications ────────────────────────────────────────────────
  fireCompletionNotification: () => Promise.resolve(true),
}
