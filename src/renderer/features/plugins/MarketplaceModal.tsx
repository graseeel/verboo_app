import { Loader2, Plus, ShieldCheck, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import type { Marketplace, PluginError } from '../../../shared/plugins'
import { describePluginError } from '../../../shared/plugins'
import { useI18n } from '../../i18n'

type MarketplaceModalProps = {
  marketplaces: Marketplace[]
  onAdd: (source: string, scope?: string) => Promise<void>
  onRemove: (name: string) => Promise<void>
  onClose: () => void
}

const TRUSTED_MARKETPLACES = new Set(['claude-plugins-official', 'verboo-plugins'])

function trustLevel(name: string): 'official' | 'community' {
  return TRUSTED_MARKETPLACES.has(name) ? 'official' : 'community'
}

// Marketplace management modal: list configured marketplaces with trust
// badges, add a new source (URL / GitHub owner/repo / local path), and remove
// with a confirm step. Adding/removing triggers a re-fetch of available
// plugins in the parent hook.
export function MarketplaceModal({ marketplaces, onAdd, onRemove, onClose }: MarketplaceModalProps) {
  const { t } = useI18n()
  const [source, setSource] = useState('')
  const [adding, setAdding] = useState(false)
  const [removingName, setRemovingName] = useState<string | undefined>(undefined)
  const [confirmRemove, setConfirmRemove] = useState<Marketplace | undefined>(undefined)
  const [error, setError] = useState<PluginError | undefined>(undefined)

  async function handleAdd() {
    const trimmed = source.trim()
    if (!trimmed) return
    setAdding(true)
    setError(undefined)
    try {
      await onAdd(trimmed)
      setSource('')
    } catch (err) {
      setError(err as PluginError)
    } finally {
      setAdding(false)
    }
  }

  async function handleRemove(name: string) {
    setRemovingName(name)
    setError(undefined)
    try {
      await onRemove(name)
      setConfirmRemove(undefined)
    } catch (err) {
      setError(err as PluginError)
    } finally {
      setRemovingName(undefined)
    }
  }

  return (
    <div className="modal-backdrop palette-backdrop" onPointerDown={event => event.target === event.currentTarget && onClose()}>
      <div className="t-modal is-open marketplace-modal" role="dialog" aria-modal="true" aria-label={t('plugins.marketplaces')}>
        <div className="marketplace-modal-head">
          <h2>{t('plugins.marketplaces')}</h2>
          <button type="button" className="marketplace-modal-close" onClick={onClose} aria-label={t('common.close')}>
            <X size={16} />
          </button>
        </div>

        <div className="marketplace-add-row">
          <input
            className="marketplace-add-input"
            value={source}
            onChange={event => setSource(event.target.value)}
            placeholder={t('plugins.addPlaceholder')}
            disabled={adding}
            onKeyDown={event => { if (event.key === 'Enter' && !adding) void handleAdd() }}
          />
          <button type="button" className="primary-button" onClick={handleAdd} disabled={adding || !source.trim()}>
            {adding ? <Loader2 size={14} className="t-spin" /> : <Plus size={14} />}
            {t('plugins.add')}
          </button>
        </div>
        <p className="marketplace-add-hint">{t('plugins.addHint')}</p>

        {error && <div className="marketplace-error">{describePluginError(error)}</div>}

        <div className="marketplace-list">
          {marketplaces.length === 0 ? (
            <p className="marketplace-empty">{t('plugins.noMarketplaces')}</p>
          ) : (
            marketplaces.map(market => {
              const trust = trustLevel(market.name)
              const isRemoving = removingName === market.name
              return (
                <div key={market.name} className="marketplace-row">
                  <div className="marketplace-row-info">
                    <span className="marketplace-row-name">{market.name}</span>
                    <span className="marketplace-row-source">
                      {market.repo ?? market.url ?? market.source}
                    </span>
                  </div>
                  {trust === 'official' && (
                    <span className="plugin-trust-badge plugin-trust-badge--official">
                      <ShieldCheck size={11} />
                      {t('plugins.trust.official')}
                    </span>
                  )}
                  <button
                    type="button"
                    className="marketplace-row-remove"
                    onClick={() => setConfirmRemove(market)}
                    disabled={isRemoving}
                    aria-label={t('plugins.remove')}
                  >
                    {isRemoving ? <Loader2 size={14} className="t-spin" /> : <Trash2 size={14} />}
                  </button>
                </div>
              )
            })
          )}
        </div>

        {confirmRemove && (
          <div className="modal-backdrop palette-backdrop marketplace-confirm-overlay" onPointerDown={event => event.target === event.currentTarget && setConfirmRemove(undefined)}>
            <div className="t-modal is-open marketplace-confirm" role="dialog" aria-modal="true">
              <h3>{t('plugins.removeConfirmTitle')}</h3>
              <p>{t('plugins.removeConfirmBody', { name: confirmRemove.name })}</p>
              <div className="marketplace-confirm-actions">
                <button type="button" className="ghost-button" onClick={() => setConfirmRemove(undefined)}>
                  {t('common.cancel')}
                </button>
                <button type="button" className="danger-button" onClick={() => void handleRemove(confirmRemove.name)}>
                  {t('plugins.remove')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
