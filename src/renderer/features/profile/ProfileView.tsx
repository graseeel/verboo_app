import { ArrowUpRight, RefreshCw, ShieldCheck } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { ProfileActivityDay, ProfileResult } from '../../../shared/types'

type ProfileViewProps = {
  profile: ProfileResult
  loading: boolean
  onRefresh: () => void
  onManagePlan: () => void
}

export function ProfileView({ profile, loading, onRefresh, onManagePlan }: ProfileViewProps) {
  const summary = profile.summary
  const activity = profile.activity ?? []

  return (
    <div className="profile-view page-surface">
      <header className="view-heading">
        <div>
          <h1>Perfil</h1>
          <p>Atividade, consumo e plano carregados diretamente da conta Verboo.</p>
        </div>
        <button className="ghost-button" type="button" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={15} />
          {loading ? 'Atualizando' : 'Atualizar'}
        </button>
      </header>

      {profile.status !== 'ready' && (
        <section className="profile-warning">
          <ShieldCheck size={17} />
          <span>{profile.error ?? 'Entre com Verboo ou adicione sua chave de API nas configurações para carregar dados reais.'}</span>
        </section>
      )}

      {profile.error && profile.status === 'ready' && (
        <section className="profile-warning subtle">
          <span>{profile.error}</span>
        </section>
      )}

      <section className="profile-grid">
        <MetricCard label="Tokens totais" value={formatOptional(summary?.totalTokens)} />
        <MetricCard label="Entrada" value={formatOptional(summary?.tokensInTotal)} />
        <MetricCard label="Saída" value={formatOptional(summary?.tokensOutTotal)} />
        <MetricCard label="Requisições" value={formatOptional(summary?.reqTotal)} />
      </section>

      <section className="profile-panel">
        <div className="panel-heading">
          <div>
            <h2>Dias de atividade</h2>
            <p>{activity.length ? `${profile.activeDays ?? 0} dias ativos retornados pela API` : 'Dados de atividade indisponíveis'}</p>
          </div>
        </div>
        <ActivityHeatmap days={activity} />
      </section>

      <section className="profile-panel plan-panel">
        <div>
          <h2>{profile.plan?.name ?? 'Plano indisponível'}</h2>
          <p>{profile.plan?.status ? `Status: ${profile.plan.status}` : 'O plano será exibido quando a API retornar a assinatura atual.'}</p>
          {profile.plan?.priceLabel && <strong>{profile.plan.priceLabel}</strong>}
          {profile.plan?.models?.length && (
            <p className="plan-models">{profile.plan.models.slice(0, 8).join(', ')}</p>
          )}
        </div>
        <button className="primary-action" type="button" onClick={onManagePlan}>
          Gerenciar plano
          <ArrowUpRight size={15} />
        </button>
      </section>
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}

function ActivityHeatmap({ days }: { days: ProfileActivityDay[] }) {
  if (!days.length) {
    return <div className="heatmap-empty">Nenhum valor real retornado para este período.</div>
  }

  const max = Math.max(...days.map(day => day.count), 1)
  return (
    <div className="heatmap" aria-label="Atividade por dia">
      {days.slice(-365).map(day => (
        <span
          key={day.date}
          className="heatmap-cell"
          title={`${day.date}: ${formatOptional(day.count)} requisições`}
          style={{ '--intensity': String(Math.max(0.12, day.count / max)) } as CSSProperties}
        />
      ))}
    </div>
  )
}

function formatOptional(value: number | undefined): string {
  if (value === undefined) return 'Indisponível'
  return Intl.NumberFormat('pt-BR', {
    notation: value >= 100_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value)
}
