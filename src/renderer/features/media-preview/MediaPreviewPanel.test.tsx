import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaPreviewPanel } from './MediaPreviewPanel'
import type { TranscriptMediaAttachment } from '../../components/Transcript'

vi.mock('../../i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

const image: TranscriptMediaAttachment = {
  path: '/photos/reference.png',
  name: 'reference.png',
  size: 2048,
  kind: 'image',
  mediaType: 'image/png',
}

const video: TranscriptMediaAttachment = {
  path: '/videos/demo.mp4',
  name: 'demo.mp4',
  size: 4096,
  kind: 'video',
  mediaType: 'video/mp4',
}

const allowMediaPreviewFile = vi.fn(async (path: string) => path)

function renderPanel(media: TranscriptMediaAttachment = image) {
  const onClose = vi.fn()
  const onSetWidth = vi.fn()
  const result = render(
    <MediaPreviewPanel
      media={media}
      open
      width={420}
      minWidth={320}
      maxWidth={760}
      onClose={onClose}
      onSetWidth={onSetWidth}
    />,
  )
  return { ...result, onClose, onSetWidth }
}

beforeEach(() => {
  cleanup()
  allowMediaPreviewFile.mockClear()
  Object.defineProperty(window, 'verboo', {
    configurable: true,
    value: {
      allowMediaPreviewFile,
      fileUrl: (path: string) => `asset://localhost${path}`,
    },
  })
})

describe('MediaPreviewPanel', () => {
  it('authorizes and renders a local image proportionally in a named workspace region', async () => {
    const { container } = renderPanel()

    expect(screen.getByRole('region', { name: 'mediaPreview.title' })).toHaveStyle({ width: '420px' })
    const rendered = await screen.findByRole('img', { name: 'reference.png' })
    expect(allowMediaPreviewFile).toHaveBeenCalledWith('/photos/reference.png')
    expect(rendered).toHaveAttribute('src', 'asset://localhost/photos/reference.png')
    expect(rendered).toHaveAttribute('loading', 'lazy')
    expect(container.querySelector('video')).toBeNull()
  })

  it('renders video controls without autoplay and only preloads metadata', async () => {
    const { container } = renderPanel(video)

    const rendered = await screen.findByLabelText<HTMLVideoElement>('demo.mp4')
    expect(rendered).toBeTruthy()
    expect(rendered).toHaveAttribute('src', 'asset://localhost/videos/demo.mp4')
    expect(rendered).toHaveAttribute('controls')
    expect(rendered).toHaveAttribute('preload', 'metadata')
    expect(rendered?.autoplay).toBe(false)
    expect(container.querySelector('img')).toBeNull()
  })

  it('closes from an accessible button and exposes a resize separator', () => {
    const { onClose } = renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'mediaPreview.close' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.getByRole('separator', { name: 'mediaPreview.resize' })).toBeTruthy()
  })

  it('tracks pointer resizing without leaving the layout easing enabled', () => {
    const layout = document.createElement('div')
    layout.className = 'app-layout'
    document.body.append(layout)
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    })
    Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
      configurable: true,
      value: vi.fn(),
    })
    const onSetWidth = vi.fn()

    render(
      <MediaPreviewPanel
        media={image}
        open
        width={420}
        minWidth={320}
        maxWidth={760}
        onClose={() => {}}
        onSetWidth={onSetWidth}
      />,
      { container: layout },
    )

    fireEvent.pointerDown(screen.getByRole('separator', { name: 'mediaPreview.resize' }), {
      button: 0,
      clientX: 500,
      pointerId: 1,
    })
    expect(layout).toHaveClass('is-resizing')

    fireEvent.pointerMove(window, { clientX: 440 })
    expect(onSetWidth).toHaveBeenLastCalledWith(480)

    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(layout).not.toHaveClass('is-resizing')
  })

  it('reveals an image only after the browser reports it loaded', async () => {
    renderPanel()

    const rendered = await screen.findByRole('img', { name: 'reference.png' })
    expect(rendered).not.toHaveClass('is-ready')

    fireEvent.load(rendered)
    expect(rendered).toHaveClass('is-ready')
  })

  it('shows a friendly error and clears it when another media item replaces the failed one', async () => {
    const { rerender } = renderPanel()

    fireEvent.error(await screen.findByRole('img', { name: 'reference.png' }))
    expect(screen.getByRole('alert')).toHaveTextContent('mediaPreview.loadError')

    rerender(
      <MediaPreviewPanel
        media={video}
        open
        width={420}
        minWidth={320}
        maxWidth={760}
        onClose={() => {}}
        onSetWidth={() => {}}
      />,
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(await screen.findByLabelText('demo.mp4')).toBeTruthy()
  })
})
