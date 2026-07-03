import type { FileDiff } from '../../../../shared/types'

export function ReviewDiffBody({ loading, diff }: { loading: boolean; diff?: FileDiff }) {
  if (loading) return <div className="review-empty compact">Carregando diff...</div>
  if (!diff) return <div className="review-empty compact">Selecione um arquivo.</div>
  if (diff.message) return <div className="review-empty compact">{diff.message}</div>
  if (diff.truncated) return <div className="review-empty compact">Diff muito grande para exibir.</div>
  if (diff.binary) return <div className="review-empty compact">Arquivo binário.</div>
  if (diff.hunks.length === 0) return <div className="review-empty compact">Nenhuma mudança.</div>

  return (
    <div className="review-body">
      {diff.hunks.map((hunk, hunkIndex) => (
        <section key={`${hunk.header}:${hunkIndex}`} className="review-hunk">
          <div className="review-hunk-header">{hunk.header}</div>
          {hunk.lines.map((line, lineIndex) => (
            <div key={`${line.oldLine}:${line.newLine}:${lineIndex}`} className={`review-line ${line.kind}`}>
              <span className="review-line-number">{line.oldLine ?? ''}</span>
              <span className="review-line-number">{line.newLine ?? ''}</span>
              <span className="review-line-sign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}</span>
              <span className="review-line-text">{line.text || ' '}</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}
