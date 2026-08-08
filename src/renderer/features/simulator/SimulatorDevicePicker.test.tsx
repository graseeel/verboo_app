import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../i18n'
import type { IosSimulatorDevice } from './iosSimulatorApi'
import { SimulatorDevicePicker } from './SimulatorDevicePicker'

function phone(name: string, state: string, iosVersion: string, udid = name.toLowerCase().replaceAll(' ', '-')): IosSimulatorDevice {
  return { name, udid, state, iosVersion, family: 'iphone' }
}

function ipad(name: string, state: string, iosVersion: string, udid = name.toLowerCase().replaceAll(' ', '-')): IosSimulatorDevice {
  return { name, udid, state, iosVersion, family: 'ipad' }
}

function renderPicker(
  devices: IosSimulatorDevice[],
  overrides: Partial<React.ComponentProps<typeof SimulatorDevicePicker>> = {},
) {
  const props: React.ComponentProps<typeof SimulatorDevicePicker> = {
    devices,
    selectedUdid: undefined,
    busyUdid: undefined,
    onSelect: vi.fn(),
    ...overrides,
  }
  return {
    ...render(
      <I18nProvider language="pt-BR">
        <SimulatorDevicePicker {...props} />
      </I18nProvider>,
    ),
    props,
  }
}

describe('SimulatorDevicePicker', () => {
  it('filters by family and query while keeping booted devices first', () => {
    renderPicker([
      phone('iPhone 17 Pro', 'Shutdown', '27.0'),
      ipad('iPad Pro 13-inch', 'Booted', '26.5'),
      phone('iPhone Air', 'Booted', '26.5'),
    ])

    fireEvent.click(screen.getByRole('button', { name: 'iPhone' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Buscar simulador' }), {
      target: { value: '26.5' },
    })

    expect(screen.getAllByRole('option').map(option => option.textContent))
      .toEqual(['iPhone Air26.5 · ligado'])
  })

  it('supports arrows, Enter, Escape, and deterministic focus return', () => {
    const onSelect = vi.fn()
    renderPicker([
      phone('iPhone Air', 'Booted', '26.5'),
      phone('iPhone 17 Pro', 'Shutdown', '27.0'),
    ], { onSelect })
    const combo = screen.getByRole('combobox', { name: 'Buscar simulador' })

    fireEvent.focus(combo)
    fireEvent.keyDown(combo, { key: 'ArrowDown' })
    fireEvent.keyDown(combo, { key: 'ArrowDown' })
    fireEvent.keyDown(combo, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith('iphone-17-pro')
    expect(combo).toHaveFocus()
    fireEvent.focus(combo)
    fireEvent.keyDown(combo, { key: 'Escape' })
    expect(combo).toHaveAttribute('aria-expanded', 'false')
  })

  it('selects the clicked option and reports its udid', () => {
    const onSelect = vi.fn()
    renderPicker([
      phone('iPhone Air', 'Booted', '26.5'),
      phone('iPhone 17 Pro', 'Shutdown', '27.0'),
    ], { onSelect })
    const combo = screen.getByRole('combobox', { name: 'Buscar simulador' })

    fireEvent.focus(combo)
    fireEvent.click(screen.getByRole('option', { name: /iPhone 17 Pro/ }))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('iphone-17-pro')
  })

  it('points aria-activedescendant to the real highlighted option after ArrowDown', () => {
    renderPicker([
      phone('iPhone Air', 'Booted', '26.5'),
      phone('iPhone 17 Pro', 'Shutdown', '27.0'),
    ])
    const combo = screen.getByRole('combobox', { name: 'Buscar simulador' })

    fireEvent.focus(combo)
    const firstOption = screen.getAllByRole('option')[0]
    const realOptionId = firstOption.id
    expect(realOptionId).not.toBe('')
    fireEvent.keyDown(combo, { key: 'ArrowDown' })

    expect(combo).toHaveAttribute('aria-activedescendant', realOptionId)
  })

  it('moves the real highlighted option backward with ArrowUp', () => {
    renderPicker([
      phone('iPhone Air', 'Booted', '26.5'),
      phone('iPhone 17 Pro', 'Shutdown', '27.0'),
      phone('iPhone SE', 'Shutdown', '26.0'),
    ])
    const combo = screen.getByRole('combobox', { name: 'Buscar simulador' })

    fireEvent.focus(combo)
    const options = screen.getAllByRole('option')
    const firstOptionId = options[0].id
    fireEvent.keyDown(combo, { key: 'ArrowDown' })
    fireEvent.keyDown(combo, { key: 'ArrowDown' })
    fireEvent.keyDown(combo, { key: 'ArrowUp' })

    expect(combo).toHaveAttribute('aria-activedescendant', firstOptionId)
  })

  it('shows the single controlled selection while collapsed', () => {
    renderPicker([
      phone('iPhone Air', 'Booted', '26.5'),
      phone('iPhone 17 Pro', 'Shutdown', '27.0'),
    ], { selectedUdid: 'iphone-17-pro' })

    expect(screen.getByRole('combobox', { name: 'Buscar simulador' }))
      .toHaveValue('iPhone 17 Pro')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
