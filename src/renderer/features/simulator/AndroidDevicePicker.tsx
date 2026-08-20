import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n'
import { groupAndroidEmulatorDevices, type AndroidDeviceFamilyFilter } from './androidEmulatorModel'
import type { AndroidDevice } from './androidEmulatorApi'

/**
 * Android device picker (PA-27, contract `contrato-android-simulator` —
 * AndroidDevice { avdName, displayName, apiLevel, family, running }).
 *
 * Mirrors SimulatorDevicePicker (combobox + portal listbox + family filters +
 * arrow/Enter/Escape keyboard navigation) on the Android shape: groups are
 * running devices first, then family + descending apiLevel. Selection reports
 * the frozen `avdName` (the attach command's key).
 */

type AndroidDevicePickerProps = {
  devices: readonly AndroidDevice[]
  selectedAvd?: string
  busyAvd?: string
  compact?: boolean
  onSelect: (avdName: string) => void
}

export function AndroidDevicePicker({
  devices,
  selectedAvd,
  busyAvd,
  compact = false,
  onSelect,
}: AndroidDevicePickerProps) {
  const { t } = useI18n()
  const pickerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const suppressFocusOpenRef = useRef(false)
  const listboxId = `android-device-listbox-${useId().replaceAll(':', '')}`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<AndroidDeviceFamilyFilter>('all')
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const [listboxStyle, setListboxStyle] = useState<React.CSSProperties>({})
  const selectedDevice = devices.find(device => device.avdName === selectedAvd)
  const groups = groupAndroidEmulatorDevices(devices, filter, query)
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
    if (key === 'running') return t('androidEmulator.picker.groupRunning')
    const [family, apiLevel] = key.split(':')
    return `${t(`androidEmulator.family.${family}`)} · API ${apiLevel}`
  }

  const filterControls = (
    <div className="simulator-device-filters" aria-label={t('simulator.filter.label')}>
      {(['all', 'phone', 'tablet'] as const).map(value => (
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
          {value === 'all' ? t('simulator.filter.all') : t(`androidEmulator.family.${value}`)}
        </button>
      ))}
    </div>
  )

  function choose(avdName: string) {
    onSelect(avdName)
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
      choose(activeDevice.avdName)
    }
  }

  return (
    <div ref={pickerRef} className={`simulator-device-picker ${compact ? 'is-compact' : ''}`}>
      {!compact && filterControls}
      <input
        ref={inputRef}
        role="combobox"
        aria-label={t('androidEmulator.picker.search')}
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeDevice ? `${listboxId}-${activeDevice.avdName}` : undefined}
        data-panel-placement={compact ? 'top' : undefined}
        value={open ? query : selectedDevice?.displayName ?? ''}
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
          aria-label={t('androidEmulator.picker.search')}
          style={listboxStyle}
        >
          {compact && filterControls}
          {groups.map(group => (
            <div role="group" aria-label={groupLabel(group.key)} key={group.key}>
              {group.devices.map(device => {
                const optionIndex = visibleDevices.findIndex(item => item.avdName === device.avdName)
                return (
                  <button
                    id={`${listboxId}-${device.avdName}`}
                    key={device.avdName}
                    type="button"
                    role="option"
                    aria-selected={device.avdName === selectedAvd}
                    aria-posinset={optionIndex + 1}
                    aria-setsize={visibleDevices.length}
                    disabled={Boolean(busyAvd)}
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => choose(device.avdName)}
                  >
                    <strong>{device.displayName}</strong>
                    <span>
                      API {device.apiLevel} · {t(device.running
                        ? 'androidEmulator.device.running'
                        : 'androidEmulator.device.stopped')}
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
