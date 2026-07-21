import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useRef, useState } from 'react'

// Fase 0 spike harness (ADR-0001). Throwaway: only mounts when the backend
// reports VERBOO_BROWSER_SPIKE=1. Drives the child-webview commands and
// prints the acceptance-criteria evidence on screen so the run can be
// verified visually (screenshot) without devtools.

type SnapshotReport = { ms: number; bytes: number; path: string }
type EvalReport = { ms: number; value: string }

const PANEL_TOP = 48
const PANEL_BOTTOM_GAP = 96
const PANEL_WIDTH = 640

function dockRect(width = PANEL_WIDTH) {
  return {
    x: Math.max(0, window.innerWidth - width - 12),
    y: PANEL_TOP,
    width,
    height: Math.max(200, window.innerHeight - PANEL_TOP - PANEL_BOTTOM_GAP),
  }
}

export function BrowserSpikePanel() {
  // Self-gating: renders nothing unless the backend was launched with
  // VERBOO_BROWSER_SPIKE=1, so mounting unconditionally in App is harmless.
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    void invoke<boolean>('browser_spike_enabled')
      .then(setEnabled)
      .catch(() => setEnabled(false))
  }, [])
  if (!enabled) return null
  return <BrowserSpikeInner />
}

function BrowserSpikeInner() {
  const [log, setLog] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [url, setUrl] = useState('https://example.com')
  const aliveRef = useRef(false)

  const append = useCallback((line: string) => {
    setLog(previous => [...previous.slice(-40), line])
  }, [])

  const create = useCallback(async (target: string) => {
    const rect = dockRect()
    const label = await invoke<string>('browser_create', { ...rect, url: target })
    aliveRef.current = true
    return label
  }, [])

  // Keep bounds glued to the simulated dock rect on window resize
  // (criterion 2, window-resize leg).
  useEffect(() => {
    function onResize() {
      if (!aliveRef.current) return
      void invoke('browser_set_bounds', dockRect()).catch(() => {})
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const runSequence = useCallback(async () => {
    if (running) return
    setRunning(true)
    setLog([])
    const t0 = performance.now()
    const stamp = () => `[${((performance.now() - t0) / 1000).toFixed(1)}s]`
    try {
      append(`${stamp()} criando webview → ${url}`)
      const label = await create(url)
      append(`${stamp()} criada: ${label} (perfil incognito)`)

      await new Promise(resolve => setTimeout(resolve, 2500))

      for (let i = 1; i <= 3; i += 1) {
        try {
          const r = await invoke<EvalReport>('browser_eval_roundtrip')
          append(`${stamp()} eval #${i}: ${r.ms}ms → ${r.value.slice(0, 60)}`)
        } catch (error) {
          append(`${stamp()} eval #${i} FALHOU: ${String(error)}`)
        }
      }

      for (let i = 1; i <= 3; i += 1) {
        try {
          const r = await invoke<SnapshotReport>('browser_snapshot')
          const pass = r.ms <= 100 ? 'PASS' : 'LENTO'
          append(`${stamp()} snapshot #${i}: ${r.ms}ms, ${(r.bytes / 1024).toFixed(0)}KB [${pass}] → ${r.path}`)
        } catch (error) {
          append(`${stamp()} snapshot #${i} FALHOU: ${String(error)}`)
        }
      }

      const messages = await invoke<string[]>('browser_poll_messages')
      append(`${stamp()} mensagens da página: ${messages.length ? messages.join(' | ').slice(0, 80) : 'NENHUMA (FALHA critério 6)'}`)

      append(`${stamp()} animando bounds (2s, 40 passos)…`)
      const base = dockRect()
      for (let step = 0; step < 40; step += 1) {
        const width = base.width + Math.round(Math.sin((step / 40) * Math.PI * 2) * 160)
        await invoke('browser_set_bounds', { ...dockRect(width), width })
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      await invoke('browser_set_bounds', dockRect())
      append(`${stamp()} animação concluída`)

      append(`${stamp()} ciclo criar/destruir ×3 (fumaça de vazamento)…`)
      for (let i = 1; i <= 3; i += 1) {
        await invoke('browser_destroy')
        aliveRef.current = false
        const cycleLabel = await create(url)
        append(`${stamp()} ciclo ${i}: ok (${cycleLabel})`)
      }

      append(`${stamp()} SEQUÊNCIA COMPLETA — webview viva para teste manual (digite/role/clique na página)`)
    } catch (error) {
      append(`ERRO FATAL: ${String(error)}`)
    } finally {
      setRunning(false)
    }
  }, [append, create, running, url])

  useEffect(() => {
    void runSequence()
    return () => {
      aliveRef.current = false
      void invoke('browser_destroy').catch(() => {})
    }
    // Run exactly once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      style={{
        position: 'fixed',
        left: 12,
        top: PANEL_TOP,
        width: 420,
        maxHeight: '75vh',
        overflow: 'auto',
        zIndex: 9999,
        background: 'rgba(13,15,24,.97)',
        border: '1px solid rgba(147,85,255,.5)',
        borderRadius: 10,
        padding: 12,
        font: '11px ui-monospace, monospace',
        color: '#eef1ff',
      }}
    >
      <strong style={{ color: '#a96dff' }}>SPIKE Fase 0 — navegador embutido</strong>
      <div style={{ display: 'flex', gap: 6, margin: '8px 0' }}>
        <input
          value={url}
          onChange={event => setUrl(event.target.value)}
          style={{ flex: 1, background: '#1d2030', color: '#eef1ff', border: '1px solid #333', borderRadius: 6, padding: '4px 8px' }}
        />
        <button type="button" disabled={running} onClick={() => void invoke('browser_navigate', { url }).catch((e: unknown) => append(String(e)))}>Ir</button>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <button type="button" disabled={running} onClick={() => void runSequence()}>Rodar sequência</button>
        <button type="button" onClick={() => void invoke('browser_destroy').then(() => { aliveRef.current = false; append('destruída') })}>Destruir</button>
        <button type="button" onClick={() => void create(url).then(l => append(`criada ${l}`)).catch((e: unknown) => append(String(e)))}>Criar</button>
        <button type="button" onClick={() => void invoke<SnapshotReport>('browser_snapshot').then(r => append(`snapshot: ${r.ms}ms ${(r.bytes / 1024).toFixed(0)}KB`)).catch((e: unknown) => append(String(e)))}>Snapshot</button>
        <button type="button" onClick={() => void invoke<string[]>('browser_poll_messages').then(m => append(`msgs: ${m.join(' | ') || '(vazio)'}`))}>Mensagens</button>
      </div>
      {log.map((line, index) => (
        <div key={index} style={{ whiteSpace: 'pre-wrap', borderTop: '1px solid rgba(177,185,225,.08)', padding: '2px 0' }}>{line}</div>
      ))}
    </div>
  )
}
