import type { CommandRun } from '../../../shared/types'
import { useI18n } from '../../i18n'

export function CommandBlock({ run }: { run: CommandRun }) {
  const { t } = useI18n()

  return (
    <div className="cmd-block">
      <div className="cmd-block-head">{t('command.shell')}</div>
      <div className="cmd-block-input">$ {run.input}</div>
      {run.output.trim()
        ? <div className="cmd-block-output">{run.output}</div>
        : <div className="cmd-block-output cmd-block-empty">{t('command.noOutput')}</div>}
      <div className={`cmd-block-status ${run.status}`}>
        {run.status === 'running' ? t('command.running') : run.status === 'failure' ? `✗ ${t('command.failure')}` : `✓ ${t('command.success')}`}
      </div>
    </div>
  )
}
