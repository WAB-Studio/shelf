# Decisiones del 2026-11-08

El usuario delegó todas las dudas abiertas: «quiero que cierres cada una de las dudas como tú creas». Cierra las preguntas
de los handoffs del 2026-11-01 y 2026-11-02 y las de `docs/auditoria-2026-11-02/`. Ninguna vuelve a preguntarse.
«Construir» = entra en la tanda del 2026-11-08. «Sin trabajo» = la decisión no cambia código.

## Reglas del repo

- El merge `integracion` → `main` y las migraciones de producción se hacen solo con la autorización del usuario en el chat
  (dicho por el usuario el 2026-11-02). AGENTS.md lo dice.
- Las ramas remotas ya mergeadas se borran.

## HomeFund

- Las categorías repetidas del fondo y de la persona: el ámbito se marca otra vez (encabezados en los selectores, «· fondo»
  en Reportes). Construir.
- Lo personal del otro miembro: se ve todo, siempre con el nombre del dueño y sin acciones sobre lo ajeno; lo planificado
  personal del otro sale de Inicio («Por pagar», «Cerca del límite», «Meta»). Construir.
- «Estar a mano»: Aportes sigue como lista y suma el gasto del fondo y el saldo de la caja. Sin reparto 50/50. Construir.
- Bandeja: Planeación vuelve a la barra del teléfono; la Bandeja pasa a Ajustes. Construir. (Revertida el 2026-11-11: la Bandeja vuelve a la barra, en lugar de Planeación, porque se usa a diario; Planeación queda en Inicio y en Ajustes.)
- «De quién»: sin valor inicial y obligatorio en todo ingreso al fondo hecho en el formulario. Retira RF-166 → RF-167. Un
  ingreso que llega sin persona (entrada rápida, Bandeja, recurrentes, importación) sale en Aportes como «Sin asignar».
  Construir.
- «Nueva compra a cuotas»: se quita hasta construir RF-136 en la tanda de deudas. Construir (quitar).
- RF-81 y RF-82: el código del plan de cuotas se retira con el diálogo; no se abre un RF que lo describa.
- La cuenta de efectivo del fondo no se renombra: nada de migración de datos.
- `app/theme.css` sobre clases de Radix cuenta como parchar una primitiva desde fuera: se muda a `components/ui`. Construir.
- Políticas probadas en `check-queries.ts`: basta; no se duplican en `check-rls.ts`. Sin trabajo.
- `docs/SPEC.md` §2 se pone al día con las columnas y tablas que faltan. `date-fns` sale de §4: no se usa. Construir (docs).

## GoalLog

- El ritmo y las tareas: se queda el motor y cambia el texto («Tus tareas caben hasta el 28 nov», nunca «terminas»).
  Construir.
- «Hasta hoy» en el informe y el papel: el mes en curso se prorratea por días. Construir.
- Pegar el ejemplo con una meta del mismo nombre: la meta que coincide llega desmarcada (retira RP-130 → código nuevo), y el
  ejemplo de la plantilla (`messages/es/import.json` `template.example`) se fecha relativo al mes en curso. Construir.
- Sueltas en el teléfono: un «+» fijo que abre la hoja. Construir.
- «llevas 17 %» en la meta: se quita; dice lo que falta en cifras («faltan 19 h 50 min»). Construir.
- RNP-06: una sola zona, `America/Bogota`, aceptada; se corrige el texto. Construir (docs).
- RP-139: la IA conectada y el chat no ofrecen «Bajar la meta de este día» ni «Alargar la tarea». Sin trabajo.
- PDF: sin semanas; se queda RP-125.
- RP-25: una fase puede terminar en el horizonte, nunca después («never ends before a phase does» ya lo permite). Sin
  trabajo.
- Pendientes tipográficos de la crítica del 2026-11-01 (cifras en mono dentro de textos, título del día pasado, `Tag` y
  `WeekStrip` a 14 px): se arreglan si siguen. Construir.
- PR #773 (TimeLog a la bandeja): se arregla y entra.

## WordBook

- El sentido que se aprende: el que la persona toca en la respuesta; sin toque, el primero. RL nuevo. Construir.
- Formas flexionadas y erratas: llaman a `/api/word/unlisted` solo cuando el diccionario no resuelve un lema ni sugiere
  una palabra a distancia 1. Construir.
- Ejemplos: solo de las frases de la persona. Retira RL-42 sin sucesor. Construir (quitar la llamada).
- El repaso no viaja con la cuenta: se quita «al teléfono y al portátil» de `/cuenta`. Construir.
- Tope de 20 palabras nuevas al día: fijo, y la pantalla dice cuántas esperan. Construir.
- RL-68 se retira; su sucesor es RL-78 (las frases entran al repaso). Construir (docs).
- `app/actions/account.ts` entra en la lista de §3. Construir (docs).
- `CLIENT_KEY_SALT` se exige en producción: sin sal, el envío de correo se niega, igual que las rutas de pago. Construir.
- `reading.sync_gate` y `sync_rows_today`: no se ejecutan por PostgREST; se revoca `EXECUTE` de `anon` y `authenticated`
  si el servidor no los necesita con esos roles. Construir.
- La cuota por llamante: riesgo aceptado. Sin trabajo.

## TimeLog y Shelf

- «% del día» de Claude: solo lo que estuvo en pantalla (claude.ai y la app); Claude Code se muestra aparte como trabajo del
  agente. Construir.
- «actualiza el programa» lleva al último instalador, el mismo destino que «Llaves». Construir.
- Semana suma Proyectos e Internet. Construir.
- Claude (MCP) se conecta desde Llaves: la dirección y el bloque para copiar. Construir.
- El MCP no es interfaz (RT-12): habla en español. Sin trabajo.
- RT-16: el servidor rechaza títulos de ventana de navegadores, además de confiar en el PC. Construir.
- RT-11: «has not arrived» significa solo futuro; se corrige el texto. Construir (docs).
- RT-15 se retira → código nuevo (el CSV corta en hoy y lleva la columna `uploaded`). Construir (docs).
- La enumeración de invitados («notInvited») se queda, por paridad con GoalLog.
- Dirección de Shelf: `shelfhome.vercel.app` en el proyecto `universo-apps`, agregada el 2026-11-08;
  `universo-apps.vercel.app` sigue respondiendo.

## Lo único que queda en manos del usuario

- Probar el programa de TimeLog en Windows con `--dry-run` (nadie más tiene ese PC).
- Autorizar el deploy y las migraciones que traiga esta tanda.
