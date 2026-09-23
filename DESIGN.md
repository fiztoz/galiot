# Galiot — Design System

> *Semantic design tokens shared with Galeon, adapted for Galiot's web-native context.*

---

## Color Palette

### Primary — Gale Teal
The signature Galeon/Galiot accent. Used for interactive elements, navigation highlights,
active states, and primary CTAs.

| Token | Value | Usage |
|---|---|---|
| `--color-teal-600` | `#0d9488` | Primary accent, active nav, buttons |
| `--color-teal-500` | `#14b8a6` | Hover states |
| `--color-teal-400` | `#2dd4bf` | Focus rings, subtle highlights |
| `--color-teal-700` | `#0f766e` | Pressed states |
| `--color-teal-950` | `#042f2e` | Dark mode surfaces with teal tint |

### Secondary — Doubloon Amber
Progress indicators, transfer metrics, warnings, and attention callouts.

| Token | Value | Usage |
|---|---|---|
| `--color-amber-600` | `#d97706` | Transfer progress bars, bandwidth |
| `--color-amber-500` | `#f59e0b` | Hover states |
| `--color-amber-400` | `#fbbf24` | Speed indicators |

### Neutral — Zinc
The foundational UI surface palette. Clean, modern, zero-color-noise.

| Token | Value | Usage |
|---|---|---|
| `--color-zinc-50` | `#fafafa` | Light mode background |
| `--color-zinc-100` | `#f4f4f5` | Light mode cards/surfaces |
| `--color-zinc-200` | `#e4e4e7` | Light mode borders |
| `--color-zinc-400` | `#a1a1aa` | Muted text, placeholders |
| `--color-zinc-600` | `#52525b` | Secondary text |
| `--color-zinc-800` | `#27272a` | Dark mode cards/surfaces |
| `--color-zinc-900` | `#18181b` | Dark mode background |
| `--color-zinc-950` | `#09090b` | Deepest dark surfaces |

### Semantic

| Token | Value | Usage |
|---|---|---|
| `--color-success` | `#22c55e` (green-500) | Completed transfers, connected |
| `--color-error` | `#ef4444` (red-500) | Failed transfers, errors |
| `--color-warning` | `#f59e0b` (amber-500) | Warnings, attention needed |

---

## Typography

| Element | Font | Weight | Size |
|---|---|---|---|
| Headings | `Inter`, system-ui | 600 (semibold) | 1.25–2rem |
| Body | `Inter`, system-ui | 400 (normal) | 0.875rem (14px) |
| Code/Mono | `JetBrains Mono`, `SF Mono`, monospace | 400 | 0.8125rem (13px) |
| Caption | `Inter`, system-ui | 400 | 0.75rem (12px) |

---

## Spacing & Layout

- Base unit: `4px` (0.25rem)
- Content padding: `16px` (1rem)
- Card padding: `12–16px`
- Gap between elements: `8–12px`
- Border radius: `6px` (cards), `4px` (buttons), `9999px` (pills)

---

## Dark Mode

Galiot defaults to **system preference** (`prefers-color-scheme`) with manual toggle.
Dark mode uses `zinc-900`/`zinc-950` surfaces with teal accents remaining vibrant.

---

## Iconography

**Lucide React** — lightweight, consistent, MIT-licensed icon set.
Stroke width: 1.5px. Size: 16px (inline), 20px (buttons), 24px (navigation).
