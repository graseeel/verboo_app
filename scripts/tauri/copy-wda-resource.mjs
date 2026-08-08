#!/usr/bin/env node
// Copy the pinned Appium WebDriverAgent project into Tauri's generated
// resource tree. The Rust service resolves this path from the app resource
// directory at runtime; it never assumes an Xcode installation path.

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))

export function wdaResourcePaths(repositoryRoot = path.resolve(scriptDirectory, '../..')) {
  return {
    source: path.join(repositoryRoot, 'node_modules', 'appium-webdriveragent'),
    target: path.join(repositoryRoot, 'src-tauri', 'resources', 'WebDriverAgent'),
  }
}

function insertBeforeExactlyOnce(source, anchor, insertion, label) {
  const first = source.indexOf(anchor)
  const last = source.lastIndexOf(anchor)
  if (first < 0 || first !== last) {
    throw new Error(`Não foi possível aplicar o patch sessionless do WDA em ${label}.`)
  }
  return `${source.slice(0, first)}${insertion}\n${source.slice(first)}`
}

export async function patchWdaSessionlessCommands(target) {
  const commandsPath = path.join(
    target,
    'WebDriverAgentLib',
    'Commands',
    'FBCustomCommands.m',
  )
  const patchDirectory = path.join(scriptDirectory, 'wda-sessionless')
  const [prelude, routes, handlers] = await Promise.all([
    readFile(path.join(patchDirectory, 'FBCustomCommands.prelude.inc'), 'utf8'),
    readFile(path.join(patchDirectory, 'FBCustomCommands.routes.inc'), 'utf8'),
    readFile(path.join(patchDirectory, 'FBCustomCommands.handlers.inc'), 'utf8'),
  ])
  let commands = await readFile(commandsPath, 'utf8')
  commands = insertBeforeExactlyOnce(
    commands,
    '@implementation FBCustomCommands',
    prelude.trimEnd(),
    'FBCustomCommands prelude',
  )
  commands = insertBeforeExactlyOnce(
    commands,
    '    [[FBRoute POST:@"/timeouts"] respondWithTarget:self action:@selector(handleTimeouts:)],',
    routes.trimEnd(),
    'FBCustomCommands routes',
  )
  commands = insertBeforeExactlyOnce(
    commands,
    '\n@end',
    `\n${handlers.trimEnd()}`,
    'FBCustomCommands handlers',
  )
  await writeFile(commandsPath, commands)
}

export async function copyWdaResource(repositoryRoot, platform = process.platform) {
  if (platform !== 'darwin') {
    console.log(`[copy-wda-resource] Skipped on ${platform}`)
    return null
  }
  const { source, target } = wdaResourcePaths(repositoryRoot)
  const project = path.join(source, 'WebDriverAgent.xcodeproj')
  if (!existsSync(project)) {
    throw new Error(`WebDriverAgent não encontrado em ${source}. Rode npm install.`)
  }
  await rm(target, { recursive: true, force: true })
  await mkdir(path.dirname(target), { recursive: true })
  await cp(source, target, { recursive: true, force: true })
  await patchWdaSessionlessCommands(target)
  console.log(`[copy-wda-resource] Copied WebDriverAgent to ${target}`)
  return target
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  await copyWdaResource(path.resolve(scriptDirectory, '../..'), process.platform)
}
