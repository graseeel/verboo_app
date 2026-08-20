import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../i18n'
import type { AndroidDevice } from './androidEmulatorApi'
import { AndroidDevicePicker } from './AndroidDevicePicker'

function phone(displayName: string, apiLevel: number, running = false): AndroidDevice {
  return {
    avdName: displayName.replaceAll(' ', '_'),
    displayName,
    apiLevel,
    family: 'phone',
    running,
  }
}

function tablet(displayName: string, apiLevel: number, running = false): AndroidDevice {
  return {
    avdName: displayName.replaceAll(' ', '_'),
    displayName,
    apiLevel,
    family: 'tablet',
    running,
  }
}

function other(displayName: string, apiLevel: number, running = false): AndroidDevice {
  return {
    avdName: displayName.replaceAll(' ', '_'),
    displayName,
    apiLevel,
    family: 'other',
    running,
  }
}

function renderPicker(
  devices: AndroidDevice[],
  overrides: Partial<React.ComponentProps<typeof AndroidDevicePicker>> = {},
) {
  const props: React.ComponentProps<typeof AndroidDevicePicker> = {
    devices,
    selectedAvd: undefined,
    busyAvd: undefined,
    onSelect: vi.fn(),
    ...overrides,
  }
  return {
    ...render(
      <I18nProvider language="pt-BR">
        <AndroidDevicePicker {...props} />
      </I18nProvider>,
    ),
    props,
  }
}

describe('AndroidDevicePicker (PA-27)', () => {
  it('groups running devices first, then family + descending apiLevel', () => {
    renderPicker([
      phone('Pixel 8', 35),
      tablet('Pixel Tablet', 34),
      other('Android TV', 35),
      phone('Pixel 9', 36, true),
    ])

    fireEvent.focus(screen.getByRole('combobox', { name: 'Buscar dispositivo Android' }))

    const groups = screen.getAllByRole('group')
    expect(groups.map(group => group.getAttribute('aria-label'))).toEqual([
      'Em execução',
      'celular · API 35',
      'tablet · API 34',
      'dispositivo · API 35',
    ])
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
      'Pixel 9API 36 · ligado',
      'Pixel 8API 35 · desligado',
      'Pixel TabletAPI 34 · desligado',
      'Android TVAPI 35 · desligado',
    ])
  })

  it('filters by family and by free-text query (name or apiLevel)', () => {
    renderPicker([phone('Pixel 8', 35), tablet('Pixel Tablet', 34)])

    fireEvent.click(screen.getByRole('button', { name: 'tablet' }))
    expect(screen.getAllByRole('option').map(option => option.textContent))
      .toEqual(['Pixel TabletAPI 34 · desligado'])

    fireEvent.click(screen.getByRole('button', { name: 'Todos' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Buscar dispositivo Android' }), {
      target: { value: '35' },
    })
    expect(screen.getAllByRole('option').map(option => option.textContent))
      .toEqual(['Pixel 8API 35 · desligado'])
  })

  it('supports arrows, Enter and Escape, reporting the frozen avdName', () => {
    const onSelect = vi.fn()
    renderPicker([phone('Pixel 9', 36, true), phone('Pixel 8', 35)], { onSelect })
    const combo = screen.getByRole('combobox', { name: 'Buscar dispositivo Android' })

    fireEvent.focus(combo)
    fireEvent.keyDown(combo, { key: 'ArrowDown' })
    fireEvent.keyDown(combo, { key: 'ArrowDown' })
    fireEvent.keyDown(combo, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith('Pixel_8')
    expect(combo).toHaveFocus()
    fireEvent.focus(combo)
    fireEvent.keyDown(combo, { key: 'Escape' })
    expect(combo).toHaveAttribute('aria-expanded', 'false')
  })

  it('selects the clicked option by frozen avdName', () => {
    const onSelect = vi.fn()
    renderPicker([phone('Pixel 8', 35), tablet('Pixel Tablet', 34)], { onSelect })
    const combo = screen.getByRole('combobox', { name: 'Buscar dispositivo Android' })

    fireEvent.focus(combo)
    fireEvent.click(screen.getByRole('option', { name: /Pixel 8/ }))

    expect(onSelect).toHaveBeenCalledWith('Pixel_8')
  })

  it('disables every option while an attach is busy', () => {
    renderPicker([phone('Pixel 8', 35), tablet('Pixel Tablet', 34)], { busyAvd: 'Pixel_9' })

    fireEvent.focus(screen.getByRole('combobox', { name: 'Buscar dispositivo Android' }))

    for (const option of screen.getAllByRole('option')) expect(option).toBeDisabled()
  })
})
