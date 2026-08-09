import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n'
import { formatSimulatorState, groupSimulatorDevices, type DeviceFamilyFilter } from './iosSimulatorModel'
import type { IosSimulatorDevice } from './iosSimulatorApi'

type SimulatorDevicePickerProps = {
  devices: readonly IosSimulatorDevice[]
  selectedUdid?: string
  busyUdid?: string
  compact?: boolean
  onSelect: (udid: string) => void
}

export function SimulatorDevicePicker({
  devices,
  selectedUdid,
  busyUdid,
  compact = false,
  onSelect,
}: SimulatorDevicePickerProps) {
  const { t } = useI18n()
  const pickerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const suppressFocusOpenRef = useRef(false)
  const listboxId = `simulator-device-listbox-${useId().replaceAll(':', '')}`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<DeviceFamilyFilter>('all')
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const [listboxStyle, setListboxStyle] = useState<React.CSSProperties>({})
  const selectedDevice = devices.find(device => device.udid === selectedUdid)
  const groups = groupSimulatorDevices(devices, filter, query)
  const visibleDevices = groups.flatMap(group => group.devices)
  const activeDevice = visibleDevices[highlightedIndex]

  useLayoutEffect(() => {
    if (!open) return
    const updatePosition = () => {
      const rect = inputRef.current?.getBoundingClientRect()
      if (!rect) return
      const viewportHeight = window.innerHeight || 800
      const below = viewportHeight - rect.bottom - 10
      const above = rect.top - 10
      const openAbove = below < 180 && above > below
      const maxHeight = Math.max(140, Math.min(320, openAbove ? above : below))
      setListboxStyle({
        position: 'fixed',
        left: rect.left,
        width: rect.width,
        maxHeight,
        ...(openAbove
          ? { bottom: viewportHeight - rect.top + 4 }
          : { top: rect.bottom + 4 }),
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node | null
      const listbox = document.getElementById(listboxId)
      if (target && (pickerRef.current?.contains(target) || listbox?.contains(target))) return
      setOpen(false)
      setHighlightedIndex(-1)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [listboxId, open])

  const groupLabel = (key: string) => {
    if (key === 'booted') return t('simulator.group.booted')
    const [family, version] = key.split(':')
    const familyLabel = family === 'ipad'
      ? t('simulator.filter.ipad')
      : t('simulator.filter.iphone')
    return `${familyLabel} · ${version}`
  }

  const filterControls = (
    <div className="simulator-device-filters" aria-label={t('simulator.filter.label')}>
      {(['all', 'iphone', 'ipad'] as const).map(value => (
        <button
          key={value}
          type="button"
          aria-pressed={filter === value}
          onClick={() => {
            setFilter(value)
            setOpen(true)
            setHighlightedIndex(-1)
          }}
        >
          {t(`simulator.filter.${value}`)}
        </button>
      ))}
    </div>
  )

  function choose(udid: string) {
    onSelect(udid)
    setQuery('')
    setOpen(false)
    setHighlightedIndex(-1)
    suppressFocusOpenRef.current = true
    inputRef.current?.focus()
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      setHighlightedIndex(-1)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!visibleDevices.length) return
      setOpen(true)
      setHighlightedIndex(current => {
        const next = event.key === 'ArrowDown' ? current + 1 : current - 1
        return (next + visibleDevices.length) % visibleDevices.length
      })
      return
    }
    if (event.key === 'Enter' && activeDevice) {
      event.preventDefault()
      choose(activeDevice.udid)
    }
  }

  return (
    <div ref={pickerRef} className={`simulator-device-picker ${compact ? 'is-compact' : ''}`}>
      {!compact && filterControls}
      <input
        ref={inputRef}
        role="combobox"
        aria-label={t('simulator.search')}
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeDevice ? `${listboxId}-${activeDevice.udid}` : undefined}
        data-panel-placement={compact ? 'top' : undefined}
        value={open ? query : selectedDevice?.name ?? ''}
        onFocus={() => {
          if (suppressFocusOpenRef.current) {
            suppressFocusOpenRef.current = false
            return
          }
          setOpen(true)
        }}
        onClick={() => {
          suppressFocusOpenRef.current = false
          setOpen(true)
        }}
        onChange={event => {
          setQuery(event.target.value)
          setOpen(true)
          setHighlightedIndex(-1)
        }}
        onKeyDown={handleKeyDown}
      />
      {open && createPortal(
        <div
          id={listboxId}
          className="simulator-device-listbox"
          role="listbox"
          aria-label={t('simulator.search')}
          style={listboxStyle}
        >
          {compact && filterControls}
          {groups.map(group => (
            <div role="group" aria-label={groupLabel(group.key)} key={group.key}>
              {group.devices.map(device => {
                const optionIndex = visibleDevices.findIndex(item => item.udid === device.udid)
                return (
                  <button
                    id={`${listboxId}-${device.udid}`}
                    key={device.udid}
                    type="button"
                    role="option"
                    aria-selected={device.udid === selectedUdid}
                    aria-posinset={optionIndex + 1}
                    aria-setsize={visibleDevices.length}
                    disabled={Boolean(busyUdid)}
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => choose(device.udid)}
                  >
                    <strong>{device.name}</strong>
                    <span>
                      {device.iosVersion} · {t(formatSimulatorState(device.state))}
                      {device.ownership && (
                        <em className={`simulator-device-origin is-${device.ownership}`}>
                          {t(`simulator.origin.${device.ownership}`)}
                        </em>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
