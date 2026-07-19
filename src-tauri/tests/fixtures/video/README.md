# Video probe fixtures

`renamed-text.mp4` is a deliberately invalid text fixture used to prove that
an extension never makes a file a video attachment.

The production sidecar was checked with these exact commands:

```sh
src-tauri/binaries/verboo-ffmpeg-aarch64-apple-darwin -formats
src-tauri/binaries/verboo-ffmpeg-aarch64-apple-darwin -encoders

```

The current deliberately-minimal LGPL sidecar has no `lavfi`, `rawvideo`, or
PCM input demuxer, and no HEVC or VP9 encoder. It therefore cannot synthesize
those source streams without broadening the production sidecar. The following
one-time fixture-generation deviation used Homebrew FFmpeg 8.1.1 only; it is
never consulted by the app or its tests at runtime:

```sh
/opt/homebrew/bin/ffmpeg -y -f lavfi -i testsrc2=size=16x16:rate=1 -f lavfi -i sine=frequency=1000:sample_rate=8000 -t 1 -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 16k -movflags +faststart h264-sdr-aac.mp4
/opt/homebrew/bin/ffmpeg -y -f lavfi -i sine=frequency=1000:sample_rate=8000 -t 1 -c:a aac -b:a 16k -movflags +faststart audio-only-aac.mp4
/opt/homebrew/bin/ffmpeg -y -f lavfi -i testsrc2=size=16x16:rate=1 -t 1 -c:v libx265 -pix_fmt yuv420p10le -x265-params 'log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc' -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -tag:v hvc1 hevc-pq.mov
/opt/homebrew/bin/ffmpeg -y -f lavfi -i testsrc2=size=16x16:rate=1 -t 1 -c:v libvpx-vp9 -b:v 20k -pix_fmt yuv420p vp9-no-audio.webm
```

All generated media is below 200 KB. The integration tests pass these checked
fixtures through the bundled `ffprobe`; deterministic JSON remains for parser
edge cases that do not need real media.
