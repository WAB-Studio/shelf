# Shelf

Tres apps personales en un solo repositorio, y la página que las reúne.

| App | Carpeta | Qué hace | Contrato |
|---|---|---|---|
| **HomeFund** | `apps/homefund` | Un fondo compartido: cuentas, movimientos, deudas, presupuestos y recurrentes de un hogar, con los saldos derivados de los movimientos. | `docs/SPEC.md`, `docs/FLOWS.md`, `docs/DESIGN.md` |
| **WordBook** | `apps/wordbook` | Un diccionario inglés–español que se instala en el teléfono, funciona sin conexión y recuerda lo que buscaste para exportarlo a Anki. | `docs/wordbook/SPEC.md`, `docs/wordbook/DESIGN.md` |
| **GoalLog** | `apps/goallog` | Metas que se ganan en semanas: el plan dice qué cuenta, los hechos del día dicen qué pasó. Se conecta a otros asistentes por MCP. | `docs/goallog/SPEC.md`, `docs/goallog/DESIGN.md` |
| **Shelf** | `apps/portal` | Una página estática, sin build, con el enlace a cada app. En línea en https://universo-apps.vercel.app. | `docs/portal/DESIGN.md` |

Cada `SPEC.md` es el contrato: lo que no está en su §1 no se construye. Cada requisito tiene un código (`RF-…`, `RNF-…`)
que nunca se renumera.

## Stack

Next.js 16 (App Router), React 19, TypeScript, Supabase (Postgres y Auth), Drizzle para el esquema, las políticas y las
migraciones, Zod, next-intl, Radix Themes y Playwright. La lista completa, y lo que no se instala, está en
`docs/SPEC.md` §4.

El código que dos apps comparten vive en `packages/` (`supabase-auth`, `harness-registry`). Son workspaces de npm, con un
solo lockfile y `node_modules` en la raíz.

## Arrancar

Requiere Node 22 y Docker (para el Supabase local de las suites).

```bash
npm install
scripts/supabase-local.sh start            # Postgres y Auth locales
scripts/supabase-local.sh migrate          # aplica las migraciones de cada app

cd apps/homefund
PORT=3000 ../../scripts/supabase-local.sh exec npm run dev
```

WordBook corre en :3100 y GoalLog en :3200, con el mismo `scripts/supabase-local.sh exec npm run dev` desde su carpeta.
Sin el envoltorio, la app lee el proyecto remoto.

## Verificar

```bash
npm run typecheck      # tsgo, segundos
npm run lint           # eslint con caché
```

Cada app trae sus propios `check:*`: `check:unit`, `check:queries`, `db:check-rls` y `check:e2e` en HomeFund;
`check:sync`, `check:grants` y `check:e2e` en WordBook; `check:policies`, `check:mcp` y `check:e2e` en GoalLog. Todos
corren dentro de `scripts/supabase-local.sh exec`. Ninguna prueba llama a un modelo de pago. La suite e2e completa
corre en CI (`.github/workflows/ci.yml`), no en local.

## Reglas que no se negocian

- El dinero se guarda en centavos enteros, y los saldos se derivan de los movimientos; nunca se guardan.
- Cada tabla nueva revoca todo a `anon`, `authenticated` y `service_role`, y su política se prueba ejecutándola.
- Todo texto de la interfaz sale de next-intl.

El resto está en `AGENTS.md` y en `docs/TRAPS.md`.

## Ramas y despliegue

Se trabaja en ramas que entran por PR a `integracion`. `main` es lo que Vercel despliega, y solo recibe `integracion`.
Las apps se despliegan como los proyectos `homefund`, `wordbook` y `goallog`. Shelf se despliega a mano desde
`apps/portal` con `npx vercel deploy --prod --yes`.

## Cómo se desarrolla

El desarrollo lo llevan agentes de Claude Code en carriles paralelos (`scripts/worktree.sh`), con jueces que revisan
cada tren de cambios. Las reglas están en `AGENTS.md`, y el detalle en `docs/agentes/`.
