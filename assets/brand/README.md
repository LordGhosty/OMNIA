# OMNIA icon

`omnia-original.png` is the supplied studio drawing, unchanged.

The four final variants are produced directly from its pixels:

- `omnia-light.png`: white ink, transparent background.
- `omnia-dark.png`: black ink, transparent background.
- `omnia-light-on-black.png`: white ink on black.
- `omnia-dark-on-white.png`: black ink on white.

No orbital paths are redrawn. Light paper pixels are removed using a luminance mask with feathered stroke edges, then the original drawing is centered in a square. `scripts/generate-icon.ps1` reproduces the variants, application PNG and multi-resolution Windows ICO. It requires PowerShell 7 and System.Drawing on Windows. `omnia-circle.png`, `assets/app-icon.png` and the ICO put the original white drawing on a circular black disc with transparent outer corners. The in-app wordmark and webpages retain the transparent white variant in `assets/icon.png`.

The atom is OMNIA’s brand icon. Tool-specific insignia are defined separately in `web/insignia.js`: the audio waveform, continuously scrolling filmstrip and looping GIF stack are assigned to the three converters. The filmstrip repeats frames and sprocket holes over one frame width for a seamless loop. All insignia respect reduced-motion preferences.
