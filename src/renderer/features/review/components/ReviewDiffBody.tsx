import type { FileDiff } from '../../../../shared/types'
import { useI18n } from '../../../i18n'

export function ReviewDiffBody({ loading, diff }: { loading: boolean; diff?: FileDiff }) {
  const { t } = useI18n()

  if (loading) {
    return (
      <div className="review-diff-skeleton" aria-label={t('review.loadingDiff')}>
        <span className="skeleton" style={{ width: '42%' }} />
        <span className="skeleton" style={{ width: '86%' }} />
        <span className="skeleton" style={{ width: '71%' }} />
        <span className="skeleton" style={{ width: '92%' }} />
        <span className="skeleton" style={{ width: '58%' }} />
      </div>
    )
  }
  if (!diff) return <div className="review-empty compact">{t('review.selectFile')}</div>
  if (diff.truncated) return <div className="review-empty compact">{t('review.diffTooLarge')}</div>
  if (diff.message) return <div className="review-empty compact">{t('review.diffUnavailable')}</div>
  if (diff.binary) return <div className="review-empty compact">{t('review.binaryFile')}</div>
  if (diff.hunks.length === 0) return <div className="review-empty compact">{t('review.noChanges')}</div>

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
