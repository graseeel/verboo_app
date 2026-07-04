import React from 'react'
import { createRoot } from 'react-dom/client'
import 'slot-text/style.css'
import { App } from './App'
import { ToastProvider } from './components/Toast'
import './styles/app.css'

type ErrorBoundaryState = {
  error?: Error
}

class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = {}

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('Renderer failed to mount', error)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <main className="fatal-render-error">
          <div>
            <strong>O Verboo Code encontrou um erro ao abrir.</strong>
            <span>Reinicie o app. Se continuar, envie este detalhe: {this.state.error.message}</span>
          </div>
        </main>
      )
    }

    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
