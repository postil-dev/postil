# postil brand identity

## Voice & positioning

postil is the AI PR reviewer for teams that take code quality seriously. The voice is calm, precise, and quietly confident — like a senior engineer who reviews your diff before stand-up. We never hype, never Fear-Uncertainty-Doubt, and never leak internal tool names. We say exactly what the code needs and stop.

- **Tone:** neutral-positive, clinical when reporting findings, encouraging when approving.
- **Persona:** senior staff engineer. Not flashy, not robotic.
- **Avoid:** AI-isms ("delve", "leverage", "utilize"), marketing superlatives, personal pronouns ("I think"), internal service names.

## Color palette

| Token | Hex | Role | Contrast on black (#0F0F12) | Contrast on white |
|-------|-----|------|----------------------------|-------------------|
| `brand-primary` | `#D97706` | Primary brand, trust | 5.95:1 (AA) | 3.39:1 |
| `brand-secondary` | `#10B981` | Action, success, check-runs | 6.45:1 (AA) | 3.13:1 |
| `bg-base` | `#0F0F12` | Darkest background | — | — |
| `bg-surface` | `#19191D` | Card / panel surface | — | — |
| `text-primary` | `#F5F4EE` | Headlines, primary text | — | — |
| `text-muted` | `#8B8B8E` | Captions, metadata | 9.0:1 (AAA) | 2.75:1 |
| `text-critical` | `#EF4444` | Critical failures only | 6.2:1 (AA) | 3.22:1 |

> All neutral-on-dark ratios meet WCAG 2.1 AA (4.5:1) or AAA (7:1). On white, primary accents are used sparingly for large text only.

## Typography

- **Display / hero:** Display (serif), Georgia fallback. Weight 700, tracking -0.02em.
- **Body:** Inter, system-ui fallback. Weight 400/500, line-height 1.5.
- **Mono:** JetBrains Mono, Menlo, monospace. Weight 400. Used for inline code, diff hunks, file paths.

## Logo system

See `logo-wordmark.svg`, `logo-mark.svg`, and `favicon.svg`.

The mark is an open circle interrupted by a single review-comment dot — a minimal metaphor for "feedback loop".

## Assets

- `avatar.png` — 280 x 280 px, transparent background. Used in GitHub App settings.
- `cards/` — HTML/SVG marketing card templates (homepage hero, about hero, social).
