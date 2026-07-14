import { Download, Loader2, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import type { AvailablePlugin, PluginError, PluginScope } from '../../../shared/plugins'
import { describePluginError } from '../../../shared/plugins'
import { useI18n } from '../../i18n'

type PluginInstallModalProps = {
  plugin: AvailablePlugin
  onConfirm: (scope: PluginScope) => Promise<void>
  onClose: () => void
}

// Install confirmation modal. Shows plugin name, marketplace, description,
// and a scope selector (user / project / local, default user). The trust
// badge is derived from the marketplace name — a known-good list marks
// "official" marketplaces; everything else is "community".
const TRUSTED_MARKETPLACES = new Set(['claude-plugins-official', 'verboo-plugins'])

function trustLevel(marketplaceName: string): 'official' | 'community' {
  return TRUSTED_MARKETPLACES.has(marketplaceName) ? 'official' : 'community'
}

export function PluginInstallModal({ plugin, onConfirm, onClose }: PluginInstallModalProps) {
  const { t } = useI18n()
  const [scope, setScope] = useState<PluginScope>('user')
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<PluginError | undefined>(undefined)
  const trust = trustLevel(plugin.marketplaceName)

  async function handleConfirm() {
    setInstalling(true)
    setError(undefined)
    try {
      await onConfirm(scope)
      onClose()
    } catch (err) {
      setError(err as PluginError)
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="modal-backdrop palette-backdrop" onPointerDown={event => event.target === event.currentTarget && !installing && onClose()}>
      <div className="t-modal is-open plugin-install-modal" role="dialog" aria-modal="true" aria-label={t('plugins.installTitle', { name: plugin.name })}>
        <div className="plugin-install-head">
          <div className="plugin-install-icon">
            <Download size={18} />
          </div>
          <div>
            <h2 className="plugin-install-name">{plugin.name}</h2>
            <p className="plugin-install-marketplace">{plugin.marketplaceName}</p>
          </div>
          {trust === 'official' && (
            <span className="plugin-trust-badge plugin-trust-badge--official">
              <ShieldCheck size={12} />
              {t('plugins.trust.official')}
            </span>
          )}
        </div>

        <p className="plugin-install-desc">{plugin.description}</p>

        <div className="plugin-install-scope">
          <label className="plugin-install-scope-label">{t('plugins.scopeLabel')}</label>
          <div className="plugin-install-scope-options">
            {(['user', 'project', 'local'] as const).map(s => (
              <button
                key={s}
                type="button"
                className={`plugin-scope-option ${scope === s ? 'is-active' : ''}`}
                onClick={() => setScope(s)}
                disabled={installing}
              >
                {t(`plugins.scope.${s}`)}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="plugin-install-error">
            {describePluginError(error)}
          </div>
        )}

        <div className="plugin-install-actions">
          <button type="button" className="ghost-button" onClick={onClose} disabled={installing}>
            {t('common.cancel')}
          </button>
          <button type="button" className="primary-button" onClick={handleConfirm} disabled={installing}>
            {installing ? <Loader2 size={14} className="t-spin" /> : <Download size={14} />}
            {t('plugins.install')}
          </button>
        </div>
      </div>
    </div>
  )
}
