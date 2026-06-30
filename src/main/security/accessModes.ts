import type { AccessMode } from '../../shared/types'

export type AccessModeConfig = {
  title: string
  description: string
  cliArgs: string[]
  danger: 'low' | 'medium' | 'high'
}

export const accessModeConfig: Record<AccessMode, AccessModeConfig> = {
  approval: {
    title: 'Solicitar aprovacao',
    description: 'Sempre pedir aprovacao para editar arquivos externos e usar a internet',
    cliArgs: ['--permission-mode', 'default'],
    danger: 'low',
  },
  auto: {
    title: 'Aprovar por mim',
    description: 'Solicitar aprovacao apenas para acoes detectadas como potencialmente inseguras',
    cliArgs: ['--permission-mode', 'acceptEdits'],
    danger: 'medium',
  },
  full: {
    title: 'Acesso completo',
    description: 'Acesso irrestrito a internet e a qualquer arquivo no seu computador',
    cliArgs: [
      '--allow-dangerously-skip-permissions',
      '--dangerously-skip-permissions',
      '--permission-mode',
      'bypassPermissions',
    ],
    danger: 'high',
  },
}
