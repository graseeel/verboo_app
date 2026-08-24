import { useEffect, useRef } from 'react'
import { createRgbWebglPainter, type RgbPaintPush } from './androidWebglPreview'
type AndroidPreviewCanvasProps = {
  ariaLabel: string
  onPushReady: (push: RgbPaintPush | null) => void
  onTerminalFailure: () => void
}
/** Folha dona do painter WebGL: cria no mount, registra o push, aplica a
 *  política ÚNICA de context loss e libera tudo no unmount. Zero state React. */
export function AndroidPreviewCanvas({ ariaLabel, onPushReady, onTerminalFailure }: AndroidPreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    let disposed = false
    const handlers = createRgbWebglPainter(canvas, {
      onTerminalFailure: () => {
        if (!disposed) onTerminalFailure()
      },
    })
    onPushReady(frame => handlers.painter.draw(frame))
    canvas.addEventListener('webglcontextlost', handlers.handleContextLost)
    canvas.addEventListener('webglcontextrestored', handlers.handleContextRestored)
    return () => {
      disposed = true
      canvas.removeEventListener('webglcontextlost', handlers.handleContextLost)
      canvas.removeEventListener('webglcontextrestored', handlers.handleContextRestored)
      handlers.painter.dispose()
      onPushReady(null)
    }
  }, [onPushReady, onTerminalFailure])
  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={ariaLabel}
      style={{ position: 'absolute', top: 0, left: 0 }}
    />
  )
}
