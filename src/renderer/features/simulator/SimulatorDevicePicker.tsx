import { useId, useRef, useState } from 'react'
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
  const inputRef = useRef<HTMLInputElement | null>(null)
  const suppressFocusOpenRef = useRef(false)
  const listboxId = `simulator-device-listbox-${useId().replaceAll(':', '')}`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<DeviceFamilyFilter>('all')
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const selectedDevice = devices.find(device => device.udid === selectedUdid)
  const groups = groupSimulatorDevices(devices, filter, query)
  const visibleDevices = groups.flatMap(group => group.devices)
  const activeDevice = visibleDevices[highlightedIndex]

  const groupLabel = (key: string) => {
    if (key === 'booted') return t('simulator.group.booted')
    const [family, version] = key.split(':')
    const familyLabel = family === 'ipad'
      ? t('simulator.filter.ipad')
      : t('simulator.filter.iphone')
    return `${familyLabel} · ${version}`
  }

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
    <div className={`simulator-device-picker ${compact ? 'is-compact' : ''}`}>
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
      <input
        ref={inputRef}
        role="combobox"
        aria-label={t('simulator.search')}
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeDevice ? `${listboxId}-${activeDevice.udid}` : undefined}
        value={open ? query : selectedDevice?.name ?? ''}
        onFocus={() => {
          if (suppressFocusOpenRef.current) {
            suppressFocusOpenRef.current = false
            return
          }
          setOpen(true)
        }}
        onChange={event => {
          setQuery(event.target.value)
          setOpen(true)
          setHighlightedIndex(-1)
        }}
        onKeyDown={handleKeyDown}
      />
      {open && (
        <div id={listboxId} role="listbox" aria-label={t('simulator.search')}>
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
                    <span>{device.iosVersion} · {t(formatSimulatorState(device.state))}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
