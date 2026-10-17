# Shelf — diseño

`apps/portal`: una sola página estática, `index.html`, que lleva a las tres apps. Sin build, sin dependencias.

## Decisiones

- **Pantalla de inicio con tarjetas.** Aprobada por el usuario el 2026-10-01: la mezcla 1 de los estilos B (claro, tipo
  Apple) y D (pantalla de inicio). Reemplaza al bento oscuro que se aprobó y publicó antes ese mismo día. Tablero:
  «Shelf», https://claude.ai/artifact/RqkVpe5eP47Qu4S9YbC3GZ
  - Antes se rechazaron una lista simple, un cielo con brillos, una placa grabada, una escena three.js y el bento.
  - Los seis estilos comparados: https://claude.ai/artifact/KcCwGomy7k8BJBAjCjgdc3
  - Las tres mezclas de B con D: https://claude.ai/artifact/WypMF9ctwerNpwJFpt7mRE
- El fondo es de colores suaves y lleva la hora grande del navegador de quien abre la página, sin nombrar ciudad.
- Hay tres tarjetas blancas, una por app. Cada una lleva un ícono en el color de su app, el nombre, una línea que dice
  para qué sirve y «Abrir ›».
- Un solo aspecto para claro y oscuro: el fondo ya define la página.
- Al pasar el mouse, la tarjeta sube 4 px y su sombra crece.

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
