import { ArrowLeft, Blocks, Loader2 } from 'lucide-react'
import { useI18n } from '../../i18n'

type PluginsViewProps = {
  onClose: () => void
}

// Plugins marketplace shell. This is a P3 placeholder: the header, back
// button, and honest empty state are real UI, but there is no backend wiring
// yet (no Tauri commands, no plugin cards, no install flow). The empty state
// says "Plugins will be listed here once the marketplace is connected" rather
// than mocking fake plugins — honest about what exists. P6 will wire the
// actual marketplace data.
export function PluginsView({ onClose }: PluginsViewProps) {
  const { t } = useI18n()

  return (
    <div className="plugins-view page-surface">
      <header className="view-heading">
        <div>
          <button className="profile-back" type="button" onClick={onClose}>
            <ArrowLeft size={14} />
            {t('plugins.back')}
          </button>
          <h1>{t('plugins.title')}</h1>
          <p>{t('plugins.subtitle')}</p>
        </div>
      </header>

      <div className="plugins-empty">
        <div className="plugins-empty-icon" aria-hidden="true">
          <Loader2 size={28} className="t-spin" />
        </div>
        <p className="plugins-empty-title">{t('plugins.connecting')}</p>
        <p className="plugins-empty-body">{t('plugins.empty')}</p>
      </div>
    </div>
  )
}
