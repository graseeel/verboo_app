import type { AccessMode } from '../../shared/types'

export type AccessModeConfig = {
  title: string
  description: string
  cliArgs: string[]
  danger: 'low' | 'medium' | 'high'
}

export const accessModeConfig: Record<AccessMode, AccessModeConfig> = {
  approval: {
    title: 'Solicitar aprovação',
    description: 'Sempre pedir aprovação para editar arquivos externos e usar a internet',
    cliArgs: ['--permission-mode', 'default'],
    danger: 'low',
  },
  auto: {
    title: 'Aprovar por mim',
    description: 'Solicitar aprovação apenas para ações detectadas como potencialmente inseguras',
    cliArgs: ['--permission-mode', 'acceptEdits'],
    danger: 'medium',
  },
  full: {
    title: 'Modo livre',
    description: 'Executar sem novas aprovações em workspaces confiáveis',
    cliArgs: [
      '--allow-dangerously-skip-permissions',
      '--dangerously-skip-permissions',
      '--permission-mode',
      'bypassPermissions',
    ],
    danger: 'high',
  },
}
