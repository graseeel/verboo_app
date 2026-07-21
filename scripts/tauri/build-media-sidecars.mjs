import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '../..')
const manifestPath = path.join(path.dirname(scriptPath), 'media-sidecars.json')
const sourceNames = ['ffmpeg', 'zimg', 'whisperCpp']

export const SUPPORTED_TARGETS = Object.freeze([
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
])

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // objdump -p on a statically linked ffmpeg.exe far exceeds the 1 MiB
    // spawnSync default (ENOBUFS); 64 MiB covers every probe output.
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Command failed: ${commandName} ${args.join(' ')}\n${result.stderr || result.stdout || ''}`)
  }
  return `${result.stdout || ''}${result.stderr || ''}`
}

// ── Windows/MSYS2 support ─────────────────────────────────────────────
// Windows node spawns MSYS2 tools as plain (non-login) children, where the
// perl autotools mis-derive their prefix (aclocal loses the drive letter and
// every system m4 macro "disappears"). unixBuildCommand reruns the command
// inside a login bash with POSIX paths, the environment those tools are
// actually tested in. cmake keeps direct invocation: mingw cmake wants
// Windows paths.
function toPosixPath(value) {
  return value.replace(/([A-Za-z]):[\\/]/g, (_, drive) => `/${drive.toLowerCase()}/`).replace(/\\/g, '/')
}

function unixBuildCommand(commandName, args, options = {}) {
  if (process.platform !== 'win32') {
    inheritedCommand(commandName, args, options)
    return
  }
  const posixArgs = args.map(argument => toPosixPath(argument))
  const posixCommand = toPosixPath(commandName)
  const cwd = options.cwd ?? repositoryRoot
  const environment = { ...(options.env ?? process.env) }
  environment.CHERE_INVOKED = '1'
  // A login shell (-l) is required for the perl autotools to derive their
  // prefix correctly, but /etc/profile RESETS PKG_CONFIG_PATH. Carry it in a
  // profile-safe custom var and re-export it inside, after profile has run.
  if (environment.PKG_CONFIG_PATH) {
    environment.VERBOO_PKG_CONFIG_PATH = toPosixPath(environment.PKG_CONFIG_PATH)
  }
  inheritedCommand('bash', [
    '-leo', 'pipefail',
    '-c', 'cd "$0" && { [ -n "$VERBOO_PKG_CONFIG_PATH" ] && export PKG_CONFIG_PATH="$VERBOO_PKG_CONFIG_PATH"; }; exec "$@"',
    toPosixPath(cwd), posixCommand, ...posixArgs,
  ], { env: environment })
}

function inheritedCommand(commandName, args, options = {}) {
  process.stdout.write(`> ${[commandName, ...args].join(' ')}\n`)
  execFileSync(commandName, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    ...options,
  })
}

function isWindowsTarget(target) {
  return target.includes('windows')
}

function targetPlatform(target) {
  if (target.includes('apple-darwin')) return 'darwin'
  if (target.includes('windows')) return 'win32'
  if (target.includes('linux')) return 'linux'
  throw new Error(`Unsupported target: ${target}`)
}

function assertSupportedTarget(target) {
  if (!SUPPORTED_TARGETS.includes(target)) {
    throw new Error(`Unsupported target: ${target || '<empty>'}`)
  }
  return target
}

export function binaryFilename(name, target) {
  assertSupportedTarget(target)
  if (!['ffmpeg', 'ffprobe', 'whisper'].includes(name)) {
    throw new Error(`Unsupported media sidecar: ${name}`)
  }
  return `verboo-${name}-${target}${isWindowsTarget(target) ? '.exe' : ''}`
}

export function requestedTarget(args = process.argv.slice(2)) {
  const inline = args.find((argument) => argument.startsWith('--target='))
  const target = inline
    ? inline.slice('--target='.length)
    : args[args.indexOf('--target') + 1]
  if (!target) throw new Error('An explicit --target is required')
  return assertSupportedTarget(target)
}

export function whisperCmakeArguments(target) {
  assertSupportedTarget(target)
  return [
    '-DBUILD_SHARED_LIBS=OFF',
    '-DGGML_STATIC=ON',
    '-DGGML_BACKEND_DL=OFF',
    // OpenMP pulls a dynamic libgomp-1.dll on mingw that breaks the fully
    // static requirement; ggml's own pthread thread pool covers short-audio
    // transcription without it.
    '-DGGML_OPENMP=OFF',
    ...staticLinkerArguments(target).cmake,
  ]
}

export function staticLinkerArguments(target) {
  assertSupportedTarget(target)
  if (targetPlatform(target) === 'linux') {
    return { ffmpeg: ['--extra-ldflags=-static'], cmake: ['-DCMAKE_EXE_LINKER_FLAGS=-static'] }
  }
  if (isWindowsTarget(target)) {
    return {
      ffmpeg: ['--extra-ldflags=-static', '--extra-libs=-static-libgcc -static-libstdc++ -lwinpthread'],
      cmake: ['-DCMAKE_EXE_LINKER_FLAGS=-static -static-libgcc -static-libstdc++'],
    }
  }
  return { ffmpeg: [], cmake: [] }
}

const WINDOWS_SYSTEM_DLLS = new Set([
  'ADVAPI32.DLL', 'BCRYPT.DLL', 'COMDLG32.DLL', 'CRYPT32.DLL', 'GDI32.DLL',
  'KERNEL32.DLL', 'MSVCRT.DLL', 'NTDLL.DLL', 'OLE32.DLL', 'OLEAUT32.DLL',
  'SHELL32.DLL', 'SECUR32.DLL', 'USER32.DLL', 'VERSION.DLL', 'WS2_32.DLL',
])

export function unexpectedWindowsDlls(objdumpOutput) {
  return [...objdumpOutput.matchAll(/^\s*DLL Name:\s*(\S+)/gmi)]
    .map((match) => match[1])
    .filter((name) => !WINDOWS_SYSTEM_DLLS.has(name.toUpperCase()))
}

export function requiredFfmpegCapabilities(target) {
  assertSupportedTarget(target)
  const encoders = ['png', 'pcm_s16le', 'aac']
  if (targetPlatform(target) === 'darwin') encoders.push('h264_videotoolbox')
  // Windows deliberately ships no guaranteed H.264 encoder: h264_mf needs
  // Media Foundation, which the minimal LGPL mingw build cannot link. Like
  // Linux, Windows falls back to sampled frames; the runtime toolchain probe
  // (router.rs) reports the encoder as unavailable and routes accordingly.
  return {
    encoders,
    filters: [
      'select', 'scale', 'format', 'fps', 'thumbnail', 'showinfo', 'aresample',
      'aformat', 'tonemap', 'zscale',
    ],
    demuxers: ['mov', 'matroska', 'webm', 'avi'],
  }
}

function hasFfmpegEntry(output, name) {
  return new RegExp(`(^|[^A-Za-z0-9_])${name}(?=$|[^A-Za-z0-9_])`, 'm').test(output)
}

export function missingFfmpegCapabilities(outputs, target) {
  const required = requiredFfmpegCapabilities(target)
  const missing = []
  for (const [kind, names] of Object.entries(required)) {
    for (const name of names) {
      if (!hasFfmpegEntry(outputs[kind], name)) missing.push(`${kind.slice(0, -1)}: ${name}`)
    }
  }
  return missing
}

function assertPinnedSource(source, name) {
  if (!source || typeof source !== 'object') throw new Error(`Missing ${name} pin`)
  if (typeof source.url !== 'string' || !source.url.startsWith('https://')) {
    throw new Error(`Invalid ${name} URL`)
  }
  if (typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) {
    throw new Error(`Invalid ${name} SHA-256`)
  }
}

function validateManifest(manifest) {
  for (const name of sourceNames) assertPinnedSource(manifest[name], name)
  assertPinnedSource(manifest.whisperModel, 'whisper model')
  if (!Number.isSafeInteger(manifest.whisperModel.size) || manifest.whisperModel.size <= 0) {
    throw new Error('Invalid whisper model size')
  }
  return manifest
}

export async function loadManifest() {
  return validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
}

export async function verifySha256(file, expected) {
  const actual = createHash('sha256').update(await readFile(file)).digest('hex')
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${file}: expected ${expected}, got ${actual}`)
  }
  return actual
}

export function buildRecipeFingerprint(manifest, builderRecipe) {
  return createHash('sha256')
    .update(JSON.stringify(manifest))
    .update('\0')
    .update(builderRecipe)
    .digest('hex')
}

async function manifestFingerprint(manifest) {
  return buildRecipeFingerprint(manifest, await readFile(scriptPath, 'utf8'))
}

function cacheDirectory(fingerprint, target) {
  const base = process.env.VERBOO_MEDIA_SIDECAR_CACHE
    || path.join(homedir(), '.cache', 'verboo-media-sidecars')
  return path.join(base, fingerprint, target)
}

function archiveExtension(url) {
  if (url.endsWith('.tar.xz')) return '.tar.xz'
  if (url.endsWith('.tar.gz')) return '.tar.gz'
  throw new Error(`Unsupported source archive: ${url}`)
}

async function exists(file) {
  try {
    await stat(file)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function fetchPinnedArchive(name, source, sourceDirectory) {
  await mkdir(sourceDirectory, { recursive: true })
  const archive = path.join(sourceDirectory, `${name}-${source.version}${archiveExtension(source.url)}`)
  if (await exists(archive)) {
    try {
      await verifySha256(archive, source.sha256)
      return archive
    } catch {
      await rm(archive, { force: true })
    }
  }

  const temporary = await mkdtemp(path.join(tmpdir(), `verboo-${name}-download-`))
  const downloaded = path.join(temporary, path.basename(archive))
  try {
    process.stdout.write(`Downloading pinned ${name} ${source.version}\n`)
    const response = await fetch(source.url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`Could not download ${name}: HTTP ${response.status}`)
    await writeFile(downloaded, Buffer.from(await response.arrayBuffer()))
    await verifySha256(downloaded, source.sha256)
    await rename(downloaded, archive)
    return archive
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function sourceRoot(name, source, sourceDirectory) {
  const archive = await fetchPinnedArchive(name, source, sourceDirectory)
  const destination = path.join(sourceDirectory, `${name}-${source.version}-source`)
  if (await exists(destination)) return destination

  const temporary = await mkdtemp(path.join(tmpdir(), `verboo-${name}-extract-`))
  try {
    // On Windows the MSYS2 GNU tar chokes on drive-letter paths (with and
    // without --force-local); the System32 bsdtar handles them natively and
    // reads .tar.gz/.tar.xz alike.
    const tarBinary = process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
    inheritedCommand(tarBinary, ['-xf', archive, '-C', temporary])
    const entries = await readdir(temporary, { withFileTypes: true })
    const directories = entries.filter((entry) => entry.isDirectory())
    if (directories.length !== 1) {
      throw new Error(`Expected one ${name} source root, found ${directories.length}`)
    }
    await rename(path.join(temporary, directories[0].name), destination)
    return destination
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

function jobs() {
  return String(Math.max(1, Number(process.env.NUMBER_OF_PROCESSORS) || 4))
}

function cmakePlatformArgs(target) {
  if (target === 'aarch64-apple-darwin') return ['-DCMAKE_OSX_ARCHITECTURES=arm64']
  if (target === 'x86_64-apple-darwin') return ['-DCMAKE_OSX_ARCHITECTURES=x86_64']
  return []
}

function ffmpegPlatformArgs(target) {
  if (target === 'aarch64-apple-darwin') return ['--arch=arm64']
  if (target === 'x86_64-apple-darwin') {
    return ['--arch=x86_64', '--extra-cflags=-arch x86_64', '--extra-ldflags=-arch x86_64']
  }
  if (target === 'x86_64-pc-windows-msvc') {
    return ['--target-os=mingw32', '--arch=x86_64', '--cc=gcc']
  }
  return ['--arch=x86_64']
}

function extraLibraries(target) {
  if (targetPlatform(target) === 'darwin') return '-lc++'
  // The fully static Linux link (and ffmpeg's pkg-config probe, which links
  // the same way) needs pthread and libm resolved explicitly.
  if (targetPlatform(target) === 'linux') return '-lstdc++ -lpthread -lm'
  return '-lstdc++'
}

function buildEnvironment(target, additions = {}) {
  const environment = { ...process.env, ...additions }
  if (target === 'x86_64-apple-darwin') {
    environment.CC = 'clang -arch x86_64'
    environment.CXX = 'clang++ -arch x86_64'
  }
  if (isWindowsTarget(target)) {
    environment.CC = 'gcc'
    environment.CXX = 'g++'
  }
  if (targetPlatform(target) === 'darwin') environment.STL_LIBS = '-lc++'
  return environment
}

async function buildZimg(source, target, staging) {
  const sourceCopy = path.join(staging, 'zimg-source')
  const prefix = path.join(staging, 'zimg-prefix')
  await cp(source, sourceCopy, { recursive: true })
  const environment = buildEnvironment(target)
  unixBuildCommand('bash', ['autogen.sh'], { cwd: sourceCopy, env: environment })
  const zimgConfigure = [
    `--prefix=${prefix}`,
    '--disable-shared',
    '--enable-static',
  ]
  // Without an explicit --host, config.guess reports the arm64 build host
  // and zimg enables ARM SIMD sources that cannot compile under
  // "clang -arch x86_64" (NEON soft-float ABI errors).
  if (target === 'x86_64-apple-darwin') zimgConfigure.push('--host=x86_64-apple-darwin')
  if (target === 'aarch64-apple-darwin') zimgConfigure.push('--host=aarch64-apple-darwin')
  unixBuildCommand(path.join(sourceCopy, 'configure'), zimgConfigure, { cwd: sourceCopy, env: environment })
  unixBuildCommand('make', ['-j', jobs()], { cwd: sourceCopy, env: environment })
  unixBuildCommand('make', ['install'], { cwd: sourceCopy, env: environment })
  if (!(await exists(path.join(prefix, 'lib', 'libzimg.a')))) {
    throw new Error('zimg static install is missing libzimg.a')
  }
  return prefix
}

async function buildFfmpeg(source, target, zimgPrefix, staging) {
  const sourceCopy = path.join(staging, 'ffmpeg-source')
  const prefix = path.join(staging, 'ffmpeg-prefix')
  await cp(source, sourceCopy, { recursive: true })
  const configure = [
    `--prefix=${prefix}`,
    '--disable-everything',
    '--disable-gpl',
    '--disable-nonfree',
    '--disable-network',
    '--disable-autodetect',
    '--disable-doc',
    '--disable-debug',
    '--disable-shared',
    '--enable-static',
    '--enable-zlib',
    '--enable-ffmpeg',
    '--enable-ffprobe',
    '--enable-libzimg',
    '--enable-protocol=file,pipe',
    '--enable-demuxer=mov,matroska,webm,avi',
    '--enable-decoder=h264,hevc,vp8,vp9,av1,prores,aac,mp3,opus,vorbis,pcm_s16le',
    '--enable-parser=h264,hevc,vp8,vp9,av1,aac',
    '--enable-filter=select,scale,format,fps,thumbnail,showinfo,aresample,aformat,tonemap,zscale',
    '--enable-muxer=image2,wav,mp4',
    '--enable-encoder=png,pcm_s16le,aac',
    '--pkg-config-flags=--static',
    `--extra-cflags=-I${path.join(zimgPrefix, 'include')}`,
    `--extra-ldflags=-L${path.join(zimgPrefix, 'lib')}`,
    `--extra-libs=${extraLibraries(target)}`,
    ...staticLinkerArguments(target).ffmpeg,
    ...ffmpegPlatformArgs(target),
  ]
  if (targetPlatform(target) === 'darwin') {
    configure.push('--enable-videotoolbox', '--enable-encoder=h264_videotoolbox')
  }
  const environment = buildEnvironment(target, {
    PKG_CONFIG_PATH: path.join(zimgPrefix, 'lib', 'pkgconfig'),
  })
  try {
    unixBuildCommand(path.join(sourceCopy, 'configure'), configure, { cwd: sourceCopy, env: environment })
  } catch (error) {
    // Surface the real probe failure: configure only prints a summary line,
    // the cause lives at the end of ffbuild/config.log.
    try {
      const log = await readFile(path.join(sourceCopy, 'ffbuild', 'config.log'), 'utf8')
      process.stderr.write(`\n===== ffbuild/config.log (tail) =====\n${log.split('\n').slice(-120).join('\n')}\n`)
    } catch {
      // no log to show
    }
    throw error
  }
  unixBuildCommand('make', ['-j', jobs()], { cwd: sourceCopy, env: environment })
  const extension = isWindowsTarget(target) ? '.exe' : ''
  const ffmpeg = path.join(sourceCopy, `ffmpeg${extension}`)
  const ffprobe = path.join(sourceCopy, `ffprobe${extension}`)
  if (!(await exists(ffmpeg)) || !(await exists(ffprobe))) {
    throw new Error('Pinned FFmpeg build did not produce ffmpeg and ffprobe')
  }
  return { ffmpeg, ffprobe }
}

async function findWhisperCli(directory, extension) {
  const matches = []
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile() && entry.name === `whisper-cli${extension}`) matches.push(child)
    }
  }
  await visit(directory)
  if (matches.length !== 1) {
    throw new Error(`Expected one whisper-cli executable, found ${matches.length}`)
  }
  return matches[0]
}

async function buildWhisper(source, target, staging) {
  const sourceCopy = path.join(staging, 'whisper-source')
  const build = path.join(staging, 'whisper-build')
  await cp(source, sourceCopy, { recursive: true })
  inheritedCommand('cmake', [
    '-S', sourceCopy,
    '-B', build,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_EXAMPLES=ON',
    '-DWHISPER_BUILD_SERVER=OFF',
    ...whisperCmakeArguments(target),
    ...cmakePlatformArgs(target),
    // ggml defaults to -march=native-style host detection; on the arm64
    // runner cross-building x86_64 that emits ARM flags into an x86 build.
    '-DGGML_NATIVE=OFF',
  ], { env: buildEnvironment(target) })
  inheritedCommand('cmake', ['--build', build, '--target', 'whisper-cli', '--parallel', jobs()], {
    env: buildEnvironment(target),
  })
  return findWhisperCli(build, isWindowsTarget(target) ? '.exe' : '')
}

async function assertRegularBinary(binary, root) {
  const details = await lstat(binary)
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Expected a regular executable: ${binary}`)
  const resolvedBinary = await realpath(binary)
  const resolvedRoot = await realpath(root)
  if (!resolvedBinary.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Refusing a binary outside the pinned build: ${binary}`)
  }
}

function verifyFfmpegLicense(binary) {
  const buildConfiguration = command(binary, ['-buildconf'])
  if (/--enable-(gpl|nonfree)\b/.test(buildConfiguration)) {
    throw new Error(`Refusing GPL/nonfree FFmpeg build: ${binary}`)
  }
  const license = command(binary, ['-L'])
  if (!/(?:LGPL|GNU Lesser General Public\s+License)/i.test(license)) {
    throw new Error(`Unexpected FFmpeg license declaration: ${binary}`)
  }
}

function verifyLinkage(binary, target) {
  const platform = targetPlatform(target)
  if (platform === 'darwin') {
    const lines = command('otool', ['-L', binary]).split('\n').slice(1)
    const dependencies = lines.map((line) => line.trim().split(' ')[0]).filter(Boolean)
    if (dependencies.some((dependency) => !(
      dependency.startsWith('/usr/lib/')
      || dependency.startsWith('/System/Library/Frameworks/')
    ))) {
      throw new Error(`Unexpected non-system linkage in ${binary}: ${dependencies.join(', ')}`)
    }
    return
  }
  if (platform === 'linux') {
    const fileOutput = command('file', [binary])
    const dynamic = command('readelf', ['-d', binary])
    if (!isFullyStaticLinuxBinaryDescription(fileOutput) || /\(NEEDED\)/.test(dynamic)) {
      throw new Error(`Linux sidecar is not fully static: ${binary}`)
    }
    return
  }
  const output = command('objdump', ['-p', binary])
  const unexpected = unexpectedWindowsDlls(output)
  if (unexpected.length > 0) {
    throw new Error(`Unexpected Windows DLL linkage in ${binary}: ${unexpected.join(', ')}`)
  }
}

export function isFullyStaticLinuxBinaryDescription(description) {
  return /(?:statically linked|static-pie linked)/i.test(description)
    && !/dynamically linked/i.test(description)
}

async function stripBinary(binary, target) {
  const strip = targetPlatform(target) === 'darwin' ? 'strip' : 'strip'
  inheritedCommand(strip, [binary])
}

async function smokeAndVerify(binaries, target, root) {
  for (const binary of Object.values(binaries)) await assertRegularBinary(binary, root)
  for (const binary of Object.values(binaries)) await stripBinary(binary, target)

  const ffmpegVersion = command(binaries.ffmpeg, ['-version'])
  const ffprobeVersion = command(binaries.ffprobe, ['-version'])
  const whisperHelp = command(binaries.whisper, ['--help'])
  if (!/ffmpeg version/i.test(ffmpegVersion) || !/ffprobe version/i.test(ffprobeVersion)) {
    throw new Error('Pinned FFmpeg smoke check failed')
  }
  if (!/usage|whisper/i.test(whisperHelp)) throw new Error('Pinned whisper smoke check failed')
  const missingCapabilities = missingFfmpegCapabilities({
    encoders: command(binaries.ffmpeg, ['-hide_banner', '-encoders']),
    filters: command(binaries.ffmpeg, ['-hide_banner', '-filters']),
    demuxers: command(binaries.ffmpeg, ['-hide_banner', '-demuxers']),
  }, target)
  if (missingCapabilities.length > 0) {
    throw new Error(`Pinned FFmpeg is missing required capabilities: ${missingCapabilities.join(', ')}`)
  }
  verifyFfmpegLicense(binaries.ffmpeg)
  verifyFfmpegLicense(binaries.ffprobe)
  for (const binary of Object.values(binaries)) verifyLinkage(binary, target)
}

async function buildOrReuse(manifest, target) {
  const fingerprint = await manifestFingerprint(manifest)
  const cache = cacheDirectory(fingerprint, target)
  const sources = path.join(cache, 'sources')
  const build = path.join(cache, 'build')
  const marker = path.join(build, '.verified.json')
  const extension = isWindowsTarget(target) ? '.exe' : ''
  const cachedBinaries = {
    ffmpeg: path.join(build, 'ffmpeg-source', `ffmpeg${extension}`),
    ffprobe: path.join(build, 'ffmpeg-source', `ffprobe${extension}`),
    whisper: path.join(build, 'whisper-bin', `whisper-cli${extension}`),
  }
  const expectedMarker = JSON.stringify({ fingerprint, target })
  if (await exists(marker) && await readFile(marker, 'utf8') === expectedMarker) {
    await smokeAndVerify(cachedBinaries, target, build)
    return cachedBinaries
  }

  const [ffmpegSource, zimgSource, whisperSource] = await Promise.all([
    sourceRoot('ffmpeg', manifest.ffmpeg, sources),
    sourceRoot('zimg', manifest.zimg, sources),
    sourceRoot('whisper-cpp', manifest.whisperCpp, sources),
  ])
  const staging = await mkdtemp(path.join(tmpdir(), `verboo-media-build-${target}-`))
  try {
    const zimgPrefix = await buildZimg(zimgSource, target, staging)
    const ffmpeg = await buildFfmpeg(ffmpegSource, target, zimgPrefix, staging)
    const whisperBuilt = await buildWhisper(whisperSource, target, staging)
    const whisperDirectory = path.join(staging, 'whisper-bin')
    await mkdir(whisperDirectory, { recursive: true })
    const whisper = path.join(whisperDirectory, `whisper-cli${extension}`)
    await rename(whisperBuilt, whisper)
    const binaries = { ...ffmpeg, whisper }
    await smokeAndVerify(binaries, target, staging)
    await writeFile(path.join(staging, '.verified.json'), expectedMarker)
    await mkdir(cache, { recursive: true })
    await rm(build, { recursive: true, force: true })
    await rename(staging, build)
    return cachedBinaries
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

export async function buildMediaSidecars({ target = requestedTarget() } = {}) {
  assertSupportedTarget(target)
  const manifest = await loadManifest()
  const binaries = await buildOrReuse(manifest, target)
  const destinationDirectory = path.join(repositoryRoot, 'src-tauri', 'binaries')
  await mkdir(destinationDirectory, { recursive: true })
  for (const [name, source] of Object.entries(binaries)) {
    const destination = path.join(destinationDirectory, binaryFilename(name, target))
    await copyFile(source, destination)
    await chmod(destination, 0o755)
  }
  const destinations = Object.fromEntries(
    Object.keys(binaries).map((name) => [name, path.join(destinationDirectory, binaryFilename(name, target))]),
  )
  await smokeAndVerify(destinations, target, destinationDirectory)
  process.stdout.write(`Prepared pinned media sidecars for ${target}\n`)
  return destinations
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await buildMediaSidecars()
}
