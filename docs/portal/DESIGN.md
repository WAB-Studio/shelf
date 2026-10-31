# Shelf — diseño

`apps/portal`: una sola página estática, `index.html`, que lleva a las cuatro apps. Sin build, sin dependencias.

## Decisiones

- **Pantalla de inicio con tarjetas.** Aprobada por el usuario el 2026-10-01: la mezcla 1 de los estilos B (claro, tipo
  Apple) y D (pantalla de inicio). Reemplaza al bento oscuro que se aprobó y publicó antes ese mismo día. Tablero:
  «Shelf», https://claude.ai/artifact/RqkVpe5eP47Qu4S9YbC3GZ
  - Antes se rechazaron una lista simple, un cielo con brillos, una placa grabada, una escena three.js y el bento.
  - Los seis estilos comparados: https://claude.ai/artifact/KcCwGomy7k8BJBAjCjgdc3
  - Las tres mezclas de B con D: https://claude.ai/artifact/WypMF9ctwerNpwJFpt7mRE
- ~~El fondo de colores suaves con la hora grande, las tarjetas de cuatro en fila y el hover que sube~~: reemplazado por la decisión del 2026-10-30.
- Un solo aspecto para claro y oscuro: la página es clara.

## Tableros que no existen

- Un estado de error: la página no carga datos, así que no tiene.
- Una cara oscura: la página tiene un solo aspecto.

## Despliegue

- Proyecto de Vercel `universo-apps`, https://universo-apps.vercel.app
- `vercel.json` apaga los despliegues por git: la página no gasta la cuota de `main`.
- Se despliega a mano desde `apps/portal`: `npx vercel deploy --prod --yes`. Solo cuando cambia una dirección o la página.

## Decision of 2026-10-14: the cards say HomeFund, WordBook and GoalLog

- «Universo» keeps its name. Its three cards read HomeFund, WordBook and GoalLog. Deploy it with the merge to `main` that ships the apps' new titles, not before.

## Decision of 2026-10-17: the set is called «Shelf», by the user

- The portal and the set of apps are called «Shelf»: the shelf where the three books stand. It supersedes «Universo keeps
  its name» above. The repo is `WAB-Studio/shelf`; the portal's page says «Shelf» now, and its address moves from
  `universo-apps.vercel.app` to a Shelf one with the deploy, the old one redirecting.

## Decision of 2026-10-30: Shelf is calm paper, and each card wears its app's identity

Replaces the wallpaper, the big clock and the home-screen row of 2026-10-01. The page is warm paper (`#f5f3ee`) and ink
(`#23211d`) with one system font stack and nothing downloaded; it carries no colour of its own, so the four apps do.

- **No ornament.** No clock, gradient, glow or lift on hover; a card's border takes its app's colour on hover and focus.
- **One card per app**, the whole card a link to `https://homefundapp.vercel.app`, `https://wordbookapp.vercel.app`,
  `https://goallogapp.vercel.app`, `https://timelog-delta.vercel.app`. It holds the mark in the app's colours, the name, one
  line in the user's voice, the button «Abrir ›» (48 px high, the app's fill and ink) and real screenshots on a tint of the app.
- **Identities**, from each app's `DESIGN.md`: HomeFund «Violeta y lima» (violet `#5b2ee5`, lime `#c8f560`; its piggy bank from
  `apps/homefund/public/icons/icon.svg`); WordBook «Verde botella y caléndula» (`#0c5a43`, marigold `#f6b83a`; its open book from
  `app/icon.svg`); GoalLog «Naranja y marino» (`#c2410c`, navy `#0b1f3a`; the app has no icon, so the mark is its own done check, a white
  tick on an orange disc); TimeLog «Grafito y señal» (`#232c37`, cyan `#22d3ee`; its three bars from `app/icon.svg`).
- **Three compositions, not one stretched.** Phone (under 640 px): the card stacks, the phone frame sits at the bottom. Tablet
  (640 to 1099 px): one row per app, the text left and a browser frame right. Desktop (1100 px and up): two by two, the browser
  frame with the phone frame overlapping its corner; above 1700 px the grid widens to 1400 px.
- Text is 16 px or more, the buttons 48 px; every button's ink on its fill is 4.5:1 or better. Images are lazy, sized and have alt text.

### Screenshots

`apps/portal/shots/*.webp`, cropped from critics' shots (all taken at 1x, with the Next dev badge cropped out; phone 390 x 720,
desktop 1440 x 820, WebP quality 80, each under 50 KB). Re-shoot them after the restyles merge, with the same data, and replace the file.

| file | source |
|---|---|
| `homefund-phone.webp` | `apps/homefund/private/critica/ronda2/inicio-m-light.png` (lane 1) |
| `homefund-desktop.webp` | `apps/homefund/private/critica/ronda2/movements-d-light.png` (lane 1) |
| `wordbook-phone.webp` | `apps/wordbook/private/critica/ronda2/02-home-content-390-light.png` (lane 2) |
| `wordbook-desktop.webp` | `apps/wordbook/private/critica/ronda2/02-home-content-1440-light.png` (lane 2) |
| `goallog-phone.webp` | `apps/goallog/private/estilo/ronda2/hoy-390.png` (lane 3) |
| `goallog-desktop.webp` | `apps/goallog/private/estilo/ronda2/hoy-1440.png` (lane 3) |
| `timelog-phone.webp` | `apps/timelog/private/estilo/ronda2/hoy-m-dark.png` (lane 4) |
| `timelog-desktop.webp` | `apps/timelog/private/estilo/ronda2/hoy-d-light.png` (lane 4) |

The data is the seeded Casa Parada Ruiz, the English-study plan and a day at the computer: no «Demo», no harness emails.
