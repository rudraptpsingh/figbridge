# figbridge style kits

Canonical, production-grade **base UI kits** — one per design language. Each kit
is the complete foundation set (tokens + typography + icons + every primitive)
for a style, so design *and* code production start from a known-good, tokens-driven
base instead of reinventing buttons and pills every time.

Each kit is three files:

| File | Purpose |
|---|---|
| `tokens.json` | machine-readable design tokens — the code side consumes these (and `map_components` / `source-index` resolve literals → token names against them) |
| `_kit.css` | the primitive stylesheet — every value references a `--var` that exists in `tokens.json` |
| `kit.html` | a self-contained gallery demonstrating every primitive in all its interaction states |

**Base primitive set** (drilled completely in each kit): design tokens
(color · elevation · radius · spacing · type scale · shadow/glow · border) ·
full typography scale · ~icon sprite · buttons (primary/secondary/ghost/danger/
success/xs/icon + hover/active/focus/disabled) · badges & pills · chips · inputs
(text/search/textarea/select) · toggle · segmented · checkbox/radio · cards
(base/hover/selected/glass/beam) · tabs · kbd · avatars · tooltip · divider ·
skeleton · ratio + progress · spinner + live-dot.

## How they plug into figbridge

- **Verification:** every kit must fingerprint as its own style under
  `styleProfile()` (see `spec-diff.js`). That's the kit's acceptance test — a
  cinematic-dark kit that doesn't read as cinematic-dark is wrong.
- **Code production:** `tokens.json` feeds the token map used by `match_mockup`'s
  `sourceDir` resolution, so a colour literal in a diff resolves to `var(--token)`.
- **Design production:** `kit.html` is a ready starting point for `import_from_code`
  / `import_url` (→ Figma) and for new mockups.

## Styles

| Style | Status | Signature (see `DESIGN-LANGUAGES.md`) |
|---|---|---|
| **cinematic-dark** | ✅ built | near-black canvas, lifted elevation ladder, glow shadows, gradient beams, header tracking, glass |
| glassmorphism | ⏳ planned | backdrop-blur, translucent fills, fine borders, vibrant bg |
| flat / material | ⏳ planned | solid colours, elevation shadows, crisp type, whitespace |
| claymorphism | ⏳ planned | big radius, inset + outer shadows, pastel |
| bento | ⏳ planned | modular rounded cells, asymmetric grid |

Each new kit copies `cinematic-dark/`'s three-file structure and the same primitive
checklist, swapping only the tokens + the style-defining treatment.
