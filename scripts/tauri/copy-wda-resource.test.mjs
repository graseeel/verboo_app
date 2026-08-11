import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { copyWdaResource, wdaResourcePaths } from './copy-wda-resource.mjs'

test('resolves the WDA source and generated Tauri resource without machine paths', () => {
  const paths = wdaResourcePaths('/repo')
  assert.equal(paths.source, path.join('/repo', 'node_modules', 'appium-webdriveragent'))
  assert.equal(paths.target, path.join('/repo', 'src-tauri', 'resources', 'WebDriverAgent'))
  assert.ok(paths.target.endsWith(path.join('src-tauri', 'resources', 'WebDriverAgent')))
  assert.ok(!paths.target.includes('/Applications/'))
})

test('is a no-op outside macOS even when the WDA package is absent', async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'verboo-wda-platform-'))
  const { target } = wdaResourcePaths(repositoryRoot)

  const result = await copyWdaResource(repositoryRoot, 'linux')

  assert.equal(result, null)
  assert.equal(existsSync(target), false)
})

test('copies the WDA resource on macOS', async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'verboo-wda-macos-'))
  const { source, target } = wdaResourcePaths(repositoryRoot)
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, 'WebDriverAgent.xcodeproj'), 'project')
  const commandsDirectory = path.join(source, 'WebDriverAgentLib', 'Commands')
  await mkdir(commandsDirectory, { recursive: true })
  await writeFile(
    path.join(commandsDirectory, 'FBCustomCommands.m'),
    '#import "FBCustomCommands.h"\n\n@implementation FBCustomCommands\n\n+ (NSArray *)routes\n{\n  return\n  @[\n    [[FBRoute POST:@"/timeouts"] respondWithTarget:self action:@selector(handleTimeouts:)],\n  ];\n}\n\n#pragma mark - Commands\n\n@end\n',
  )

  const result = await copyWdaResource(repositoryRoot, 'darwin')

  assert.equal(result, target)
  assert.equal(existsSync(path.join(target, 'WebDriverAgent.xcodeproj')), true)
  const commands = await readFile(
    path.join(target, 'WebDriverAgentLib', 'Commands', 'FBCustomCommands.m'),
    'utf8',
  )
  for (const route of ['settings', 'tap', 'drag', 'type', 'key', 'home', 'systemGesture', 'rotate', 'inspectPoint']) {
    assert.match(commands, new RegExp(`/wda/verboo/${route}`))
  }
  const handlers = commands
    .split('// VERBOO_SESSIONLESS_HANDLERS_BEGIN')[1]
    .split('// VERBOO_SESSIONLESS_HANDLERS_END')[0]
  assert.doesNotMatch(handlers, /request\.session|XCUIApplication|fb_activeApplication/)
  assert.match(handlers, /_XCT_requestElementAtPoint/)
  assert.match(handlers, /_XCT_fetchAttributes:/)
  assert.match(handlers, /XC_kAXXCAttributeFrame/)
  assert.match(handlers, /spinUntilTrue/)
  assert.doesNotMatch(handlers, /elementAtPoint:error:/)
  assert.doesNotMatch(handlers, /snapshotForElement|spinUntilCompletion/)
  assert.doesNotMatch(handlers, /\.children|recursiveDescription/)
  assert.match(handlers, /ceil\(duration\.doubleValue \* 60\.0\)/)
  assert.match(handlers, /atOffset:duration\.doubleValue \+ hold\.doubleValue/)
  assert.match(handlers, /duration\.doubleValue \+ hold\.doubleValue/)
})

test('declares the WDA bundle resource only in the macOS overlay', () => {
  const base = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
  const macos = JSON.parse(readFileSync('src-tauri/tauri.macos.conf.json', 'utf8'))
  const baseResources = base.bundle.resources
  const macosResources = macos.bundle.resources

  assert.equal(baseResources.includes('resources/WebDriverAgent/'), false)
  assert.equal(macosResources.includes('resources/WebDriverAgent/'), true)
  assert.equal(baseResources.includes('resources/node-runtime/'), false)
  assert.equal(macosResources.includes('resources/node-runtime/'), false)
  assert.equal(baseResources.includes('resources/cli-package/'), false)
  assert.equal(macosResources.includes('resources/cli-package/'), false)
})
