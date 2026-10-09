---
name: linaw-ui
description: Linaw's design system and accessibility rules for the React UI in apps/web. Use when building or changing any screen, component, style, copy, or state (waiting, listening, offline, stopped, loading, empty, error) in Linaw.
---

# Linaw UI

The design is "Linaw · UI/UX v1": 10 screens covering start, the share-tab helper, the live session in light, high-contrast and tablet layouts, "What did they say?", summary, ask (empty and with answers), settings, and the waiting, stopped and long-session states. The live session is the core screen: top bar, a cards column (newest first), the live transcript on the right, and the action bar at the bottom.

## Who it's for

People following a hearing who don't know legal English. Many are older or have low vision. Every decision favors **legibility and calm** over density.

## Tokens (in `apps/web/src/styles.css`)

- Colors come only from CSS variables. The palette is monochrome, black on white: `--bg --surface --fg --fg-2 --body --muted --line --hair --border --border-ai --now-bg --hover --skeleton*`. Never hard-code a color in a component.
- **High contrast** is `:root[data-theme='hc']`: white on black, `--stroke: 2px`, thicker borders. Every new style must look right in both themes. Check it with Settings → High contrast.
- Font: Atkinson Hyperlegible, bundled through `@fontsource`. Never load fonts from the network.
- Sizes are in **rem**. 1rem = 16px at the default "A+" text size, so convert design px ÷ 16. The text-size setting scales `html` font-size, so px sizes break it.
- Type scale from the design: card term 1.75rem/700; meaning 1.25rem; example 1.1875rem; body 1.0625–1.125rem; eyebrow 0.875rem uppercase 700 with 0.06em tracking.
- Radii: cards 1rem, buttons 0.625–0.875rem, pills 999px.

## Meaning carried by shape, not color

- `checked` (glossary) card: **solid** 1px border plus a "Checked" badge with `ShieldCheck`.
- `ai` card: **dashed** border plus an "AI-explained" badge with `Cpu`. Always show which kind a card is.
- Transcript term: **dotted** underline while pending, **solid** once explained (and clickable to jump to its card).
- Status pills: listening is outlined, waiting is dashed and muted, stopped is solid inverted, offline is outlined with `WifiOff` and "Offline mode — still working".

## Accessibility checklist

- Touch targets ≥ 2.75rem (44px). Primary actions are 3.75–4rem tall.
- Every icon-only button has `aria-label`. Decorative icons get `aria-hidden="true"`.
- Mark Tagalog content `lang="tl"` (cards use `lang={card.language}`). UI chrome is in simple English.
- Announce new cards through the polite live region in `LiveScreen`. Use `role="alert"` for stopped and connection problems, and `role="status"` for loading.
- Visible `:focus-visible` outline. Dialogs use native `<dialog>` with `showModal()` for focus trapping and Esc.
- Respect `prefers-reduced-motion` (handled globally, so don't add JS animations that bypass it).
- Never convey anything only through color or motion.

## States every view needs

Waiting (listening animation plus "Play the hearing in your shared tab"), listening, offline, stopped (alert with Reconnect, cards kept but dimmed), pending card (skeleton plus "Explaining “term”…"), long session (3 recent cards, the rest collapsed under "Earlier terms (n)"), backend unreachable (banner), and request loading.

## Copy

- Chrome: short, plain English, sentence case ("Ask a question", "Hide transcript").
- Content from the backend: shown as-is. Never rewrite it in the UI.
- Keep "Linaw explains terms. It is not legal advice." visible in Settings, and never write copy that advises legal action.

## Icons

`lucide-react`, with names matching the design (clock, headphones, wifi-off, audio-lines, volume-x, settings, shield-check, cpu, volume-2, text, bookmark, circle-help, file-text, message-circle-question). Size 18–24, inheriting `currentColor`.

## Overlay layout (`src/overlay/`)

The overlay is the main way people use Linaw: a ~420px-wide panel beside the video. Design it narrow-first.

- **Title bar** (drag handle in Electron): brand plus icon buttons (stop, ghost, settings, minimize, close). Nothing else fits at 420px, so status lives in the caption strip.
- **Caption strip**: speaker, status pill and timer, then the latest transcript line (3-line clamp) with term underlines.
- **Cards**: the newest card in full, then "Earlier terms" as one-line rows that expand in place. Pending terms show as a dashed "Explaining…" row.
- **Action bar**: three equal buttons, icon above label.
- **Help**: the sheet replaces the cards and caption until it is closed.
- **Ghost mode** (`.overlay--ghost`): the shell makes the window 55% opaque and click-through. Hide the controls there, because nothing can be clicked.
- New cards arrive at the top, so scroll containers need `overflow-anchor: none`. Otherwise the browser scrolls the newest card out of view.
- Check changes at 420px wide. Use the screenshot aid in the `linaw-overlay` skill rather than guessing.

## Structure

Components in `src/components` are presentational: props in, callbacks out. Server-driven state lives in `src/state/session.ts`, and side effects (socket, audio, settings, actions) live in `src/state/useLinaw.ts`. Both layouts reuse the same components. Responsive breakpoints are 64rem (transcript moves below the cards, as in the tablet design) and 40rem (phone).
