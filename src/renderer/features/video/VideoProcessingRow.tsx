/**
 * VideoProcessingRow — one compact, transient transcript row that tracks the
 * five backend video-analysis stages and offers cancellation.
 *
 * The row lives in the normal transcript flow (no overlay, no terminal
 * card): the parent removes it entirely on done/error/cancel, and final
 * diagnostics go to the ordinary Worked for activity instead.
 */

import { useState } from 'react'
import { LoaderCircle, X } from 'lucide-react'

import { useI18n } from '../../i18n'
import type { VideoProgress } from '../../../shared/types'

type Props = {
  progress: VideoProgress
  onCancel: () => void
}

export function VideoProcessingRow({ progress, onCancel }: Props) {
  const { t } = useI18n()
  const [cancelRequested, setCancelRequested] = useState(false)

  const units =
    progress.completedUnits !== undefined && progress.totalUnits !== undefined
      ? ` (${progress.completedUnits}/${progress.totalUnits})`
      : ''

  return (
    <div className="video-processing-row" role="status">
      <LoaderCircle size={13} strokeWidth={2} className="video-processing-spinner" aria-hidden="true" />
      <span className="video-processing-label">
        {t(`videoProgress.${progress.stage}`)}
        {units}
      </span>
      <button
        type="button"
        className="video-processing-cancel"
        aria-label={t('videoProgress.cancel')}
        disabled={cancelRequested}
        onClick={() => {
          if (cancelRequested) return
          setCancelRequested(true)
          onCancel()
        }}
      >
        <X size={12} strokeWidth={2} aria-hidden="true" />
        <span>{t('videoProgress.cancel')}</span>
      </button>
    </div>
  )
}
