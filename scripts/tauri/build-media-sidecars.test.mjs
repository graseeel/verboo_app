import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  SUPPORTED_TARGETS,
  binaryFilename,
  buildRecipeFingerprint,
  isFullyStaticLinuxBinaryDescription,
  loadManifest,
  missingFfmpegCapabilities,
  requestedTarget,
  requiredFfmpegCapabilities,
  staticLinkerArguments,
  unexpectedWindowsDlls,
  verifySha256,
  whisperCmakeArguments,
} from './build-media-sidecars.mjs'

test('pins the exact media source versions and checksum-shaped inputs', async () => {
  const manifest = await loadManifest()

  assert.deepEqual([...SUPPORTED_TARGETS], [
    'aarch64-apple-darwin',
    'x86_64-apple-darwin',
    'x86_64-pc-windows-msvc',
    'x86_64-unknown-linux-gnu',
  ])
  assert.deepEqual(manifest, {
    ffmpeg: {
      version: '8.1.2',
      url: 'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz',
      sha256: '464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c',
    },
    zimg: {
      version: '3.0.6',
      url: 'https://github.com/sekrit-twc/zimg/archive/refs/tags/release-3.0.6.tar.gz',
      sha256: 'be89390f13a5c9b2388ce0f44a5e89364a20c1c57ce46d382b1fcc3967057577',
    },
    whisperCpp: {
      version: '1.8.5',
      url: 'https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.8.5.tar.gz',
      sha256: 'cd702189cb5e608c8bc487f4b151db593c4455925b37cc06ef76b44861911db1',
    },
    whisperModel: {
      name: 'ggml-base.bin',
      url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
      size: 147951465,
      sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    },
  })

  for (const source of Object.values(manifest)) {
    assert.match(source.sha256, /^[a-f0-9]{64}$/)
  }
})

test('names the three Tauri sidecars for each supported target', () => {
  for (const target of SUPPORTED_TARGETS) {
    const suffix = target.includes('windows') ? '.exe' : ''
    assert.equal(binaryFilename('ffmpeg', target), `verboo-ffmpeg-${target}${suffix}`)
    assert.equal(binaryFilename('ffprobe', target), `verboo-ffprobe-${target}${suffix}`)
    assert.equal(binaryFilename('whisper', target), `verboo-whisper-${target}${suffix}`)
  }
})

test('rejects unknown targets and a missing explicit target flag', () => {
  assert.throws(() => binaryFilename('ffmpeg', 'arm64-unknown-linux-gnu'), /unsupported target/i)
  assert.throws(() => requestedTarget([]), /explicit --target/i)
})

test('fails closed when a downloaded source hash does not match', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'verboo-media-sidecars-test-'))
  const file = path.join(directory, 'source.tar.xz')
  await writeFile(file, 'not the pinned source')

  try {
    await assert.rejects(
      verifySha256(file, '0'.repeat(64)),
      /sha-256 mismatch/i,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('requires static whisper and the exact FFmpeg capabilities for each target', () => {
  assert.deepEqual(whisperCmakeArguments('aarch64-apple-darwin'), [
    '-DBUILD_SHARED_LIBS=OFF',
    '-DGGML_STATIC=ON',
    '-DGGML_BACKEND_DL=OFF',
  ])

  const macos = requiredFfmpegCapabilities('aarch64-apple-darwin')
  assert.ok(macos.encoders.includes('png'))
  assert.ok(macos.encoders.includes('h264_videotoolbox'))
  assert.ok(macos.filters.includes('zscale'))
  assert.deepEqual(macos.demuxers, ['mov', 'matroska', 'webm', 'avi'])

  const complete = Object.fromEntries(
    Object.entries(macos).map(([kind, entries]) => [kind, entries.join('\n')]),
  )
  assert.deepEqual(missingFfmpegCapabilities(complete, 'aarch64-apple-darwin'), [])
  assert.deepEqual(
    missingFfmpegCapabilities({ ...complete, encoders: complete.encoders.replace('png', '') }, 'aarch64-apple-darwin'),
    ['encoder: png'],
  )

  // Windows joins Linux in promising no guaranteed H.264 encoder: h264_mf
  // needs Media Foundation, which the minimal LGPL mingw build cannot link.
  const windows = requiredFfmpegCapabilities('x86_64-pc-windows-msvc')
  assert.ok(!windows.encoders.some((encoder) => encoder.startsWith('h264_')))
  const linux = requiredFfmpegCapabilities('x86_64-unknown-linux-gnu')
  assert.ok(!linux.encoders.some((encoder) => encoder.startsWith('h264_')))

  assert.deepEqual(staticLinkerArguments('x86_64-unknown-linux-gnu'), {
    ffmpeg: ['--extra-ldflags=-static'],
    cmake: ['-DCMAKE_EXE_LINKER_FLAGS=-static'],
  })
  assert.deepEqual(staticLinkerArguments('x86_64-pc-windows-msvc'), {
    ffmpeg: ['--extra-ldflags=-static', '--extra-libs=-static-libgcc -static-libstdc++ -lwinpthread'],
    cmake: ['-DCMAKE_EXE_LINKER_FLAGS=-static -static-libgcc -static-libstdc++'],
  })
  assert.deepEqual(unexpectedWindowsDlls('DLL Name: KERNEL32.dll\nDLL Name: ADVAPI32.dll'), [])
  assert.deepEqual(unexpectedWindowsDlls('DLL Name: libwinpthread-1.dll\nDLL Name: evil.dll'), [
    'libwinpthread-1.dll', 'evil.dll',
  ])
})

test('invalidates cached builds when the builder recipe changes and accepts static PIE Linux binaries', () => {
  const manifest = { ffmpeg: { version: '8.1.2' } }
  assert.notEqual(buildRecipeFingerprint(manifest, 'recipe-a'), buildRecipeFingerprint(manifest, 'recipe-b'))
  assert.equal(isFullyStaticLinuxBinaryDescription('ELF 64-bit LSB executable, statically linked'), true)
  assert.equal(isFullyStaticLinuxBinaryDescription('ELF 64-bit LSB pie executable, static-pie linked'), true)
  assert.equal(isFullyStaticLinuxBinaryDescription('ELF 64-bit LSB pie executable, dynamically linked'), false)
})
