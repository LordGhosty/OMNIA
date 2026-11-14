# OMNIA 0.0.4

*A little bit of everything, all of the time.*

OMNIA is a desktop multitool for working with files and looking after your PC. Open the Hub when you need to pull audio from a video, find what’s filling a drive, or figure out why your connection dropped. File conversions run on your computer and work offline.

## What’s in the Hub?

- **Audio & Video** — Convert to MP3 or MP4, trim a clip, or make a cropped GIF from a video or still image. The converters also accept supported YouTube, Instagram and Pinterest video links.
- **Images** — Crop, resize and convert pictures in batches. Read, edit or remove metadata, then save a copy. Use **Colour Palette** to see a photo’s dominant colours and copy their hex codes.
- **Files & Storage** — Search a folder or drive, preview a batch rename, compare duplicate files, and see where your disk space goes.
- **Network & Security** — Check local and public IP addresses, trace a route, measure download and upload speeds, or generate an SSH key pair.
- **Windows tools** — Inspect drivers, manage firewall rules, run Windows repairs, and work with an external USB drive when one is connected.

## Getting started

For a new installation or an upgrade from 0.0.2, download **OMNIA-0.0.4-Setup.exe** from [GitHub Releases](https://github.com/LordGhosty/OMNIA/releases). Run the wizard on Windows x64, then open **OMNIA** from the Start menu. The installer includes the runtime. Node.js is only needed to run the project from source.

**Upgrading from 0.0.3?** Open **Updates** in the Hub and click **Check for updates**. When it offers **0.0.4**, choose **Download update**. Finish any active tool operations, then click **Restart and install**. After the restart, the Hub shows **V.0.0.4**.

Setup includes optional Recovery and Validator utilities and an Uninstaller shortcut. Choose them in the wizard. Running a newer setup replaces your existing OMNIA installation and remembers these choices.

The shield enables administrator access for tools that change system settings. The gear opens **Settings**, where you can adjust animations and turn off automatic window resizing when moving between tools and the Hub. A spinner in the Hub shows which tools are still working.

In 0.0.4, the title bar shows **Update available** when OMNIA finds a newer stable release. The Hub shows **RELEASE SIGNATURE VERIFIED** after it checks the installed files against OMNIA’s release key. Windows may still show **Unknown Publisher**.

Tested on Windows 11 x64. Windows 10 22H2 x64 is a target awaiting desktop testing. [Windows compatibility](WINDOWS_COMPATIBILITY.md) · [Release verification](SECURITY.md)

## Running from source

With Node.js 24 and npm installed, run:

```sh
npm ci
npm run prepare:tools
npm start
```

Use `npm test` to run the tests and `npm run build:win` to build the Windows installer. [Contributing](CONTRIBUTING.md)

OMNIA is licensed under [GPL-3.0-or-later](LICENSE). [Third-party software](THIRD_PARTY.md) · [Branding](TRADEMARKS.md)
