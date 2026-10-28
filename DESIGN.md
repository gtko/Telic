# DESIGN.md

Design tokens and principles for the planner web app (`apps/web`). Extracted from
the established system in `apps/web/src/app/globals.css` (Tailwind v4 `@theme` +
`:root`/`.dark` OKLCH variables). Those CSS variables are the source of truth; this
file mirrors them. When a token changes in `globals.css`, update it here in the same
change. The full brand charter (logo, colour rules, motion, components, before and after
screens) is `docs/brand/aurora-charter.html`.

## Direction

Aurora: a deep-black, calm, precise product UI. Surfaces are near-black steps with a faint
cool tint (OKLCH hue 258–271, chroma ≤ 0.012). Hierarchy is carried by type weight, spacing,
and small background shifts rather than boxes and lines. Colour is kept for the moments that
matter: state, priority, focus, and the Arc gradient. This is an **app/tool** register —
clarity over cleverness; no decoration that does not aid comprehension.

The Arc is a gradient from indigo through magenta to amber (`brand-arc`). It is a rare
signature:

- One large gradient per screen.
- At most 8% of the visible surface.
- Never behind long text.

Both themes are Aurora. The light theme takes the same cool neutrals with the lightness
inverted (page 0.985, cards 0.998, hover 0.955), and darker state and priority hues that hold
3:1 on the page. The Arc and the brand mark in color stay on dark surfaces: the amber dot
measures 1.63:1 on a light one.

## Tokens (intent-named; values live in `globals.css`)

Colors are OKLCH. The light theme uses cool neutrals (hue 265, chroma ≤ 0.014). The dark
theme is the Aurora ramp: `background` is `oklch(0.122 0.006 261.6)` (#050608), and the surfaces
step up from it (`sidebar` 0.150, `card` 0.172, `popover`/`muted`/`accent` 0.200,
`secondary` 0.235). No surface in the light theme sits on pure white or pure black. Light and
dark are both first-class (`.dark` class toggles; the app ships a theme switch).

- `background` / `foreground` — page base and primary text.
- `card` / `card-foreground` — a raised surface (modals, popovers, kanban detail).
  Only a few percent off `background`; use a background shift, not a border, to raise.
- `muted` / `muted-foreground` — quiet fills and secondary text. In dark, `muted-foreground`
  is `oklch(0.86 0.01 266)` (Lc ≈ 78 on `background` and `card`, ≈ 77 on `secondary`).
- `secondary` — the active/selected chip fill (tabs, toggles).
- `accent` / `accent-foreground` — hover fill for interactive rows/buttons.
- `border` — hairline; in dark it is `white / 7%`, i.e. a tint, never flat gray. `input` is
  `white / 12%`.
- `primary` — high-contrast solid (primary buttons); near-black in light, near-white
  in dark.
- `destructive` — error / overdue / delete only. It serves two roles at once: `text-destructive`
  on the page, and a fill under the white label of a destructive button or badge.
- `warning` — a state that needs attention but has refused nothing, where `destructive` would
  overstate it: a soft WIP limit is at its maximum while a hard one has blocked the move. Text
  and low-opacity tint only; there is no warning button, so it is tuned for the page background
  alone. An amber rather than a bright yellow — yellow at a legible chroma has to drop this far
  in lightness to hold contrast against the light page.
- `ring` — focus ring (keyboard a11y). Indigo in dark.
- `chart-1…5` — indigo, magenta, amber, mint, sky, darker in light. For categorical series that need to be told apart (priority, assignee), widgets use
  their own small hue palette; for entity series (status, type) the entity's own color is used.
- `priority-low|medium|high|urgent` — fixed hues for the priority field: sky, yellow, orange
  and red in both themes, darker in light; `priority-urgent` equals `destructive`.
- `sidebar-*` — the app sidebar surface (slightly off the page background).
- `brand-arc-1|2|3` — indigo, magenta, amber. `brand-arc` is the gradient
  `linear-gradient(100deg, arc-1 0%, arc-2 55%, arc-3 100%)`. Same value in both themes.
  Tailwind utilities: `text-brand-arc-1`, `bg-brand-arc-3`, and so on.
- `status-backlog|todo|in-progress|in-review|done|canceled` — the issue state colours:
  gray, light gray, amber, periwinkle, mint, dim gray, darker in light. Tailwind utilities:
  `text-status-done`. Progress bars and switches use `status-done`. A column's state icon
  takes the column's stored color; a new project's columns start on the Aurora hex values
  (`DEFAULT_COLUMNS` in the api).
- Stored colors and chart series need a literal hex: `utils/auroraColors.ts` holds the
  Aurora accents (indigo, magenta, amber, mint, sky, coral, red, periwinkle) and the state
  grays. Avatars, chart series, cycle, initiative and annotation colors, the color picker and
  the issue type presets take them. Avatars carry near-black initials.
- `surface-highlight` — the 1px inset light on the top edge of a raised surface (cards,
  kanban cards, the active sidebar item). `lift-shadow` — the shadow of a kanban card that
  rises 2px on hover. `ambient-glow` — the indigo light in the top corner of the work area.
- `--ease-out` `cubic-bezier(.16,1,.3,1)`, `--ease-in-out` `cubic-bezier(.65,0,.35,1)`,
  `--ease-spring` `cubic-bezier(.34,1.56,.64,1)` — motion curves. `--ease-out` and
  `--ease-in-out` replace Tailwind's defaults `ease-out` and `ease-in-out`.
- `--duration-1…5` — 120, 200, 360, 640, 1100 ms. Hover 120–200, panel open 360, section
  entrance 640, signature sequences 1100. A `transition` utility without its own timing
  takes `--duration-1` on `--ease-out`. Buttons scale to 0.97 while pressed.

## Scale & shape

- **Type:** Inter Variable (`--font-sans`, also `--font-heading`) for the interface, Geist
  Mono Variable (`--font-mono`) for issue identifiers, git branches and code. Weight and size
  carry hierarchy — do not add display faces. Body ≥ 14px in dense chrome, ≥ 16px for
  reading. Numbers are tabular everywhere; headings balance their lines.
- **Line-height:** the `--text-*--line-height` tokens in `globals.css` replace Tailwind's
  defaults, which are tuned for 16px prose and leave `text-xs`/`text-sm` cramped. Body sizes
  run 1.5–1.6; headings tighten as they grow (1.25 at `2xl` down to 1.1 at `4xl`) and take
  negative tracking from `2xl` up.
- **Radius:** base `--radius: 0.75rem`; scale `sm .6 · md .8 · lg 1 · xl 1.4 · 2xl 1.8`
  (about 7 · 10 · 12 · 17 · 22 px). Kanban cards and menus 12 px, kanban columns 17 px,
  dialogs 22 px, tags 10 px, buttons and fields 10–12 px.
  Radius scales with element size; keep `padding ≥ radius`.
- **Spacing:** 8pt grid (4 as half-step). Proximity encodes relationship: inside a group
  < between groups < between sections.

## Principles

- **Borderless first.** Separate surfaces by whitespace → background shift → soft
  elevation, in that order. Add a hairline `border` only when those fail, and never a
  flat gray box around every block. No card-in-card. No decorative left-accent strip.
- **One focal point per view; one accent per action.** Reserve `primary` for the single
  main action; secondary actions are ghost/outline.
- **Depth over lines.** Raise a surface with a 3–5% background shift and a soft shadow,
  not a 1px border.
- **Contrast is measured, not eyeballed** — APCA: body `Lc ≥ 75`, large/bold `≥ 45`,
  non-text UI `≥ 30`. `destructive` in dark reaches ~46 as text on the page and ~61 under the
  white label of a destructive button. Both roles are above the large/bold threshold. The
  label stays white: by APCA it measures Lc 61, against 48 for a near-black label.
- **Motion is restrained.** Use the `--duration-*` and `--ease-*` tokens: hover 120–200 ms,
  panel open 360 ms, entrance 640 ms. Animate `transform`, `opacity`, light `filter` and
  `stroke-dashoffset`; honor `prefers-reduced-motion`.
- **The Arc is rare.** One large gradient per screen, at most 8% of the visible surface,
  never behind long text. In the app: the brand mark on the sign-in panel (`TelicMark
  brand`) and the 2px progress line of the active cycle.
- **Empty states are illustrated.** `EmptyState` and `SettingsEmpty` draw `EmptyStateArt`
  (two cards under the arc and its amber dot), one sentence and an action.
- **Unread is amber.** The sidebar counters and the unread dot of the inbox use `brand-arc-3`.

## Settings pages (account, project, god)

A settings page is a centered measure of stacked groups: a small heading with an optional
one-line explanation, then its rows, groups separated by space and a hairline rule — no box
around a group and no card per row. A row puts its name and explanation on the left and its
control in a fixed-width column on the right, so every control on the page lines up; below
`sm` the control drops under the text. A page whose changes save on the spot reports that in
the header (saving, then saved) rather than freezing its controls.

## Dashboards section (full-width, borderless)

The analytics dashboards render edge-to-edge inside the app shell: a full-width content
column (comfortable side padding, no narrow centered measure), widgets laid out on a
12-column grid, each widget a borderless section — a quiet header (title + its own
controls) over the body, separated from neighbors by space and a hairline divider under
the header, not by a card. Full-bleed widgets (stat strip, pulse) break the two-column
rhythm so the page is not one repeated shape.
