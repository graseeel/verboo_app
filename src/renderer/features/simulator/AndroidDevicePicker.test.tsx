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

  it('shows a friendly label for backend-echoed names, keeping the raw avdName as value + tooltip (PA-36)', () => {
    const onSelect = vi.fn()
    // The real backend sends displayName = avdName verbatim (requirements.rs).
    const verbooDevice: AndroidDevice = {
      avdName: 'Verboo_Device_API_36',
      displayName: 'Verboo_Device_API_36',
      apiLevel: 36,
      family: 'phone',
      running: false,
    }
    renderPicker([verbooDevice], { selectedAvd: 'Verboo_Device_API_36', onSelect })

    const combo = screen.getByRole('combobox', { name: 'Buscar dispositivo Android' })
    expect(combo).toHaveValue('Verboo Device · API 36')
    expect(combo).toHaveAttribute('title', 'Verboo_Device_API_36')

    fireEvent.focus(combo)
    const option = screen.getByRole('option', { name: /Verboo Device · API 36/ })
    expect(option).toHaveAttribute('title', 'Verboo_Device_API_36')
    fireEvent.click(option)

    expect(onSelect).toHaveBeenCalledWith('Verboo_Device_API_36')
    expect(combo).toHaveValue('Verboo Device · API 36')
  })

  it('formats third-party AVDs by the same generic rule and finds them by the friendly label', () => {
    const custom: AndroidDevice = {
      avdName: 'Minha_AVD_de_Teste',
      displayName: 'Minha_AVD_de_Teste',
      apiLevel: 33,
      family: 'phone',
      running: false,
    }
    renderPicker([custom])
    const combo = screen.getByRole('combobox', { name: 'Buscar dispositivo Android' })

    fireEvent.focus(combo)
    fireEvent.change(combo, { target: { value: 'Minha AVD' } })

    expect(screen.getByRole('option', { name: /Minha AVD de Teste/ })).toBeInTheDocument()
  })

  it('keeps a real backend displayName as-is and shows the search placeholder when empty', () => {
    renderPicker([phone('Pixel 8', 35)])

    const combo = screen.getByRole('combobox', { name: 'Buscar dispositivo Android' })
    expect(combo).toHaveAttribute('placeholder', 'Buscar dispositivo Android')
    expect(combo).toHaveValue('')

    fireEvent.focus(screen.getByRole('combobox', { name: 'Buscar dispositivo Android' }))
    expect(screen.getByRole('option', { name: /Pixel 8/ })).toHaveAttribute('title', 'Pixel_8')
  })

  it('renders the same friendly label in English', () => {
    const verbooDevice: AndroidDevice = {
      avdName: 'Verboo_Device_API_36',
      displayName: 'Verboo_Device_API_36',
      apiLevel: 36,
      family: 'phone',
      running: false,
    }
    render(
      <I18nProvider language="en-US">
        <AndroidDevicePicker devices={[verbooDevice]} selectedAvd="Verboo_Device_API_36" onSelect={vi.fn()} />
      </I18nProvider>,
    )

    const combo = screen.getByRole('combobox', { name: 'Search Android device' })
    expect(combo).toHaveValue('Verboo Device · API 36')
    expect(combo).toHaveAttribute('placeholder', 'Search Android device')
  })
})
