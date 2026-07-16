import { describe, expect, it } from 'vitest'
import type { SkillSummary } from '../../../shared/types'
import type { ComputerUseApp } from '../../verboo-bridge'
import {
  countHiddenComputerUseApps,
  detectComputerUseIntent,
  extractComputerUseAppSelector,
  resolveComputerUseTarget,
  shouldStartGoalDirectedComputerUse,
} from './computerUseIntent'

const computerUseSkill: SkillSummary = {
  id: 'computer-use',
  name: 'Computer Use',
  description: 'Control an explicitly authorized desktop app',
  path: '/skills/computer-use/SKILL.md',
  source: 'user',
  trusted: true,
}

describe('detectComputerUseIntent', () => {
  it('detects an explicit English computer-control request', () => {
    expect(detectComputerUseIntent('Use computer control to type hello in Notes', [])).toEqual({
      source: 'explicit',
      goal: 'Use computer control to type hello in Notes',
    })
  })

  it('detects the explicit Computer Use command phrase', () => {
    expect(detectComputerUseIntent('Computer Use: type hello in Notes', [])).toEqual({
      source: 'explicit',
      goal: 'Computer Use: type hello in Notes',
    })
  })

  it('detects an explicit Portuguese computer-control request', () => {
    expect(detectComputerUseIntent('Controle o computador para digitar olá no Notas', [])).toEqual({
      source: 'explicit',
      goal: 'Controle o computador para digitar olá no Notas',
    })
  })

  it('detects a polite explicit request even when the trigger is not the first phrase', () => {
    expect(detectComputerUseIntent('Você pode usar o computer use para testar o app no Notes?', [])).toEqual({
      source: 'explicit',
      goal: 'Você pode usar o computer use para testar o app no Notes?',
    })
    expect(detectComputerUseIntent('Could you please use the computer to test Notes?', [])).toEqual({
      source: 'explicit',
      goal: 'Could you please use the computer to test Notes?',
    })
  })

  it('routes a direct Calculator command through native Computer Use', () => {
    const goal = 'Abra a Calculadora, calcule 1 + 1 e confirme visualmente o resultado.'

    expect(detectComputerUseIntent(goal, [])).toEqual({
      source: 'explicit',
      goal,
    })
  })

  it('does not treat workspace file commands as desktop app control', () => {
    expect(detectComputerUseIntent('Abra o arquivo package.json', [])).toBeUndefined()
    expect(detectComputerUseIntent('Open the project README', [])).toBeUndefined()
    expect(detectComputerUseIntent('Run npm test', [])).toBeUndefined()
    expect(detectComputerUseIntent('Execute cargo test', [])).toBeUndefined()
  })

  it('treats selecting the computer-use skill as explicit intent', () => {
    expect(detectComputerUseIntent('Type hello in Notes', [computerUseSkill])).toEqual({
      source: 'selected-skill',
      goal: 'Type hello in Notes',
    })
  })

  it('recognizes the shipped skill by id or path even if its display name is localized', () => {
    expect(detectComputerUseIntent('Teste o Notes', [{
      ...computerUseSkill,
      name: 'Uso do computador',
    }])).toEqual({ source: 'selected-skill', goal: 'Teste o Notes' })
  })

  it('leaves non-explicit computer-use discussion in normal chat', () => {
    expect(detectComputerUseIntent('Explain how computer use works on macOS', [])).toBeUndefined()
    expect(detectComputerUseIntent('Explain how to use computer control safely', [])).toBeUndefined()
  })
})

const runningApps: ComputerUseApp[] = [
  { bundleId: 'com.apple.Notes', name: 'Notes', pid: 10, isFrontmost: false },
  { bundleId: 'com.google.Chrome', name: 'Google Chrome', pid: 11, isFrontmost: false },
  { bundleId: 'ai.verboo.code.desktop', name: 'Verboo Code', pid: 12, isFrontmost: true },
]

describe('countHiddenComputerUseApps', () => {
  it('counts unique visible apps while excluding the target and Verboo', () => {
    expect(countHiddenComputerUseApps([
      { bundleId: 'com.apple.Notes', name: 'Notes', pid: 10, isFrontmost: true, visibleWindowCount: 1 },
      { bundleId: 'ai.verboo.code.desktop', name: 'Verboo Code', pid: 11, isFrontmost: false, visibleWindowCount: 2 },
      { bundleId: 'com.google.Chrome', name: 'Google Chrome', pid: 12, isFrontmost: false, visibleWindowCount: 2 },
      { bundleId: 'COM.GOOGLE.CHROME', name: 'Google Chrome Helper', pid: 13, isFrontmost: false, visibleWindowCount: 1 },
      { bundleId: 'com.apple.Preview', name: 'Preview', pid: 14, isFrontmost: false, visibleWindowCount: 1 },
      { bundleId: 'com.apple.TextEdit', name: 'TextEdit', pid: 15, isFrontmost: false, visibleWindowCount: 0 },
      { bundleId: 'com.apple.Safari', name: 'Safari', pid: 16, isFrontmost: false },
    ], 'com.apple.Notes')).toBe(2)
  })

  it('excludes apps that are already approved for the session', () => {
    expect(countHiddenComputerUseApps([
      { bundleId: 'com.apple.Notes', name: 'Notes', pid: 10, isFrontmost: true, visibleWindowCount: 1 },
      { bundleId: 'com.google.Chrome', name: 'Chrome', pid: 12, isFrontmost: false, visibleWindowCount: 1 },
    ], 'com.apple.Notes', ['com.google.Chrome'])).toBe(0)
  })
})

describe('resolveComputerUseTarget', () => {
  it('matches a running app mentioned naturally in Portuguese', () => {
    expect(resolveComputerUseTarget('Abra o Notas e digite hello', runningApps)?.bundleId)
      .toBe('com.apple.Notes')
  })

  it('prefers the full application name over a shorter alias', () => {
    expect(resolveComputerUseTarget('Teste no Google Chrome', runningApps)?.bundleId)
      .toBe('com.google.Chrome')
  })

  it('supports the composer example without requiring a modal', () => {
    expect(resolveComputerUseTarget(
      '/computer-use quero que você abra o app verboo e teste mudanças que eu fiz',
      runningApps,
    )?.bundleId).toBe('ai.verboo.code.desktop')
  })

  it('returns undefined instead of guessing when no app is identifiable', () => {
    expect(resolveComputerUseTarget('Teste isso para mim', runningApps)).toBeUndefined()
  })

  it('extracts an app selector for apps that are not running yet', () => {
    expect(extractComputerUseAppSelector('/computer-use abra o app TextEdit e escreva hello'))
      .toBe('TextEdit')
    expect(extractComputerUseAppSelector('Use o aplicativo Google Chrome para testar a página'))
      .toBe('Google Chrome')
    expect(extractComputerUseAppSelector(
      'Abra a Calculadora, calcule 1 + 1 e confirme visualmente o resultado.',
    )).toBe('Calculadora')
  })
})

describe('shouldStartGoalDirectedComputerUse', () => {
  it('returns false when there is no intent', () => {
    expect(shouldStartGoalDirectedComputerUse(undefined, undefined)).toBe(false)
  })

  it('returns true for skill intent even without a resolved app (goal-directed)', () => {
    const intent = detectComputerUseIntent('adicionamos essa feature, quero que você teste', [computerUseSkill])
    expect(intent).toBeDefined()
    expect(shouldStartGoalDirectedComputerUse(intent, undefined)).toBe(true)
  })

  it('returns true for explicit NL intent without a resolved app', () => {
    const intent = detectComputerUseIntent('Use computer control to test the new feature', [])
    expect(intent).toBeDefined()
    expect(shouldStartGoalDirectedComputerUse(intent, undefined)).toBe(true)
  })

  it('returns true when an app is resolved (classic pre-bind path)', () => {
    const intent = detectComputerUseIntent('Controle o computador para digitar olá no Notas', [])
    const app = resolveComputerUseTarget('Controle o computador para digitar olá no Notas', runningApps)
    expect(intent).toBeDefined()
    expect(app).toBeDefined()
    expect(shouldStartGoalDirectedComputerUse(intent, app)).toBe(true)
  })
})
