import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const appUrl = 'http://localhost:5183'
const geometryTolerance = 1
const mockBridge = readFileSync(resolve(currentDirectory, 'mock-bridge.js'), 'utf8')
const loginBridge = `${mockBridge}\n
;(() => {
  let settings = {
    language: 'pt-BR',
    theme: 'system',
    defaultAccessMode: 'approval',
    fullAccessEnabled: false,
    showInMenuBar: true,
    showMenuBarText: true,
    staySignedIn: false,
    preventSleepWhileRunning: true,
    completionNotifications: 'background',
    permissionNotifications: true,
    questionNotifications: true,
    responseEnhancementsEnabled: true,
    personality: 'pragmatic',
    customInstructions: '',
    trustedCommands: [],
    customSlashCommands: [],
    memoriesEnabled: true,
    chroniclePreview: true,
    ignoreToolChatsForMemory: true,
    goalMode: { enabled: true, maxTurns: 4, maxElapsedMinutes: 10, allowAutoAccess: false },
    updates: { channel: 'stable', autoCheck: true, autoDownload: false },
    visionFallbackConsent: 'ask',
    videoFallbackConsent: 'ask',
    trustedSkills: [],
    includeVerbooCoAuthor: false,
    browserVerificationEnabled: true,
    loadWebIcons: true,
  }

  window.localStorage.clear()
  window.verboo.getCredentialStatus = () => Promise.resolve({ hasApiKey: false })
  window.verboo.getCliAuthStatus = () => Promise.resolve({ loggedIn: false })
  window.verboo.listModels = () => Promise.resolve({ models: [], source: 'none', stale: false })
  window.verboo.getUserSettings = () => Promise.resolve(settings)
  window.verboo.updateUserSettings = async (patch) => {
    settings = { ...settings, ...patch }
    return settings
  }
})()
`

type Box = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>
type LoginGeometry = Record<'panel' | 'primary' | 'footer', Box>

test.beforeEach(async ({ page }) => {
  await page.addInitScript(loginBridge)
  await page.goto(appUrl)
  await expect(page.locator('.login-panel')).toBeVisible()
})

async function measure(locator: Locator, label: string): Promise<Box> {
  const box = await locator.boundingBox()
  expect(box, `${label} must have a browser layout box`).not.toBeNull()
  return box!
}

async function measureLogin(page: Page): Promise<LoginGeometry> {
  return {
    panel: await measure(page.locator('.login-panel'), 'login panel'),
    primary: await measure(page.locator('.login-actions .primary-action'), 'primary action'),
    footer: await measure(page.locator('.login-footer'), 'login footer'),
  }
}

function expectStableGeometry(before: LoginGeometry, after: LoginGeometry) {
  for (const region of ['panel', 'primary', 'footer'] as const) {
    for (const dimension of ['x', 'y', 'width', 'height'] as const) {
      const delta = Math.abs(after[region][dimension] - before[region][dimension])
      expect(
        delta,
        `${region}.${dimension} shifted by ${delta}px after localization`,
      ).toBeLessThanOrEqual(geometryTolerance)
    }
  }
}

test('keeps the visible login geometry stable when the real selector changes pt-BR to en-US', async ({ page }) => {
  const before = await measureLogin(page)

  await page.getByRole('button', { name: 'Idioma' }).click()
  await page.getByRole('option', { name: /English/ }).click()
  await expect(page.getByRole('button', { name: /Sign in with CLI/ })).toBeVisible()
  await page.evaluate(() => new Promise<void>(resolveFrame => requestAnimationFrame(() => resolveFrame())))

  expectStableGeometry(before, await measureLogin(page))
})

test('lets the compact language trigger grow around a long localized label without overflow', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Idioma' })
  await trigger.locator('span').evaluate(element => {
    element.textContent = 'PORTUGUÊS (BRASIL)'
  })

  const geometry = await trigger.evaluate(element => {
    const label = element.querySelector('span')!
    const triggerBox = element.getBoundingClientRect()
    const labelBox = label.getBoundingClientRect()
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      triggerLeft: triggerBox.left,
      triggerRight: triggerBox.right,
      labelLeft: labelBox.left,
      labelRight: labelBox.right,
    }
  })

  expect(geometry.scrollWidth, 'localized content must not overflow the trigger').toBeLessThanOrEqual(
    geometry.clientWidth + geometryTolerance,
  )
  expect(geometry.labelLeft).toBeGreaterThanOrEqual(geometry.triggerLeft - geometryTolerance)
  expect(geometry.labelRight).toBeLessThanOrEqual(geometry.triggerRight + geometryTolerance)
})
