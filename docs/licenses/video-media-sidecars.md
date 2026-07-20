# Video media sidecars

Verboo Code builds its video-processing sidecars from source at release time.
The exact inputs live in [`scripts/tauri/media-sidecars.json`](../../scripts/tauri/media-sidecars.json);
the build refuses an input whose SHA-256 does not match that manifest.

| Component | Version | Source | SHA-256 | License |
| --- | --- | --- | --- | --- |
| FFmpeg | 8.1.2 | <https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz> | `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c` | LGPL-2.1-or-later build |
| zimg | 3.0.6 | <https://github.com/sekrit-twc/zimg/archive/refs/tags/release-3.0.6.tar.gz> | `be89390f13a5c9b2388ce0f44a5e89364a20c1c57ce46d382b1fcc3967057577` | BSD-2-Clause |
| whisper.cpp | 1.8.5 | <https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.8.5.tar.gz> | `cd702189cb5e608c8bc487f4b151db593c4455925b37cc06ef76b44861911db1` | MIT |

FFmpeg is configured with the following fixed flags on every target:

```text
--disable-everything --disable-gpl --disable-nonfree --disable-network
--disable-autodetect --disable-doc --disable-debug --disable-shared --enable-static
--enable-ffmpeg --enable-ffprobe --enable-libzimg --enable-protocol=file,pipe
--enable-demuxer=mov,matroska,webm,avi
--enable-decoder=h264,hevc,vp8,vp9,av1,prores,aac,mp3,opus,vorbis,pcm_s16le
--enable-parser=h264,hevc,vp8,vp9,av1,aac
--enable-filter=select,scale,format,fps,thumbnail,showinfo,aresample,aformat,tonemap,zscale
--enable-muxer=image2,wav,mp4 --enable-encoder=png,pcm_s16le,aac
```

zimg is built as a static dependency, enabling FFmpeg's `zscale` and `tonemap`
filters for explicit HDR-to-SDR conversion. macOS additionally enables the
non-GPL `h264_videotoolbox` encoder; Windows enables `h264_mf`. Linux deliberately
does not promise an H.264 encoder: incompatible originals are sampled into frames
instead of being turned into a synthetic proxy.

The FFmpeg configuration disables GPL, nonfree, network, and automatic external
library discovery. This keeps the shipped FFmpeg build under LGPL-2.1-or-later,
but its corresponding source, build configuration, and LGPL notices must remain
available to recipients. Replacing or relinking the LGPL component must not be
technically prohibited. zimg's BSD-2-Clause notice and whisper.cpp's MIT notice
must also accompany distributions where required.

## Whisper model

The `ggml-base.bin` model is intentionally not included in the app bundle. It is
downloaded on demand from
<https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin>, and is
validated against the manifest size (147951465 bytes) and SHA-256
`60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`.
Users can remove that separately downloaded model from the app's video/ASR model
storage; doing so does not remove any bundled executable and causes a fresh,
verified download only when transcription is requested again.

## Português (Brasil)

O Verboo Code constrói seus sidecars de processamento de vídeo a partir do código-fonte no momento do release. As entradas exatas (versões, URLs e SHA-256 de FFmpeg 8.1.2, zimg 3.0.6 e whisper.cpp 1.8.5) vivem em [`scripts/tauri/media-sidecars.json`](../../scripts/tauri/media-sidecars.json); o build recusa qualquer entrada cujo SHA-256 não bata com o manifesto. As flags fixas de configuração do FFmpeg estão listadas na seção em inglês acima.

O zimg é compilado como dependência estática, habilitando os filtros `zscale` e `tonemap` do FFmpeg para conversão explícita de HDR para SDR. O macOS habilita adicionalmente o encoder não-GPL `h264_videotoolbox`; o Windows habilita `h264_mf`. O Linux deliberadamente não promete encoder H.264: originais incompatíveis são amostrados em frames em vez de virar proxy sintético.

A configuração desabilita GPL, nonfree, rede e descoberta automática de bibliotecas externas, mantendo o build do FFmpeg sob LGPL-2.1-or-later — mas o código-fonte correspondente, a configuração de build e os avisos LGPL devem permanecer disponíveis aos destinatários, e substituir/relinkar o componente LGPL não pode ser tecnicamente proibido. Os avisos BSD-2-Clause do zimg e MIT do whisper.cpp também devem acompanhar as distribuições quando exigido.

### Modelo Whisper

O modelo `ggml-base.bin` intencionalmente não é incluído no bundle. Ele é baixado sob demanda de <https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin> e validado contra o tamanho do manifesto (147951465 bytes) e o SHA-256 `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`. O usuário pode remover esse modelo baixado separadamente pelo armazenamento de modelos de vídeo/ASR do app; isso não remove nenhum executável do bundle e apenas provoca um novo download verificado quando a transcrição for solicitada de novo.
