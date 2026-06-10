# Design languages — and how figbridge detects them

Matching copy, colour, and spacing isn't enough. Each visual style has a
*signature* — the signals that make a UI read as glass, or cinematic, or clay.
If a mockup-vs-app diff can't see those signals, the app can match every text
string and still feel wrong.

`spec-diff.js` now compares the style-defining fields per node (`diffSpecs`) and
fingerprints the whole tree (`styleProfile` / `compareStyleProfiles`). This file
is the map from style → defining signal → how figbridge catches it.

| Style | Defining signals | Extractor field (`dom-to-spec`) | Diff coverage |
|---|---|---|---|
| **Glassmorphism** | `backdrop-filter: blur()`, translucent fills (low alpha), fine semi-transparent borders, vibrant bg | `backdropBlur`, `fill[].alpha`, `stroke.{alpha,width}` | `elevation.backdropBlur`, `color.fill` (alpha), `color.stroke` (width+alpha) · profile: `backdropBlur`, `translucentFills`, `fineBorders` |
| **Cinematic / Dark** | deep-not-pure-black canvas, glow shadows (`0 0 40px`), gradient borders/beams, header letter-spacing, text glow | `fill` (gradient layers), `shadow[].blur`, `letterSpacing`, `textShadow` | `color.fill` (gradients), `elevation.shadow` (glow), `typography.letterSpacing`, `elevation.textShadow` · profile: `gradients`, `glowShadows`, `textGlow` |
| **Neumorphism** | dual light+dark shadows, element colour == bg (monochrome) | `shadow[]` (multi-layer) | `elevation.shadow` (full multi-shadow sig) · profile: `insetShadows` |
| **Claymorphism** | big radius (≥24px / pill), inset + outer shadows, pastel | `cornerRadius`, `shadow[].inset` | `spacing.cornerRadius`, `elevation.shadow` (inset) · profile: `bigRadius`, `insetShadows` |
| **Bento grid** | modular rounded cells, asymmetric sizes | `layout`, `cornerRadius`, `width/height` | `spacing.layout/cornerRadius/width/height` |
| **Flat / Material** | solid colours, elevation shadows, crisp type, whitespace | `fill` (solid), `shadow`, `padding`, `spacing` | `color.fill`, `elevation.shadow`, `spacing.*` |

## Text & formatting (often-missed)

Copy can match while *formatting* diverges — these now diff:

- **`textTransform`** — `.label-tiny { text-transform: uppercase }` renders "FOLDERS"; the DOM text is still "Folders", so a copy diff sees no change. `typography.textTransform` catches it.
- **`textDecoration`** — underline / strikethrough.
- **`textShadow`** — cinematic text glow → `elevation.textShadow`.
- **`letterSpacing`, `lineHeight`** — already in `typography`.

## The fingerprint

`styleProfile(spec)` counts: `gradients`, `glowShadows` (blur ≥ 20), `insetShadows`,
`backdropBlur`, `translucentFills` (alpha < 0.95), `bigRadius` (≥ 24px),
`fineBorders` (≤1.5px + translucent), `uppercaseLabels`, `textGlow` — and infers a
`dominant` style set. `compareStyleProfiles(mockup, app)` flags any signal the app
delivers at < 60 % of the mockup's count. `match_mockup` returns this as `styleGap`,
so a punch-list can read: *"mockup is cinematic-dark (32 gradients, 3 glow); app has
4 and 0 → depth missing"* — a style-level gap pure copy/colour/spacing diffing misses.

Reference profiles (real ShotSelect mockups, 1500px):

```
cull.html      → [glassmorphism, cinematic-dark, claymorphism]  gradients:32 glow:3 glassBlur:8 UPPER:6
privacy.html   → [glassmorphism, claymorphism]                  gradients:1  glow:1 glassBlur:2 UPPER:2
```

ShotSelect's house style is **cinematic-dark + glass** (near-black `#070708` photo
stage, lifted `--el-0..3` elevation ladder, glass titlebar, gradient tiles). Those
are exactly the signals to weight when bringing the app up to the mockups.
