# Postil Brand Guidelines

A calm review-gate for agent-speed development.

## Brand Idea

Postil is a low-noise review gate that catches context-dependent bugs and security issues before they merge and escalate.

Core line:

> Trust the merge, not the speed.

## Logo System

Primary mark:

- Use the two-color arched review-gate mark as the default logo.
- Default colors are gate green and charcoal on ivory or light stone.
- Use the horizontal wordmark lockup when the product name needs to be explicit.
- Use the stacked lockup when vertical space is available and a stronger brand moment is needed.

Logo files:

- `brand/assets/postil_mark_primary_transparent.svg`
- `brand/assets/postil_mark_primary_transparent_1024.png`
- `brand/assets/postil_mark_primary_ivory_square.svg`
- `brand/assets/postil_mark_reverse_charcoal_square.svg`
- `brand/assets/postil_mark_one_color_charcoal.svg`
- `brand/assets/postil_mark_one_color_white.svg`
- `brand/assets/postil_mark_one_color_green.svg`
- `brand/assets/postil_logo_horizontal_lockup.svg`
- `brand/assets/postil_logo_horizontal_lockup_1600.png`
- `brand/assets/postil_logo_horizontal_lockup_tagline_ivory.svg`
- `brand/assets/postil_logo_stacked_lockup.svg`

## Logo Usage

Do:

- Use approved colors and spacing.
- Keep clear space around the mark.
- Use the reverse square mark on dark backgrounds.
- Use one-color charcoal for print, embossing, foil, stamps, or embroidery constraints.

Do not:

- Stretch or skew the mark.
- Use unapproved colors.
- Add shadows, glows, gradients, outlines, or other effects.
- Rebuild or redraw the logo manually.

Minimum size:

- Digital: `16px`
- Print: `12mm`

## Color

| Token | Hex | Use |
| --- | --- | --- |
| Ivory | `#F7F5F1` | Primary page background |
| Charcoal | `#1B2329` | Text, dark surfaces, monochrome mark |
| Gate Green | `#64745C` | Primary logo color, calm brand accent |
| Stone | `#E3DED8` | Borders, secondary surfaces |
| Rust / Copper | `#C24A2A` | Primary CTA, blocking states, sharp emphasis |
| Soft Red | `#D46A6A` | Fail and deletion states |
| Mist | `#C8CDD2` | Muted UI support |

Use rust for calls to action and blocking states, not as the default logo color.

## Typography

Display:

- Source Serif 4
- Use for headlines and moments of clarity and authority.

Body:

- Inter
- Use for UI, body copy, and functional content.

Code:

- IBM Plex Mono
- Use for code, diffs, technical data, and command examples.

Type scale:

- `12 / 14 / 16 / 20 / 24 / 32 / 40 / 56`

Line height:

- Body: `1.4`
- Headings: `1.2`

## Brand Voice

Low-noise:

- Surface what matters.
- Cut the noise.

Local-first:

- Understand local context before global context.

Proof-driven:

- Earn trust with evidence, not claims.

Sturdy:

- Be reliable, predictable, and durable.

Accountable:

- Give clear signals, clear reasons, and clear ownership.

## UI Principles

Buttons:

- Primary action: rust fill with ivory text.
- Secondary action: outlined neutral button.
- Tertiary action: text link with a right arrow.

Badges:

- Addition: soft green.
- Deletion: soft red.
- Context: neutral stone.
- Info: blue outline.

Diff colors:

- Added line: green-tinted background.
- Removed line: red-tinted background.
- Context line: neutral stone background.

Status:

- Pass: green check.
- Warning: rust/orange warning.
- Fail: soft red fail.
- Pending: neutral pending.

Cards:

- Radius: `6px`
- Border: `1px`
- Shadow: `0 1px 2px rgba(0, 0, 0, 0.06)`

Spacing scale:

- `4 / 8 / 12 / 16 / 24 / 32 / 48`

## Website Direction

Website hero example:

- Use the horizontal lockup in the header.
- Use the headline `Trust the merge, not the speed.`
- Pair calm editorial typography with a product-relevant architectural or review-gate image.
- Keep primary actions direct, such as `Try the CLI` and `Read the docs`.
- Avoid a generic single-page SaaS layout when deeper product explanation is needed.

## Transactional Email

Postil email uses one shared HTML and plain-text renderer for verification,
account, installation, billing, and service-monitor messages.

- Lead with the event and required action. State why the recipient received the message.
- Keep one primary action. Put operational identifiers in compact labeled rows.
- Use live text, system fonts, table layout, inline styles, a 600px maximum width,
  mobile layout rules, dark-mode colors, and Outlook button padding.
- Include a complete plain-text version. Render every production message through
  `bun run email:preview` before release.
- Do not add images, web fonts, CSS imports, background URLs, scripts, iframes,
  media, or links beyond the explicit primary action. The application validates
  this before it sends or previews a message.
- Delivery uses Brevo's authenticated HTTPS REST API at
  `https://api.brevo.com/v3/smtp/email`. The `smtp` path segment is an API route
  name; SMTP transport is prohibited. Provider-side tracking and
  retention are separate from the application HTML. Configure anonymous
  transactional-email tracking and an appropriate log-retention period in the
  Brevo account when available. Delivery does not depend on either setting.
- Product and operator message code uses the shared send function. Provider
  endpoints, authentication, idempotency fields, and response handling stay in
  its adapter. Do not call a provider API directly from a message producer.

## Favicon Scaling

Use the supplied square favicon exports:

- `brand/assets/favicon_16x16.png`
- `brand/assets/favicon_24x24.png`
- `brand/assets/favicon_32x32.png`
- `brand/assets/favicon_48x48.png`
- `brand/assets/favicon_64x64.png`
- `brand/assets/favicon_128x128.png`
- `brand/assets/favicon_256x256.png`
- `brand/assets/favicon_512x512.png`

Reference sizes:

- `64px`
- `32px`
- `16px`
- `12px`
- `8px`

## Merch And Print

Approved merch assets:

- `brand/assets/postil_merch_sticker_diecut.svg`
- `brand/assets/postil_merch_embroidered_patch.svg`
- `brand/assets/postil_merch_tshirt_chest_print_one_color.svg`
- `brand/assets/postil_merch_notebook_mock.svg`
