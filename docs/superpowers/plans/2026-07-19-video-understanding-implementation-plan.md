# Video Understanding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Verboo accept one video of up to five minutes and 500 MB through the same composer paths as images, understand its scenes, on-screen text, and speech, and give the selected model a consolidated description without blocking or polluting the transcript.

**Architecture:** The renderer only orders attachments, streams pathless clipboard files, presents consent/progress, and delegates existing Tesseract OCR to a Web Worker. Rust owns validation, probing, route selection, temporary files, FFmpeg preparation, local Whisper transcription, caching, cancellation, and consolidation. A capability intersection chooses native video only when the selected model, bundled CLI transport, container, codec, and HDR profile all explicitly agree; the current bundled CLI reports no video/audio content-block support, so version 1 safely uses the frame/OCR/local-ASR fallback while keeping a tested native route for a future compatible CLI.

**Tech Stack:** Tauri 2, Rust 2021, React 18, TypeScript, Vitest, Cargo tests, FFmpeg/ffprobe 8.1.2 LGPL sidecars, whisper.cpp 1.8.5, multilingual `ggml-base.bin`, existing Tesseract.js worker, SHA-256 content cache, GitHub Actions for macOS/Windows/Linux bundles, and the bundled Computer Use plugin for final visual validation.

## Global Constraints

- Follow the approved design in `docs/superpowers/specs/2026-07-19-video-understanding-design.md` exactly.
- Accept exactly these visible extensions: MP4, MOV, WebM, MKV, AVI, and M4V; trust ffprobe streams rather than extension or MIME alone.
- Accept duration `<= 300_000 ms` and size `<= 500 * 1024 * 1024 bytes`; reject larger media explicitly and never truncate it silently.
- Allow at most one video per message. Images and documents may appear before or after it, and their interaction order must be preserved across picker, drag/drop, and paste.
- Never serialize an entire video as base64. Pathless clipboard videos use bounded binary chunks of at most 1 MiB.
- Keep the original immutable. Any proxy, audio, frame, OCR, or contact sheet is an app-data temporary/cache artifact.
- Normalize fallback visual analysis to SDR BT.709. Recognize SDR, HLG, PQ/HDR10, and Dolby Vision metadata; do not send HDR frames directly to the image helper.
- Send the original video remotely only when both the selected model capability record and the active CLI transport explicitly support its actual container/codec/HDR combination.
- Use a separate `ask | always | never` video-analysis consent. Image fallback consent must not imply video consent.
- The first local ASR model download has its own explicit confirmation. It is removable from Settings.
- Keep one transient progress row in the transcript: `Validando → Preparando vídeo → Transcrevendo áudio → Analisando cenas e textos → Consolidando`. Remove it after completion; retain diagnostics only inside Worked for.
- Cancel must terminate FFmpeg, ffprobe, whisper.cpp, OCR coordination, helper-model calls, and the parent turn without leaving job directories.
- Recover from an isolated audio, OCR, or visual failure when at least one useful channel remains. Fail the turn for invalid/protected media, limits, cancellation, or no usable channel.
- No heavy video decode, audio decode, or model work may run on the WebView main thread. Tesseract runs only in its existing Web Worker.
- Do not patch generated/minified bundled CLI code and do not add provider-specific direct API calls.
- Do not rely on a system FFmpeg, ffprobe, whisper executable, PATH entry, Homebrew package, or user-installed codec.
- The current worktree contains unrelated pending edits. Before implementation, either start from their intentional checkpoint or stage only reviewed feature hunks; never sweep them into a video commit.
- Each task must finish with its listed focused tests and a reviewed `git diff --cached`; commits are small and use the repository's descriptive Conventional Commit style.

---

## File Structure

### Shared and persisted contracts

- Modify: `src/shared/types.ts` — video metadata, capabilities, consent, progress, and event contracts.
- Modify: `src-tauri/src/models/types.rs` — Rust mirrors of the shared contracts.
- Modify: `src-tauri/src/services/settings_store.rs` — normalize/persist video consent independently.
- Modify: `src/renderer/App.tsx` — defaults, event subscription, send request, attachment coordination, and consent/progress state.

### Sidecar supply chain

- Create: `scripts/tauri/media-sidecars.json` — pinned sources, checksums, target names, and licensing mode.
- Create: `scripts/tauri/build-media-sidecars.mjs` — target-aware, checksum-enforcing sidecar builder.
- Create: `scripts/tauri/build-media-sidecars.test.mjs` — manifest, target naming, and command-contract tests.
- Modify: `package.json` — media-sidecar build/test scripts.
- Modify: `src-tauri/tauri.conf.json` — bundle all three target-qualified sidecars.
- Modify: `.github/workflows/tauri-release.yml` — build and verify sidecars for every release matrix target.
- Create: `docs/licenses/video-media-sidecars.md` — versions, LGPL configuration, sources, hashes, and attribution.

### Backend video pipeline

- Modify: `src-tauri/src/services/mod.rs` — export the video service.
- Create: `src-tauri/src/services/video/mod.rs` — public facade and fixed limits.
- Create: `src-tauri/src/services/video/probe.rs` — ffprobe parsing, stream validation, HDR detection, and limit errors.
- Create: `src-tauri/src/services/video/router.rs` — pure capability intersection and route selection.
- Create: `src-tauri/src/services/video/job.rs` — job registry, cancellation token, child lifecycle, and cleanup.
- Create: `src-tauri/src/services/video/prepare.rs` — SDR proxy, PCM audio, adaptive frames, OCR frames, and contact sheets.
- Create: `src-tauri/src/services/video/transcribe.rs` — whisper.cpp model management and transcription.
- Create: `src-tauri/src/services/video/cache.rs` — versioned SHA-256 result cache and stale-job cleanup.
- Create: `src-tauri/src/services/video/analyze.rs` — frame/OCR/audio consolidation and partial recovery.
- Modify: `src-tauri/src/services/file_service.rs` — classify/probe videos and return metadata.
- Modify: `src-tauri/src/services/turn_service.rs` — invoke the pipeline before prompt construction and share cancellation.
- Modify: `src-tauri/src/lib.rs` — commands for streamed paste, consent/model management, OCR result return, and registration.

### Renderer ingress and UI

- Create: `src/renderer/features/attachments/orderedAttachmentQueue.ts` — reserve interaction order before asynchronous inspection.
- Create: `src/renderer/features/attachments/orderedAttachmentQueue.test.ts` — out-of-order completion and dedup tests.
- Create: `src/renderer/features/attachments/pastedFileUpload.ts` — bounded stream upload for pathless clipboard files.
- Create: `src/renderer/features/attachments/pastedFileUpload.test.ts` — chunking, finish, and abort tests.
- Modify: `src/renderer/features/composer/Composer.tsx` — video chip, one-video rule, picker/drop/paste messaging.
- Modify: `src/renderer/verboo-bridge.ts` — typed upload, model-manager, OCR, and video commands/events.
- Create: `src/renderer/features/video/VideoFallbackModal.tsx` — explicit per-video remote-processing consent.
- Create: `src/renderer/features/video/VideoFallbackModal.test.tsx` — ask/always/never behavior and disclosures.
- Create: `src/renderer/features/video/VideoProcessingRow.tsx` — compact progress and cancel control.
- Create: `src/renderer/features/video/VideoProcessingRow.test.tsx` — stage rendering and cancellation.
- Create: `src/renderer/features/video/VideoOcrCoordinator.ts` — bridge backend frame batches to the existing OCR worker.
- Create: `src/renderer/features/video/VideoOcrCoordinator.test.ts` — serial work, partial errors, timeout, and cancellation.
- Create: `src/renderer/features/settings/VideoUnderstandingSettings.tsx` — consent and local ASR model management.
- Create: `src/renderer/features/settings/VideoUnderstandingSettings.test.tsx` — download/remove/consent UI.
- Modify: `src/renderer/features/settings/SettingsView.tsx` — place video controls in the existing App settings tab.
- Modify: `src/renderer/components/Transcript.tsx` — show transient progress and Worked for diagnostics.
- Modify: `src/renderer/i18n.tsx` — English and Brazilian Portuguese copy.
- Modify: `src/renderer/styles/base.css` — compact video chips, consent, progress, and settings styles.

### Integration fixtures and tests

- Create: `src-tauri/tests/fixtures/video/README.md` — reproducible fixture-generation commands and expected metadata.
- Create: `src-tauri/tests/video_pipeline.rs` — fixture-level probe, routing, cancellation, cache, and partial-recovery tests.
- Create: `src/renderer/App.videoAttachments.test.tsx` — composer-to-turn ordering and one-video integration.
- Create: `src/renderer/App.videoProgress.test.tsx` — event lifecycle and Worked for integration.
- Create: `src/renderer/App.videoSettings.test.tsx` — independent defaults and persisted consent integration.

---

## Task 1: Add shared video contracts and independent settings

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src-tauri/src/models/types.rs`
- Modify: `src-tauri/src/services/settings_store.rs`
- Modify: `src/renderer/App.tsx`
- Add tests beside the existing settings/type serialization tests.

**Interfaces:**

```ts
export type VideoFallbackConsent = 'ask' | 'always' | 'never'
export type VideoHdrKind = 'sdr' | 'hlg' | 'pq' | 'dolbyVision' | 'unknown'
export type VideoProgressStage =
  | 'validating'
  | 'preparing'
  | 'transcribing'
  | 'analyzing'
  | 'consolidating'

export type VideoStreamMetadata = {
  durationMs: number
  container: string
  videoCodec: string
  audioCodec?: string
  width: number
  height: number
  avgFps: number
  hasAudio: boolean
  hdr: VideoHdrKind
  colorPrimaries?: string
  colorTransfer?: string
  bitDepth?: number
}

export type ModelMediaCapabilities = {
  image: boolean
  video: boolean
  audio: boolean
  videoContainers: string[]
  videoCodecs: string[]
  acceptsHdrVideo: boolean
}

export type CliMediaCapabilities = {
  imageBlocks: boolean
  videoBlocks: boolean
  audioBlocks: boolean
}

export type VideoProgress = {
  jobId: string
  turnId: string
  stage: VideoProgressStage
  completedUnits?: number
  totalUnits?: number
}
```

Extend `AttachmentKind` to `'image' | 'video' | 'file'`, add `video?: VideoStreamMetadata` to `AttachmentMeta`, add `videoFallbackConsent` to `UserSettings`, add optional `mediaCapabilities`, `cliMediaCapabilities`, and `runVideoAnalysis` to `AgentTurnRequest`, add `'video'` to transcript activity kinds, and add a `video-progress` agent event carrying `VideoProgress`. Preserve `modelSupportsVision` and image fallback fields for backward compatibility.

- [ ] **Step 1: Write red serialization/default tests**

Cover all of the following:

- old settings JSON without `videoFallbackConsent` normalizes to `ask`;
- image and video consent serialize independently;
- Rust and TypeScript use the exact same camelCase field names and enum values;
- an attachment with `kind: 'video'` round-trips with metadata;
- `video-progress` is accepted without changing existing AgentEvent variants.

- [ ] **Step 2: Run the red tests**

Run:

```bash
npm test -- --run src/renderer/App.videoSettings.test.tsx
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml settings_store
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml video_contract
```

Expected: FAIL because the new fields and variants do not exist.

- [ ] **Step 3: Add the contracts and defaults**

Mirror the TypeScript contracts in Rust with `#[serde(rename_all = "camelCase")]`. Add `#[serde(default)]` only where backward-compatible loading is required. Add `EventType::VideoProgress` with `#[serde(rename = "video-progress")]` and `video_progress: Option<VideoProgress>` on `AgentEvent`.

- [ ] **Step 4: Normalize persisted settings**

Update `settings_store.rs`'s explicit normalization copy; do not rely on a spread/flatten that could preserve unknown data. Default the renderer and Rust to `ask`.

- [ ] **Step 5: Run green tests and inspect scope**

Run the Step 2 commands plus `npm run build:renderer` and `git diff --check`.

Expected: PASS; TypeScript compiles; Rust serialization tests pass; no whitespace errors.

- [ ] **Step 6: Commit the contracts**

Stage only reviewed hunks and commit:

```bash
git commit -m "feat(video): add media capability and consent contracts"
```

## Task 2: Build pinned media sidecars reproducibly

**Files:**
- Create: `scripts/tauri/media-sidecars.json`
- Create: `scripts/tauri/build-media-sidecars.mjs`
- Create: `scripts/tauri/build-media-sidecars.test.mjs`
- Modify: `package.json`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `.github/workflows/tauri-release.yml`
- Create: `docs/licenses/video-media-sidecars.md`

**Pinned inputs:**

```json
{
  "ffmpeg": {
    "version": "8.1.2",
    "url": "https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz",
    "sha256": "63a6d43859f5a899063aa35bcf34f91a614c80f38aac35afbac86b2de99273b5"
  },
  "zimg": {
    "version": "3.0.6",
    "url": "https://github.com/sekrit-twc/zimg/archive/refs/tags/release-3.0.6.tar.gz",
    "sha256": "be89390f13a5c9b2388ce0f44a5e89364a20c1c57ce46d382b1fcc3967057577"
  },
  "whisperCpp": {
    "version": "1.8.5",
    "url": "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.8.5.tar.gz",
    "sha256": "cd702189cb5e608c8bc487f4b151db593c4455925b37cc06ef76b44861911db1"
  },
  "whisperModel": {
    "name": "ggml-base.bin",
    "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    "size": 147951465,
    "sha256": "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"
  }
}
```

Produce target-qualified executables `verboo-ffmpeg-<target>`, `verboo-ffprobe-<target>`, and `verboo-whisper-<target>` with `.exe` on Windows. Build zimg as a static dependency so FFmpeg's `zscale` filter can perform explicit HDR-to-SDR conversion. FFmpeg must be configured without GPL/nonfree components and with the file/pipe-only protocol surface needed by this feature. whisper.cpp must build the CLI only; the 148 MB model is downloaded on demand and is not bundled.

Use these FFmpeg configure constraints on every target: `--disable-everything`, `--disable-gpl`, `--disable-nonfree`, `--disable-network`, `--disable-autodetect`, `--disable-doc`, `--disable-debug`, `--disable-shared`, `--enable-static`, `--enable-ffmpeg`, `--enable-ffprobe`, `--enable-libzimg`, `--enable-protocol=file,pipe`, `--enable-demuxer=mov,matroska,webm,avi`, `--enable-decoder=h264,hevc,vp8,vp9,av1,prores,aac,mp3,opus,vorbis,pcm_s16le`, `--enable-parser=h264,hevc,vp8,vp9,av1,aac`, `--enable-filter=select,scale,format,fps,thumbnail,showinfo,aresample,aformat,tonemap,zscale`, `--enable-muxer=image2,wav,mp4`, and `--enable-encoder=png,pcm_s16le,aac`. macOS may additionally enable the non-GPL `h264_videotoolbox` encoder and Windows `h264_mf`; Linux has no guaranteed H.264 encoder and therefore routes an incompatible original to sampled frames instead of manufacturing a proxy.

- [ ] **Step 1: Write manifest and naming tests first**

Test checksums' shape, exact versions, supported release targets (`aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu`), `.exe` behavior, and failure on an unknown target or mismatched hash.

- [ ] **Step 2: Run the red Node test**

Run: `node --test scripts/tauri/build-media-sidecars.test.mjs`

Expected: FAIL because the manifest/builder do not exist.

- [ ] **Step 3: Implement the builder**

The script must:

1. require an explicit `--target`;
2. download into a temporary directory;
3. verify SHA-256 before extraction;
4. configure/build only the pinned source;
5. copy only the three stripped executables into `src-tauri/binaries`;
6. run `ffmpeg -version`, `ffprobe -version`, and `verboo-whisper --help` as a smoke check;
7. fail closed if a binary links to an unexpected GPL/nonfree build or uses a system binary.

Use GitHub-hosted runner toolchains already matching the Tauri target. On Windows, install/use MSYS2 from the workflow step but copy the final `.exe` to the normal Tauri binary directory. Cache source/build directories by version, target, and manifest hash; never cache unverified outputs.

- [ ] **Step 4: Register package and Tauri scripts**

Add:

```json
"build:media-sidecars": "node scripts/tauri/build-media-sidecars.mjs",
"test:media-sidecars": "node --test scripts/tauri/build-media-sidecars.test.mjs"
```

Add all three base names to `bundle.externalBin`. Do not place the downloaded ASR model in `bundle.resources`.

- [ ] **Step 5: Extend all release matrix jobs**

Build sidecars before `cargo tauri build`, pass the matrix target explicitly, and add a step that lists and executes the target-qualified files. Preserve the current macOS universal/signing, Windows, and Linux packaging logic.

- [ ] **Step 6: Document third-party licensing**

Record source URLs, hashes, exact configure flags, zimg's license, LGPL obligations, platform encoder differences, and where the user can remove the separately downloaded Whisper model.

- [ ] **Step 7: Verify and commit**

Run:

```bash
npm run test:media-sidecars
npm run build:media-sidecars -- --target "$(rustc -vV | sed -n 's/^host: //p')"
src-tauri/binaries/verboo-ffmpeg-"$(rustc -vV | sed -n 's/^host: //p')" -version
src-tauri/binaries/verboo-ffprobe-"$(rustc -vV | sed -n 's/^host: //p')" -version
git diff --check
```

Expected: tests PASS; all three host binaries exist and smoke successfully; the Whisper model is absent.

Commit: `build(video): bundle pinned media sidecars`

## Task 3: Probe real streams and enforce hard limits

**Files:**
- Create: `src-tauri/src/services/video/mod.rs`
- Create: `src-tauri/src/services/video/probe.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/services/file_service.rs`
- Modify: `src-tauri/src/lib.rs`
- Add focused Rust tests and fixtures.

**Rust contract:**

```rust
pub const MAX_VIDEO_BYTES: u64 = 500 * 1024 * 1024;
pub const MAX_VIDEO_DURATION_MS: u64 = 300_000;
pub const MAX_VISUAL_FRAMES: usize = 120;
pub const MAX_OCR_FRAMES: usize = 60;
pub const PASTE_CHUNK_BYTES: usize = 1024 * 1024;

pub enum VideoValidationError {
    TooLarge { actual: u64, maximum: u64 },
    TooLong { actual_ms: u64, maximum_ms: u64 },
    MissingVideoStream,
    UnsupportedContainer(String),
    UnsupportedCodec(String),
    ProtectedOrUnreadable,
    ProbeFailed(String),
}

pub fn probe_and_validate(path: &Path, size: u64, ffprobe: &Path)
    -> Result<VideoStreamMetadata, VideoValidationError>;
```

- [ ] **Step 1: Create deterministic fixtures**

Generate tiny test media with the bundled FFmpeg: H.264 SDR MP4 with AAC, HEVC/PQ MOV, VP9 WebM without audio, a renamed text file, and a container with no video stream. Keep fixtures under 200 KB where possible and document exact generation commands.

- [ ] **Step 2: Write red probe/limit tests**

Cover valid metadata, `300_000 ms` accepted, `300_001 ms` rejected using a mocked probe JSON, exact 500 MB accepted using a mocked stat, one byte over rejected before spawning ffprobe, renamed/non-video input rejected, HDR mapping, and no-video-stream rejection.

- [ ] **Step 3: Run red Rust tests**

Run: `cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml video::probe file_service`

Expected: FAIL because video probe support does not exist.

- [ ] **Step 4: Implement fail-closed probing**

Run only the bundled ffprobe with JSON output, a timeout, no network protocol, and a direct path argument. Parse the first usable video stream plus optional audio. Derive actual format/codec/HDR metadata from streams; extension is only a picker affordance.

- [ ] **Step 5: Integrate attachment inspection**

Return `kind: Video` plus `video` metadata for accepted files. Return a typed validation error for rejected video candidates so the renderer can show a specific localized message instead of silently dropping the attachment.

- [ ] **Step 6: Verify and commit**

Run focused tests, `cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml`, and `git diff --check`.

Expected: PASS; a fake `.mp4` never becomes a video attachment; boundary values behave exactly.

Commit: `feat(video): validate streams and attachment limits`

## Task 4: Preserve composer order and stream clipboard videos

**Files:**
- Create: `src/renderer/features/attachments/orderedAttachmentQueue.ts`
- Create: `src/renderer/features/attachments/orderedAttachmentQueue.test.ts`
- Create: `src/renderer/features/attachments/pastedFileUpload.ts`
- Create: `src/renderer/features/attachments/pastedFileUpload.test.ts`
- Modify: `src/renderer/features/composer/Composer.tsx`
- Modify: `src/renderer/verboo-bridge.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src-tauri/src/lib.rs`
- Add Rust upload-session tests.

**Ordering contract:** Reserve a monotonically increasing batch sequence synchronously when the user picks, drops, or pastes. Async inspection results may finish in any order, but flush only contiguous completed batches. Canonical-path dedup keeps the earliest reserved position. Removing an item does not reorder survivors.

**Upload commands:**

```ts
beginPastedFileUpload({ name, size, mediaType }): Promise<{ uploadId: string }>
appendPastedFileChunk({ uploadId, offset, bytes: number[] }): Promise<void>
finishPastedFileUpload({ uploadId }): Promise<AttachmentMeta>
abortPastedFileUpload({ uploadId }): Promise<void>
```

The renderer reads `File.stream()` and invokes chunks of at most 1 MiB. Rust stores sessions under app-data `video_jobs/uploads`, requires exact monotonically increasing offsets, refuses declared/actual size above 500 MB, fsyncs/closes before inspection, and deletes partial files on abort/error/startup cleanup.

- [ ] **Step 1: Write red pure ordering tests**

Simulate picker batch A completing after paste batch B; expect A before B. Cover mixed `[image, video, document]`, canonical duplicate paths, removal, rejection of a second video, and a failed batch that does not block later batches.

- [ ] **Step 2: Write red upload tests**

Use a 2.5 MiB fake File; assert chunks `<= 1 MiB`, exact offsets, `finish` only after all chunks, `abort` on reader/invoke failure, and no base64 conversion.

- [ ] **Step 3: Run red renderer tests**

Run:

```bash
npm test -- --run \
  src/renderer/features/attachments/orderedAttachmentQueue.test.ts \
  src/renderer/features/attachments/pastedFileUpload.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement queue and streamed upload**

Keep these modules independent of React. In `App.tsx`, reserve the batch before calling any async picker/inspection/upload method. Do not append directly from individual completion callbacks.

- [ ] **Step 5: Integrate all three ingress paths**

- Picker: extend the dialog filter and use inspected paths.
- Drop: keep current Tauri paths; use streamed upload only for browser `File` objects without paths.
- Paste: prefer the copied filesystem path; otherwise stream a video `File`; retain current raw-image handling.
- Composer: show a compact video chip with name, duration, size, and remove action; refuse a second video with localized feedback.

- [ ] **Step 6: Add backend session tests**

Cover offset mismatch, oversize declaration, oversize actual stream, finish-before-complete, unknown upload ID, abort cleanup, and stale-session cleanup.

- [ ] **Step 7: Verify and commit**

Run focused renderer/Rust tests, `npm run build:renderer`, full Cargo tests, and `git diff --check`.

Commit: `feat(video): add ordered composer ingestion`

## Task 5: Add video consent and local ASR model management

**Files:**
- Create: `src/renderer/features/video/VideoFallbackModal.tsx`
- Create: `src/renderer/features/video/VideoFallbackModal.test.tsx`
- Create: `src/renderer/features/settings/VideoUnderstandingSettings.tsx`
- Create: `src/renderer/features/settings/VideoUnderstandingSettings.test.tsx`
- Modify: `src/renderer/features/settings/SettingsView.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/verboo-bridge.ts`
- Modify: `src/renderer/i18n.tsx`
- Modify: `src/renderer/styles/base.css`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/services/video/transcribe.rs` with model-store functions only in this task.

**Consent behavior:**

- `ask`: show a centered, blurred-backdrop modal before any video content is sent remotely.
- `always`: proceed without modal, but still record the route in Worked for.
- `never`: do not send original, proxy, frames, audio, or derived visual content remotely; reject with a clear explanation because local-only visual understanding is not implemented.
- Modal disclosure names the actual planned route: original video, SDR proxy, or sampled frames plus audio transcript. It never claims the route is native when CLI support is false.

**ASR model behavior:** Store `ggml-base.bin` under app-data `models/whisper/`. Download asynchronously to `.partial`, enforce exact size and SHA-256, then atomic rename. Delete model and partial file on Remove. Never auto-download on app launch.

- [ ] **Step 1: Write red consent tests**

Cover Ask approve once, Ask and remember Always, deny, stored Always, stored Never, Escape/cancel, default focus on Cancel, and exact route disclosure.

- [ ] **Step 2: Write red model-management tests**

Cover absent/downloading/ready/error states, explicit first-download confirmation, checksum mismatch cleanup, atomic success, Remove, retry, and no network call on settings render.

- [ ] **Step 3: Implement backend model store**

Expose:

```ts
getVideoComponentState(): Promise<{ asrModel: 'absent' | 'ready'; bytes?: number }>
downloadVideoTranscriber(): Promise<void>
removeVideoTranscriber(): Promise<void>
```

Emit download progress on a dedicated settings event; do not reuse transcript progress.

- [ ] **Step 4: Implement modal and settings card**

Place the card in the existing App settings tab. Show consent selector, model status/size, Download or Remove, and the fact that processing artifacts are temporary/cacheable. Keep it visually consistent with existing settings cards.

- [ ] **Step 5: Verify and commit**

Run focused tests, full renderer build, Cargo tests, and `git diff --check`.

Expected: consent is independent from image fallback; model download is always user-initiated.

Commit: `feat(video): add consent and transcription settings`

## Task 6: Implement pure native-versus-fallback routing

**Files:**
- Create: `src-tauri/src/services/video/router.rs`
- Modify: `src-tauri/src/services/video/mod.rs`
- Modify: `src-tauri/src/services/turn_service.rs` only to expose current transport capabilities.

**Route contract:**

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoRoute {
    NativeOriginal,
    NativeSdrProxy { transcribe_audio_locally: bool },
    SampledFrames { transcribe_audio_locally: bool },
}

pub struct MediaToolchainCapabilities {
    pub h264_sdr_proxy_encoder: bool,
}

pub fn choose_video_route(
    model: &ModelMediaCapabilities,
    cli: &CliMediaCapabilities,
    toolchain: &MediaToolchainCapabilities,
    video: &VideoStreamMetadata,
) -> VideoRoute;
```

Rules in priority order:

1. `NativeOriginal` only if model and CLI support video blocks, container, codec, and HDR profile.
2. `NativeSdrProxy` only if model and CLI support video blocks, original format/HDR does not match, and the current target reports a verified H.264 proxy encoder; transcode to H.264/AAC MP4 SDR BT.709.
3. `SampledFrames` otherwise.
4. Local audio transcription is required whenever neither the model nor CLI can receive a compatible audio stream.
5. Unknown/missing capability means unsupported, never optimistic support.

- [ ] **Step 1: Write the complete red routing matrix**

Include H.264 SDR, HEVC HDR, VP9 WebM, AV1, ProRes, model video false, CLI video false, audio mismatches, empty lists, unknown HDR, and proxy encoder available/unavailable. Assert the current bundled CLI adapter returns `{ imageBlocks: true, videoBlocks: false, audioBlocks: false }`. Detect the toolchain capability once from the bundled FFmpeg encoder list: macOS expects `h264_videotoolbox`, Windows expects `h264_mf`, and Linux defaults to false.

- [ ] **Step 2: Run red tests**

Run: `cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml video::router`

- [ ] **Step 3: Implement the pure router and explicit adapter**

Keep provider names out of routing. The model catalog normalizer supplies model capabilities; a versioned bundled-CLI adapter supplies transport capabilities. Do not infer video support from `supportsVision`.

- [ ] **Step 4: Verify and commit**

Run focused and full Cargo tests.

Expected: current production path always selects sampled frames, while artificial future-compatible capability fixtures exercise both native routes.

Commit: `feat(video): route media by explicit capabilities`

## Task 7: Add cancellable preparation, adaptive sampling, and cache

**Files:**
- Create: `src-tauri/src/services/video/job.rs`
- Create: `src-tauri/src/services/video/prepare.rs`
- Create: `src-tauri/src/services/video/cache.rs`
- Modify: `src-tauri/src/services/video/mod.rs`
- Modify: `src-tauri/src/services/turn_service.rs`

**Job lifecycle:** `VideoJobRegistry` owns one job per active video turn. Each spawned process is registered before awaiting output and deregistered after exit. `interrupt(conversationId)` cancels the token first, kills all registered children, then continues the existing CLI interruption behavior. Job directories live at `appData/video_jobs/<jobId>` and are removed on success, error, or cancellation.

**Preparation outputs:**

```rust
pub struct PreparedVideo {
    pub visual_frames: Vec<TimestampedFrame>,
    pub ocr_frames: Vec<TimestampedFrame>,
    pub contact_sheets: Vec<ContactSheet>,
    pub audio_wav: Option<PathBuf>,
    pub native_path: Option<PathBuf>,
    pub warnings: Vec<VideoWarning>,
}
```

- Visual sampling: scene-change candidates plus uniform temporal coverage, deduplicated by perceptual hash, maximum 120 frames.
- OCR sampling: favor scene changes and high-text-likelihood frames, maximum 60 frames.
- Contact sheets: maximum 12 labeled frames per 4x3 PNG sheet, maximum 10 sheets.
- Audio: PCM signed 16-bit, mono, 16 kHz WAV.
- Native proxy: H.264/AAC MP4, SDR BT.709 with explicit tone mapping for HDR inputs.
- FFmpeg/ffprobe run with a bounded timeout, network protocols disabled, stderr capped, and cancellation polling.

**Cache key:** `sha256(original bytes + pipelineVersion + route + modelCapabilityFingerprint + cliCapabilityFingerprint + asrModelHash)`. Cache stores JSON descriptions/transcript/OCR plus bounded contact sheets; never the original video. Writes are temp-plus-atomic-rename.

- [ ] **Step 1: Write red job/cancellation tests**

Use fake child handles to prove cancellation kills every registered process, is idempotent, removes job dirs, and does not cancel another conversation.

- [ ] **Step 2: Write red preparation tests**

Cover sampling caps, first/last temporal coverage, scene selection, perceptual dedup, contact-sheet timestamps, SDR passthrough, HDR tone-map command, audio extraction, no-audio input, malformed process output, and partial cleanup.

- [ ] **Step 3: Write red cache tests**

Cover identical hits, changed bytes/version/model/route misses, corrupt JSON eviction, atomic writes, and stale job/cache pruning.

- [ ] **Step 4: Implement child-safe preparation**

All external process invocations go through a single helper that accepts the job cancellation token and bundled executable path. Do not use shell command strings; pass arguments as a vector.

- [ ] **Step 5: Integrate interrupt without changing terminal/review behavior**

Only extend the existing turn interruption path to the active video registry. Do not touch the terminal-versus-review panel mutual-exclusion code.

- [ ] **Step 6: Verify and commit**

Run:

```bash
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml video::job
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml video::prepare
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml video::cache
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml
```

Expected: all PASS; cancellation leaves no job directory or child process.

Commit: `feat(video): prepare media with cancellable jobs`

## Task 8: Add local ASR and worker-based OCR coordination

**Files:**
- Complete: `src-tauri/src/services/video/transcribe.rs`
- Create: `src/renderer/features/video/VideoOcrCoordinator.ts`
- Create: `src/renderer/features/video/VideoOcrCoordinator.test.ts`
- Modify: `src/renderer/verboo-bridge.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/services/video/job.rs`

**ASR contract:** Run the bundled whisper.cpp CLI against the prepared WAV, with automatic language detection, JSON output including segments/timestamps, and no prompt text. Validate output schema and cap retained diagnostic stderr. Missing model triggers the already-approved first-download prompt before the job starts; it must never cause an implicit download inside `transcribe.rs`.

**OCR contract:** Rust emits `video:ocr-request` with `jobId` and at most 60 timestamped app-data frame URLs. `VideoOcrCoordinator` processes frames serially through the existing Tesseract.js Web Worker and invokes `complete_video_ocr_batch(jobId, results)`. Rust waits on a job-scoped oneshot with timeout/cancellation. Individual OCR errors become warnings; timeout/cancel releases both sides.

- [ ] **Step 1: Write red ASR tests**

Use a fake whisper executable to cover multilingual segments, no-speech result, malformed JSON, nonzero exit, timeout, cancellation, missing model, and timestamps retained.

- [ ] **Step 2: Write red OCR coordinator tests**

Mock the existing OCR service and bridge. Assert serial calls, timestamps retained, individual error recovery, all-error channel failure, backend completion exactly once, timeout cleanup, and cancellation stops remaining frames.

- [ ] **Step 3: Implement ASR process wrapper**

Return:

```rust
pub struct AudioTranscript {
    pub language: Option<String>,
    pub segments: Vec<TranscriptSegment>,
    pub warnings: Vec<VideoWarning>,
}
```

- [ ] **Step 4: Implement OCR request/response bridge**

Validate `jobId` ownership in Rust. Never allow a renderer response to complete another conversation's job. Remove listeners and pending promises after every terminal state.

- [ ] **Step 5: Verify and commit**

Run focused renderer tests, focused/full Cargo tests, `npm run build:renderer`, and `git diff --check`.

Expected: a transcript and OCR result retain timestamps; either channel can fail without losing the other.

Commit: `feat(video): transcribe audio and coordinate OCR`

## Task 9: Analyze scenes and consolidate one model context

**Files:**
- Create: `src-tauri/src/services/video/analyze.rs`
- Modify: `src-tauri/src/services/video/mod.rs`
- Modify: `src-tauri/src/services/turn_service.rs`
- Add focused Rust tests.

**Fallback visual analysis:** Reuse the existing auxiliary vision-model selection/retry/cache policy. Submit one contact sheet per helper call, with timestamp labels visible in the image and a strict JSON-output prompt. A sheet response contains time ranges, scene/action descriptions, visible text candidates, uncertainty, and continuity clues. Never call the helper once per frame.

**Consolidated context format:**

```text
<video_context name="..." duration_ms="..." route="sampled_frames">
Summary: ...
Timeline:
- 00:00.000–00:07.400 — ...
Visible text:
- 00:03.200 — ...
Speech:
- 00:01.100–00:05.900 [pt] ...
Warnings:
- OCR unavailable; visible text is based on vision analysis.
</video_context>
```

Escape untrusted filenames/text so it cannot close or inject control tags. Cap the final generated context by a documented character/token budget; prioritize timeline summary, speech, and deduplicated visible text. The original user prompt and attachment order remain unchanged around this generated context.

- [ ] **Step 1: Write red analysis tests**

Cover multiple sheets merged chronologically, overlap deduplication, OCR/vision disagreement retaining uncertainty, transcript alignment, no-audio, no-OCR, no-vision, all-channels-empty failure, hostile text escaping, prompt-budget reduction, helper retry, helper cancellation, and cache hit avoiding repeated helper work.

- [ ] **Step 2: Run red tests**

Run: `cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml video::analyze`

- [ ] **Step 3: Implement partial recovery and consolidation**

Treat audio, OCR, and vision as independently fallible `ChannelResult<T>`. Continue when at least one yields useful information. Collect user-safe warnings separately from diagnostic detail.

- [ ] **Step 4: Integrate before CLI prompt construction**

In `TurnService`, probe → consent → route → cache/preparation → ASR/OCR/vision → consolidation before building the CLI prompt. For the current CLI adapter, use the consolidated text context plus normal image/file attachments. Leave the native-video branch behind the explicit capability gate; if no supported CLI content-block serializer exists, return a typed invariant error rather than inventing one.

- [ ] **Step 5: Verify and commit**

Run focused/full Cargo tests and a fixture-backed turn test.

Expected: a current-CLI turn receives one bounded `<video_context>`; helper failures are recoverable when another channel succeeds.

Commit: `feat(video): consolidate multimodal video context`

## Task 10: Show transient progress, cancellation, and Worked for details

**Files:**
- Create: `src/renderer/features/video/VideoProcessingRow.tsx`
- Create: `src/renderer/features/video/VideoProcessingRow.test.tsx`
- Modify: `src/renderer/components/Transcript.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/i18n.tsx`
- Modify: `src/renderer/styles/base.css`
- Create: `src/renderer/App.videoProgress.test.tsx`
- Modify: `src-tauri/src/services/turn_service.rs`

**Event lifecycle:** Backend emits the five monotonic stages using the `video-progress` AgentEvent. Renderer stores live progress by turn, updates the existing row in place, and deletes live state on done/error/cancel. On completion, append one ordinary `RuntimeActivity` with `kind: 'video'` containing route, duration, frame/OCR counts, ASR language, cache hit, partial warnings, and timing. That activity is rendered only inside Worked for.

- [ ] **Step 1: Write red row tests**

Cover all localized labels, optional unit progress, button accessible name, one cancel callback, disabled cancel after request, and no terminal card.

- [ ] **Step 2: Write red App/Transcript lifecycle tests**

Feed stage events out of order and duplicated; assert monotonic single-row rendering. Feed done/error/cancel; assert row disappears. Expand Worked for after success; assert diagnostics are present in Markdown-compatible text and absent from the final assistant answer.

- [ ] **Step 3: Implement explicit state upsert**

Do not route live stages through `appendActivityItem`, whose current dedup behavior is not an upsert contract. Use `videoProgressByTurn`. Add the final activity only once at pipeline completion.

- [ ] **Step 4: Wire cancel to existing interruption**

The row calls the same conversation interrupt command used by the composer. The backend registry from Task 7 handles media children; existing CLI interruption then handles the turn.

- [ ] **Step 5: Style without changing transcript/composer geometry**

The row is compact, low contrast, and in normal transcript flow. It must not create a fixed overlay, resize the composer, open the subagent panel, or alter terminal/review panel mutual exclusion.

- [ ] **Step 6: Verify and commit**

Run focused tests, the entire renderer suite, `npm run build:renderer`, full Cargo tests, and `git diff --check`.

Commit: `feat(video): show cancellable analysis progress`

## Task 11: Close integration, security, and cross-platform release gates

**Files:**
- Create: `src-tauri/tests/video_pipeline.rs`
- Create: `src/renderer/App.videoAttachments.test.tsx`
- Extend all focused test files from Tasks 1–10.
- Modify packaging/workflow files only if a verified target gap remains.

- [ ] **Step 1: Add end-to-end backend fixture tests**

Exercise:

- H.264 SDR MP4 with audio;
- HEVC HDR MOV with tone mapping;
- VP9 WebM without audio;
- supported-extension file with invalid contents;
- a mocked 5-minute boundary;
- mocked 5:00.001 and 500 MB + 1 byte failures;
- cached rerun;
- cancellation during FFmpeg, Whisper, OCR wait, and helper vision;
- isolated ASR, OCR, and vision failure;
- no usable channel failure;
- hostile filenames and metadata;
- missing/corrupt sidecars and model.

- [ ] **Step 2: Add full renderer interaction tests**

Exercise picker, drop, copied-path paste, pathless video-File paste, mixed ordering, second-video rejection, removal, Ask/Always/Never, first-model download prompt, progress, cancel, final Worked for details, conversation switching, and no change to image-only turns.

- [ ] **Step 3: Run complete local automated gates**

Run:

```bash
npm test -- --run
npm run test:media-sidecars
npm run build:renderer
cargo +1.89.0 fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo +1.89.0 clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml
git diff --check
```

Expected: every command exits 0; no existing image, transcript, composer, terminal, review, link-confirmation, subagent, or CLI-recovery test regresses.

- [ ] **Step 4: Verify exact bundle contents on the host**

Run the normal package command and inspect the built app/bundle. Confirm all three target-qualified executables are present and executable, `ggml-base.bin` is absent before user download, and no build path points to Homebrew/system media tools.

- [ ] **Step 5: Exercise release workflow for all targets**

Run or dispatch the existing release workflow in a non-publishing validation mode for macOS ARM64, macOS x64, Windows x64, and Linux x64. Each job must build/smoke sidecars, package the app, and upload its normal artifact. A failure on any platform blocks completion; do not declare cross-platform readiness from the macOS build alone.

- [ ] **Step 6: Review security and privacy boundaries**

Confirm:

- only `http/https` model endpoints already authorized by the CLI can receive derived content;
- consent route matches actual transmitted representation;
- temporary artifacts are app-private and cleaned;
- logs never contain video bytes, frames, full transcripts, or secrets;
- command arguments are not shell-interpolated;
- pasted upload IDs cannot escape their session directory;
- size, count, timeout, and stderr/output caps are enforced.

- [ ] **Step 7: Commit integration closure**

Commit: `test(video): cover pipeline and release boundaries`

## Task 12: Package, install, open, and validate visually with @Computador

**Files:**
- No source changes expected. If a visual bug is found, return to the responsible task, add a failing automated test where possible, fix it, rerun Task 11, rebuild, and restart this task.

**Precondition:** Tasks 1–11 are green and the Computer Use runtime is available. This gate is macOS UI validation, not a substitute for Windows/Linux automated packaging.

- [ ] **Step 1: Build the signed/unsigned local macOS app through the repository's release script**

Run the normal packaging path that includes `build:tauri-deps`, Chrome helper, renderer, media sidecars, and `cargo tauri build`. Record the exact `.app` path and commit SHA.

Expected: a fresh `Verboo Code.app` bundle with all sidecars and no bundled ASR model.

- [ ] **Step 2: Replace the installed app safely**

Quit the running Verboo Code, move the existing `/Applications/Verboo Code.app` to a timestamped temporary backup, copy the fresh bundle to `/Applications`, and launch that exact installed bundle. Delete the backup only after all validation succeeds; otherwise restore it.

- [ ] **Step 3: Start Computer Use correctly**

Use the bundled `computer-use` skill and its plugin wrapper via the supported `node_repl`/`nodeRepl.env` route. Do not substitute Playwright, AppleScript, shell clicks, browser automation, or code inspection for this visual gate. If macOS requests Accessibility or Screen Recording, grant/confirm them for the current `Verboo Code` and Computer Use helper before continuing.

- [ ] **Step 4: Validate the three composer ingress paths visually**

With fresh screenshots/accessibility state after each action:

1. attach a short video through the clip picker;
2. remove it and drag/drop the same video;
3. remove it, copy the file in Finder, and paste with Cmd+V;
4. verify the compact chip, duration/size, removal, preserved mixed attachment order, and localized second-video rejection.

- [ ] **Step 5: Validate consent, download, progress, and cancellation visually**

Set consent to Ask, send a supported short fixture, and verify the centered blurred modal describes the real route. Approve, confirm the separate ASR-model download prompt, observe the five compact progress stages, cancel during processing, and verify the row disappears without freezing the composer/transcript. Repeat to completion and expand Worked for to inspect Markdown-formatted video details.

- [ ] **Step 6: Validate UI non-regressions visually**

Confirm:

- final assistant answer has no permanent processing card;
- transcript scroll/expand behavior remains stable;
- composer remains fixed and usable;
- subagent indicator/panel does not open automatically;
- opening the subagent side panel still closes the terminal/review panel through its existing behavior;
- opening terminal or review closes only the subagent panel as already designed;
- transcript links still open their centered blurred confirmation modal;
- light-theme Bash/Markdown readability remains unchanged or better;
- image-only attachment flow remains functional.

- [ ] **Step 7: Validate edge errors visually**

Attempt a renamed invalid video, a mocked/fixture over-five-minute video, and a second video in one message. Confirm each error is explicit, localized, and leaves the composer usable. Do not test >500 MB by copying a huge real fixture when a sparse/generated fixture can validate the UI safely.

- [ ] **Step 8: Record evidence and close**

Record app commit, bundle path, OS/architecture, model/route, fixture metadata, every observed pass/fail, and screenshots. Only mark the feature complete when Computer Use observed the installed app itself. If Computer Use is unavailable or permissions block observation, report the gate as blocked/partial rather than claiming visual success.

---

## Plan Self-Review

- **Approved scope coverage:** One video; 5-minute/500 MB hard limits; MP4/MOV/WebM/MKV/AVI/M4V; H.264, HEVC, VP8, VP9, AV1, ProRes; SDR/HDR normalization; scenes, motion, on-screen text, and speech; native capability gate; sampled-frame/OCR/local-ASR fallback; independent consent; removable model; ordered picker/drop/paste; transient progress; cancel; partial recovery; Worked for-only diagnostics; and cross-platform packaging are all mapped to implementation tasks.
- **Current transport reality:** The plan does not pretend the bundled CLI 0.13.0 can carry video/audio blocks. Task 6 codifies the false capabilities, Task 9 uses a consolidated text context now, and native routes stay closed until an explicit future adapter passes its tests.
- **UI regression containment:** Tasks 4, 5, and 10 limit renderer changes to attachment/consent/progress surfaces. Task 12 explicitly validates transcript, composer, panels, links, light theme, images, and subagents.
- **Resource and privacy bounds:** Every large operation has byte/count/time/process bounds; video is never base64; original media is immutable; remote representation is disclosed; cache/temp cleanup and log restrictions are tested.
- **Supply-chain closure:** FFmpeg, ffprobe, whisper.cpp, and the model are pinned with exact sources/hashes. Sidecars ship per target; the model remains opt-in.
- **Placeholder scan:** No TBD, TODO, unspecified codec, unstated limit, unnamed model, unpinned dependency, or deferred acceptance criterion remains.
- **Type consistency:** TypeScript and Rust use the same camelCase values for metadata, capabilities, progress, and consent. The `video-progress` event is live-only; final diagnostics use the existing RuntimeActivity path.
- **Verification honesty:** Automated gates cover all platforms; final GUI proof uses only the installed macOS app through @Computador. A missing runtime or TCC permission produces a blocked/partial report, never an invented pass.
