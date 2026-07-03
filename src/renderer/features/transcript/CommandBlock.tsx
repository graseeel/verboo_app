import type { CommandRun } from '../../../shared/types'

export function CommandBlock({ run }: { run: CommandRun }) {
  return (
    <div className="cmd-block">
      <div className="cmd-block-head">Shell</div>
      <div className="cmd-block-input">$ {run.input}</div>
      {run.output.trim()
        ? <div className="cmd-block-output">{run.output}</div>
        : <div className="cmd-block-output cmd-block-empty">Nenhum resultado</div>}
      <div className={`cmd-block-status ${run.status}`}>
        {run.status === 'running' ? 'Executando…' : run.status === 'failure' ? '✗ Falhou' : '✓ Sucesso'}
      </div>
    </div>
  )
}
