# Shared fund app — design guide

Where interface decisions that outlive a single slice are written down.

## The domain leads

- Derive every interface decision from the domain, never from a pattern borrowed for its looks.
- Put the person's experience ahead of what is convenient to build.
- Give the screen to the action the person came to perform.

## Mobile first

RNF-08 sets the requirement. This is how it shows in the interface.

- Design and build every screen for the narrow viewport first.
- Write the unprefixed value of a responsive prop for the narrow viewport.
  Add `xs`, `sm`, `md`, `lg` or `xl` only for what changes above it.
- Treat the narrow viewport as the base case, never as a fallback.
- A screen is done only once it holds at the narrow viewport: no horizontal
  overflow, no overlapping controls, no tap target under 32 px on its shorter side.
- Hold the floor at 32 px: it is Radix Themes' own default control height.
- `TapTarget` in `components/ui` owns that floor for a link's content.

## Navigation

- Carry the mobile navigation on a fixed bottom tab bar. It is the primary pattern.
- Compose the bar from `BottomNav` in `components/ui`. Wire its state in `AppTabs`.
- Give the frequent tabs their own slots. Raise the frequent action at the center.
- Disable a tab whose slice is not built. Keep it visible, keep it non-navigable.
- Reach the secondary destinations and the preferences from the "Ajustes" panel the bar opens.
- Hold language, theme and sign out inside that panel.
- Carry the desktop navigation on the sidebar from `md` up. Hide the bar and the header there.
- Follow `private/design-desktop/SPEC-A3.md` for the sidebar. Compose it from `Sidebar` in `components/ui`.
- Open the same "Ajustes" panel from the sidebar's own row.
- Name every destination once, in `components/fund/destinations.ts`. Never list one at a surface.
- Keep the active fund visible wherever a write can happen.
- Reserve the bottom gutter on every app page.
- Compose it from `Page` in `components/ui`.
- Never write a page's padding at the page.

## Debts

- Show a card or liability with a positive balance as «A favor $ …» in `--accent-11`, never as «Debes». Add that balance to
  the available credit. Decided by the user 2026-10-08 (Q-D4, module 601).
- Keep instalments under RF-136: the next payment is the minimum, with no instalments added to it. The instalment dialog
  becomes «proponer diferir». Decided by the user 2026-10-08 (Q-D5, module 604).
- Neither has a board yet. Module 451 opens orbit's canvas with `Deudas · saldo a favor` and `Deudas · cuotas`.

## Decision of 2026-10-14: the app is called «HomeFund»

- The visible name is **HomeFund**: the title, the installed name (`short_name` too) and the metadata. It was «Fondo compartido». The folder
  and the URL keep `orbit` and `our-piggy-bank`.
