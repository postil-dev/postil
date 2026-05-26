# postil brand identity

## Voice & positioning

postil is the low-noise review gate for teams working at agent speed. The voice is calm, precise, and operational. We never hype, never Fear-Uncertainty-Doubt, and never leak internal tool names. We say exactly what can affect merge and stop.

- **Tone:** neutral, clinical when reporting findings, silent when clean.
- **Persona:** senior staff engineer. Not flashy, not robotic.
- **Avoid:** AI-isms ("delve", "leverage", "utilize"), marketing superlatives, personal pronouns ("I think"), internal service names.

## Color palette

| Token | Hex | Role | Contrast on black (#0A0A0F) | Contrast on white |
|-------|-----|------|----------------------------|-------------------|
| `brand-primary` | `#5C4DFF` | Primary brand, trust | 4.72:1 (AA large) | 3.99:1 |
| `brand-secondary` | `#00D2AA` | Action, success, check-runs | 7.11:1 (AAA) | 2.71:1 |
| `brand-accent` | `#FF8C42` | Attention, HIGH finding | 8.23:1 (AAA) | 2.35:1 |
| `bg-base` | `#0A0A0F` | Darkest background | n/a | n/a |
| `bg-surface` | `#14141A` | Card / panel surface | n/a | n/a |
| `text-primary` | `#FFFFFF` | Headlines, primary text | n/a | n/a |
| `text-muted` | `#9A9AA0` | Captions, metadata | 10.2:1 (AAA) | 2.54:1 |
| `text-critical` | `#FF5A5A` | Critical failures only | 7.85:1 (AAA) | 2.71:1 |

> All neutral-on-dark ratios meet WCAG 2.1 AA (4.5:1) or AAA (7:1). On white, primary accents are used sparingly for large text only.

## Typography

- **Display / hero:** Geist, Inter fallback. Weight 700, tracking -0.02em.
- **Body:** Inter, system-ui fallback. Weight 400/500, line-height 1.5.
- **Mono:** JetBrains Mono, Menlo, monospace. Weight 400. Used for inline code, diff hunks, file paths.

## Logo system

See `logo-wordmark.svg`, `logo-mark.svg`, and `favicon.svg`.

The mark is an open circle interrupted by a single review-comment dot: a minimal metaphor for "feedback loop".

## Assets

- `avatar.png` - 280 x 280 px, transparent background. Used in GitHub App settings.
- `cards/` - HTML/SVG marketing card templates (homepage hero, about hero, social).
