import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
} from 'react'
import { createPortal } from 'react-dom'

const HOVER_DELAY_MS = 450

type TooltipPosition = {
  left: number
  top: number
  placement: 'top' | 'bottom'
}

type SimulatorTooltipButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
}

export const SimulatorTooltipButton = forwardRef<HTMLButtonElement, SimulatorTooltipButtonProps>(
  function SimulatorTooltipButton({ label, children, 'aria-describedby': describedBy, ...buttonProps }, forwardedRef) {
    const buttonRef = useRef<HTMLButtonElement | null>(null)
    const hoverTimerRef = useRef<number | undefined>(undefined)
    const tooltipId = useId()
    const [visible, setVisible] = useState(false)
    const [position, setPosition] = useState<TooltipPosition>({ left: 0, top: 0, placement: 'top' })

    const setButtonRef = useCallback((node: HTMLButtonElement | null) => {
      buttonRef.current = node
      if (typeof forwardedRef === 'function') forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
    }, [forwardedRef])

    const clearHoverTimer = useCallback(() => {
      if (hoverTimerRef.current === undefined) return
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = undefined
    }, [])

    const updatePosition = useCallback(() => {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (!rect) return
      const placement = rect.top >= 56 ? 'top' : 'bottom'
      setPosition({
        left: Math.max(72, Math.min(window.innerWidth - 72, rect.left + rect.width / 2)),
        top: placement === 'top' ? rect.top - 8 : rect.bottom + 8,
        placement,
      })
    }, [])

    const show = useCallback(() => {
      clearHoverTimer()
      updatePosition()
      setVisible(true)
    }, [clearHoverTimer, updatePosition])

    const hide = useCallback(() => {
      clearHoverTimer()
      setVisible(false)
    }, [clearHoverTimer])

    const scheduleShow = useCallback(() => {
      clearHoverTimer()
      hoverTimerRef.current = window.setTimeout(show, HOVER_DELAY_MS)
    }, [clearHoverTimer, show])

    useEffect(() => clearHoverTimer, [clearHoverTimer])

    useEffect(() => {
      if (!visible) return
      const handleEscape = (event: KeyboardEvent) => {
        if (event.key === 'Escape') hide()
      }
      window.addEventListener('resize', updatePosition)
      window.addEventListener('scroll', updatePosition, true)
      document.addEventListener('keydown', handleEscape)
      return () => {
        window.removeEventListener('resize', updatePosition)
        window.removeEventListener('scroll', updatePosition, true)
        document.removeEventListener('keydown', handleEscape)
      }
    }, [hide, updatePosition, visible])

    const tooltipStyle = {
      '--simulator-tooltip-left': `${position.left}px`,
      '--simulator-tooltip-top': `${position.top}px`,
    } as CSSProperties
    const accessibleDescription = visible
      ? [describedBy, tooltipId].filter(Boolean).join(' ')
      : describedBy

    return (
      <span
        className="simulator-tooltip-trigger"
        onPointerEnter={scheduleShow}
        onPointerLeave={hide}
        onFocusCapture={show}
        onBlurCapture={hide}
      >
        <button
          {...buttonProps}
          ref={setButtonRef}
          aria-label={buttonProps['aria-label'] ?? label}
          aria-describedby={accessibleDescription}
        >
          {children}
        </button>
        {visible && createPortal(
          <span
            id={tooltipId}
            role="tooltip"
            className="simulator-tooltip-bubble"
            data-placement={position.placement}
            style={tooltipStyle}
          >
            {label}
          </span>,
          document.body,
        )}
      </span>
    )
  },
)
