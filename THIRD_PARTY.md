# Third-party software

OMNIA uses Electron (MIT, with Chromium and other third-party licenses), Node.js (MIT and third-party notices), electron-updater (MIT), ffmpeg-static (GPL-3.0-or-later), ffprobe-static (MIT wrapper; the FFprobe executable has its own FFmpeg license), and electron-builder (MIT, build time only).

Link importing also bundles official yt-dlp 2026.10.21 and Deno 2.9.8 releases. yt-dlp's core is under the Unlicense; its standalone executables bundle additional dependencies with their own licenses (including GPL-licensed components). Deno is MIT with third-party notices. The core license files and exact runtime version/checksum record are included in `resources/bin`. Consult the release's complete dependency notices before redistribution; the core license is not the license of every bundled component.

Versions and dependency integrity hashes are pinned in package-lock.json. Runtime notice files remain in the packaged application. The bundled FFmpeg and FFprobe executable license/configuration can be inspected with `-L` and `-version`.

- Electron source and notices: https://github.com/electron/electron
- ffmpeg-static package and binary build scripts/source references: https://github.com/eugeneware/ffmpeg-static
- ffprobe-static package and binary origins: https://github.com/joshwnj/ffprobe-static
- FFmpeg source: https://ffmpeg.org/download.html
- FFmpeg licensing: https://ffmpeg.org/legal.html
- electron-updater and electron-builder source: https://github.com/electron-userland/electron-builder
- yt-dlp release and dependency/licensing information: https://github.com/yt-dlp/yt-dlp/tree/2026.10.21
- Deno release and source: https://github.com/denoland/deno/tree/v2.9.8

The 0.0.3 upload folder contains OMNIA’s source archive and bundled dependency notices. Collect the corresponding source and build information for the exact FFmpeg and FFprobe binaries before public binary distribution. See the build identifiers below.

The image/file tools add Sharp 0.35.5 (Apache-2.0), its platform-specific libvips build and codec dependencies, exiftool-vendored 39.0.1 (MIT wrapper), the vendored ExifTool distribution (13.59.3 npm binary package; ExifTool is licensed under the same terms as Perl), and file-type 22.2.0 (MIT). The wrapper's MIT license is not the license of the embedded ExifTool/Perl runtime. Sharp's bundled libvips and codecs likewise carry their own notices and source/relinking requirements. Exact transitive versions are locked in package-lock.json; native package license files remain alongside unpacked native files in installed resources. The image workers load these native helpers from the signed release's file inventory when official signing is configured.

- Sharp source and license: https://github.com/lovell/sharp
- libvips binary build/source information and notices: https://github.com/lovell/sharp-libvips
- ExifTool wrapper and vendored packaging: https://github.com/photostructure/exiftool-vendored.js
- ExifTool source and licensing: https://github.com/exiftool/exiftool
- File identification library: https://github.com/sindresorhus/file-type

Public release preparation must include the corresponding obligations for these exact native builds in addition to the media-engine requirements above. No claim of a completed redistribution-compliance audit is made by the in-app validation badge.

The current Windows FFmpeg identifies itself as Gyan 6.1.1 essentials, upstream commit e38092ef93. Its build configuration ships in FFMPEG-README.txt. The Windows FFprobe in ffprobe-static 3.1.0 identifies itself as 4.0.2. Collect the corresponding source, build scripts, linked library versions and notices for each exact distributed binary before distributing the release. The platform source archives produced by CI cover the OMNIA project itself.
