import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VideoUnderstandingSettings } from './VideoUnderstandingSettings'
import type { VideoTranscriberProgress } from '../../../shared/types'

vi.mock('../../i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

const getState = vi.fn()
const download = vi.fn()
const remove = vi.fn()
let progressHandler: ((progress: VideoTranscriberProgress) => void) | undefined
const subscribe = vi.fn((handler: (progress: VideoTranscriberProgress) => void) => {
  progressHandler = handler
  return vi.fn()
})

beforeEach(() => {
  vi.clearAllMocks()
  progressHandler = undefined
  getState.mockResolvedValue({ asrModel: 'absent' })
  Object.assign(window, {
    verboo: {
      getVideoComponentState: getState,
      downloadVideoTranscriber: download,
      removeVideoTranscriber: remove,
      onVideoTranscriberProgress: subscribe,
    },
  })
})

describe('VideoUnderstandingSettings', () => {
  it('reads local state without starting a network download on render', async () => {
    render(<VideoUnderstandingSettings consent="ask" onConsentChange={vi.fn()} />)
    await waitFor(() => expect(getState).toHaveBeenCalledTimes(1))
    expect(download).not.toHaveBeenCalled()
    expect(screen.getByText('videoSettings.absent')).toBeInTheDocument()
  })

  it('requires explicit confirmation before the first download', async () => {
    render(<VideoUnderstandingSettings consent="ask" onConsentChange={vi.fn()} />)
    await screen.findByText('videoSettings.absent')
    fireEvent.click(screen.getByRole('button', { name: 'videoSettings.download' }))
    expect(download).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'videoSettings.confirmDownload' }))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
  })

  it('renders ready, downloading and error states and allows remove or retry', async () => {
    getState.mockResolvedValue({ asrModel: 'ready', bytes: 147951465 })
    const { rerender } = render(<VideoUnderstandingSettings consent="ask" onConsentChange={vi.fn()} />)
    await screen.findByText(/videoSettings.ready/)
    fireEvent.click(screen.getByRole('button', { name: 'videoSettings.remove' }))
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))

    act(() => {
      progressHandler?.({ state: 'downloading', bytesDownloaded: 73_975_732, totalBytes: 147_951_465 })
    })
    expect(screen.getByText(/videoSettings.downloading 50%/)).toBeInTheDocument()
    act(() => {
      progressHandler?.({ state: 'error', bytesDownloaded: 10, totalBytes: 147951465, error: 'bad hash' })
    })
    rerender(<VideoUnderstandingSettings consent="ask" onConsentChange={vi.fn()} />)
    expect(await screen.findByText('bad hash')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'videoSettings.retry' }))
    fireEvent.click(screen.getByRole('button', { name: 'videoSettings.confirmDownload' }))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
  })

  it('updates video consent independently', async () => {
    const onConsentChange = vi.fn()
    render(<VideoUnderstandingSettings consent="ask" onConsentChange={onConsentChange} />)
    fireEvent.click(screen.getByRole('radio', { name: 'videoSettings.never' }))
    expect(onConsentChange).toHaveBeenCalledWith('never')
  })
})
