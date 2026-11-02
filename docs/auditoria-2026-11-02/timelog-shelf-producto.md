# TimeLog y Shelf — crítica de producto (2026-11-02)

Commit juzgado: `376323f`. Capturas: `apps/timelog/private/critica-2026-11-02/` (nombre del archivo entre paréntesis).

## Summary
Manejé TimeLog local en :3300 (build de producción, base local 127.0.0.1:44322, persona `critica-timelog@example.invalid` creada con la API admin local, sin correo) en /entrar, Hoy (primera vez, programa viejo sin sitios, sin subida hoy, lleno), un día con hueco, un día con dos equipos, un día con demasiado (62 apps más, 42 sitios más), Semana vacía/actual/anterior, Llaves (vacía, nombre vacío, creada, revocar, llave revocada contra /api/ingest → 401), Exportar (CSV, rango invertido), 404 y English, a 360/390/1280 en claro y oscuro; y Shelf por file:// y en vivo a 360/390/1280, con sus cinco direcciones. Conteo: **Broken 0 · Hostile 4 · Hollow 1 · Thin 7 · Note 12**.

Lo que no pude alcanzar: los dos enlaces a GitHub (`WAB-Studio/activitywatch/releases/latest` y `timelog-sync/.../TIMELOG.md#on-windows-with-the-installer`) responden 403 desde el proxy de esta sesión; no sé si una persona sin sesión de GitHub los ve. El instalador, la bandeja «TimeLog: pegar llave…» y el programa `timelog-sync` no corren aquí (Linux, sin Windows): toda la subida la hice por `/api/ingest` con la llave creada en la pantalla.

## Broken

## Hostile
- **Hoy y cualquier día, bloque, «N con Claude · X % del día»** (14-dia-domingo-1nov-390-dark.png, 1280 y 390): el domingo 1 nov, con un solo equipo, dice «2 h 53 min con Claude · 91 % del día» sobre 3 h 9 min en la computadora. Claude Code cuenta el tiempo en que el agente trabaja (RT-14), no el tiempo de la persona frente a la pantalla, y se suma a claude.ai y a la app, que sí son tiempo frente a la pantalla. La persona lee «pasé el 91 % del día en Claude», y es falso. `lib/totals.ts:16` corta en 100: con agentes corriendo mientras la persona no está, el bloque llega a «100 % del día» con más horas de Claude que de computadora (lo vi: «5 h 34 min con Claude · 100 % del día» sobre 5 h 24 min, cuando mi siembra duplicó sesiones entre dos equipos).
- **Semana, mapa de calor, 390 y 360** (17-semana-anterior-390-dark.png): cada celda muestra solo la unidad más grande, sin decimales: «1h» para 1 h 57 min, «2h» para 2 h 42 min, «3h» para 3 h 43 min. En el celular se pierden hasta 59 min por celda; leer la semana en el teléfono te deja comparar «2h» con «2h» cuando una tiene 2 h 13 y la otra 2 h 42.
- **Hoy, tarjeta Internet sin sitios, «Cómo actualizar el programa ›»** (07-hoy-uploader-viejo-1280-dark.png): la pantalla pide actualizar, pero el enlace (`components/screens/claude-internet.tsx:16`) lleva a una sección «On Windows with the installer» de un README en inglés, en otro repositorio (`timelog-sync`), mientras que «Llaves» lleva el mismo programa a `WAB-Studio/activitywatch/releases/latest`. Son dos destinos para «el programa», ninguno es «descarga esta versión» y el que pide actualizar habla de instalar. No pude abrir ninguno de los dos (403 del proxy); si el repositorio es privado, este paso está roto.
- **Llaves después de revocar, 360 claro** (25-llaves-revocada-360-light.png): revoqué la llave que acababa de crear y la pantalla sigue mostrándola entera, con «Cópiala ahora: no se vuelve a mostrar», «Copiar» y el comando listo. La llave ya da 401 (`{"error":"key"}`). Quien la copie y la pegue en la bandeja tendrá un programa que no sube nada, y la pantalla no dice nada de eso.

## Hollow
- **Llaves y Exportar prometen «que Claude lo lea» y no dicen cómo**: `messages/es/time.json:87` («Una llave deja que … Claude lo lea») y `:163` («Claude lee las mismas filas con la herramienta get_daily»). Ninguna pantalla da la dirección `/mcp`, el encabezado de la llave ni el paso para agregarlo a Claude (RT-07). El servidor MCP existe (`lib/mcp/tools.ts:53-86`), pero una persona no puede conectarlo desde la app.

## Thin
- **Semana no tiene Internet ni Proyectos** (16-semana-actual-1280-dark.png): una semana muestra apps y Claude, pero no «cuánto YouTube esta semana» ni «cuántas horas en shelf esta semana». Para eso hay que abrir siete días uno por uno. Lo que la haría valer: una tarjeta Proyectos de la semana y los sitios más largos de la semana, con el mismo `y N más`.
- **Proyectos (RT-23) y las sesiones de Claude Code no se juntan** (10-hoy-lleno-1280-dark.png): «shelf 1 h 11 min» en Proyectos y «shelf 1 h 6 min» en Sesiones de Claude Code están en dos tarjetas distintas, sin un total por proyecto. Además, un proyecto no se abre para ver sus archivos (la ventana sí, dentro de VS Code). Lo que lo haría valer: un tiempo por proyecto que sume editor y Claude Code, sin sumar dos veces lo que se solapa.
- **«La que más usaste»** (10-hoy-lleno-1280-dark.png) repite la primera fila de Apps, que está debajo. Ocupa una tarjeta ancha del bloque a 1280 para decir lo mismo dos veces. Lo que la haría valer: algo que la lista no dice, por ejemplo el proyecto más largo o el cambio frente a la semana.
- **No hay vista de equipos ni del programa**: la única pista de que un equipo tiene el programa viejo es la frase de Internet, y solo aparece si *ningún* equipo mandó sitios nunca (`claude-internet.tsx`, `hasSites`). Con el portátil desactualizado y el escritorio al día, nadie avisa. Llaves lista llaves («usada 2 de nov, 4:08 p. m.»), no equipos. Lo que lo haría valer: por equipo, la última subida y si manda sitios, ventanas y Claude.
- **Primera vez, después de pegar la llave**: Llaves no se refresca (la llave sigue «sin usar» hasta recargar) y el texto dice «sube sola cada hora». La persona no sabe si quedó conectada hasta una hora después. Lo que lo haría valer: un estado «esperando tu PC…» que cambie solo al llegar la primera subida.
- **«Sin el instalador», Llaves** (06-llaves-creada-360-dark.png): el comando `py -m aw_client timelog --url … --key …` supone Windows con el lanzador `py` y la bifurcación ya instalada; ninguna línea dice cómo instalarla, y no corre en macOS ni en Linux. Además no coincide con el SPEC RT-09 (`aw-client timelog`) y sube una sola vez: no dice cómo programarlo.
- **MCP**: las herramientas solo leen apps y totales (`get_day`, `get_week`, `get_range`, `get_daily`); Claude no puede contestar «¿cuánto estuve en el proyecto shelf?» ni «¿cuánto YouTube?», que es lo que la pantalla ya sabe. Lo que lo haría valer: proyectos y sitios por día en el MCP.
- **Shelf, tarjeta TimeLog**: las capturas (`apps/portal/shots/timelog-*.webp`, 31-shelf-live-1280-abajo.png) muestran un TimeLog que ya no existe: «‹ Día anterior» en lugar de la tira de días, sin Claude, Internet ni Proyectos, y una fila «AdobeAcrobatReaderDCUpdaterServiceHelper64». La página en vivo es idéntica byte a byte a la local, así que esto es lo que ve la gente hoy. Lo que la haría valer: volver a sacar las capturas de las pantallas actuales (`docs/portal/DESIGN.md`, «Re-shoot them after the restyles merge»).

## Notes
- Hoy, tira de días: ««» significa «Semana anterior» (aria-label) y lleva a /dia/2026-10-26. Visto como glifo se lee como «al principio»; en Semana el mismo salto se escribe «‹ Semana anterior». (10-hoy-lleno-390-dark.png)
- Hoy a 1280: el «›» de cada fila que se abre cae fuera de la columna de texto, a la izquierda y a la altura de la barra, no del nombre. (10-hoy-lleno-1280-dark.png)
- «y 2 apps más · 21 min» y «y 2 sitios más» miden 318×20 px: menos de 44 de alto. (medido a 390)
- Hoy a 1280: Internet queda sola en la segunda fila y deja dos tercios del ancho vacíos debajo de Proyectos y Claude. (10-hoy-lleno-1280-dark.png)
- Semana, mapa de calor: dos filas se llaman «Claude» («Claude en total / Claude» y «Claude / App de Claude»); a 390 se cortan en «Claude e…», «App de Cl…» y «Comunica…». (17-semana-anterior-390-dark.png)
- Semana a 1280: las celdas dicen «3 h 12» sin «min», contra la regla de DESIGN de que una cifra de la semana lleva su unidad. (17-semana-anterior-1280-dark.png)
- Hoy sin subida hoy: «Todavía no ha subido nada hoy» encima de «Última subida: 2 de nov, 4:04 p. m.», que es hoy. Pasa cuando el programa sube ayer durante el día de hoy. (23-hoy-sin-subida-hoy-390-dark.png)
- Hoy, programa sin Claude: el bloque dice «Sin Claude hoy todavía», que sugiere que llegará más tarde, y la tarjeta dice que nunca llegó y manda a editar `aw-timelog.toml (claude_dir)`, un archivo que quien usa el instalador nunca vio y cuya ubicación no se dice. (07-hoy-uploader-viejo-1280-dark.png)
- Exportar abre con los últimos 30 días (4 oct – 2 nov): 16 filas en cero antes de la primera subida (20 oct). Al abrir la pantalla, el navegador pide `/api/export` 4 veces en 8 s: precarga los atajos, que generan el CSV.
- Llaves: las llaves revocadas se quedan en la lista para siempre, sin forma de quitarlas. A 360, «Descargar el instalador para Windows» parte la píldora en dos líneas con el texto alineado a la izquierda. (06-llaves-creada-360-dark.png)
- /dia/2026-11-03 (mañana) da 404 con el cuerpo «Esa página no existe», pero la pestaña se titula «Martes 3 nov · TimeLog». (20-404-dia-futuro-390-dark.png)
- Shelf: la dirección sigue siendo `universo-apps.vercel.app`; `shelfapp.vercel.app` ya responde 200 con «Planogram App», de otra persona. Las cinco direcciones de producción responden: homefundapp 307→/es, wordbookapp 200, goallogapp 200, timelog-delta 307→/entrar, universo-apps 200; las viejas our-piggy-bank, reading-neon y pulsar-psi-six también responden.

## Ideas para mejorar (por valor)
1. Separar «Claude trabajando» de «tú en Claude»: el porcentaje del día solo con claude.ai y la app (lo que estuvo en pantalla), y Claude Code aparte como «trabajó N mientras estabas» o «en paralelo».
2. Tiempo por proyecto: editor + Claude Code (+ terminal si el título lo nombra), por día y por semana, con su tarjeta en Semana y en el MCP.
3. Una tarjeta «Tus equipos» en Llaves: cada equipo con su última subida, la versión del programa y qué fuentes manda (apps, ventanas, sitios, Claude), y un enlace «Actualizar» que lleve al instalador de la última versión, el mismo que «Descargar».
4. Conectar Claude desde Llaves: la dirección `/mcp`, el bloque listo para copiar en la configuración de Claude y una línea que diga qué puede preguntar.
5. Primera vez guiada: después de «Crear llave», un estado «esperando tu PC» que se refresque solo y cambie a «Llegó la primera subida · ver Hoy».
6. Semana completa: los sitios más largos de la semana y, en el celular, celdas con «1 h 57» en dos líneas en lugar de «1h».
7. Volver a sacar las capturas de TimeLog en Shelf con las pantallas actuales.

## Questions for the user

**1. ¿Qué cuenta el «% del día» de Claude?**
- A. Solo lo que estuvo en pantalla (claude.ai + app); Claude Code se muestra aparte como trabajo del agente. Costo: un texto nuevo en el bloque y en el CSV; el % baja y deja de pasar de 100.
- B. Dejarlo como está, pero cambiar las palabras («Claude trabajó N · equivale a X % de tu día») y quitar el tope de 100. Costo: casi nada, y la cifra sigue mezclando dos cosas.
- C. Quitar el porcentaje. Costo: se pierde la cifra de un vistazo que hoy encabeza la columna.
- Mi opinión: A.

**2. ¿Adónde lleva «actualiza el programa»?**
- A. A la última versión del instalador (`activitywatch/releases/latest`), el mismo destino que «Llaves». Costo: un cambio de enlace; los pasos en el README dejan de estar a mano.
- B. A una página propia de TimeLog, en español, con «Descargar» y tres pasos. Costo: una pantalla nueva que mantener.
- C. Dejar el README de GitHub. Costo: inglés, otro repositorio y, si es privado, una persona sin sesión no lo ve.
- Mi opinión: A ahora y B cuando haya más de un equipo.

**3. ¿Cuánto crece Semana?**
- A. Agregar Proyectos e Internet de la semana. Costo: dos tarjetas más y una pantalla más larga en el celular.
- B. Solo Proyectos. Costo: la pregunta «¿cuánto YouTube esta semana?» sigue sin respuesta.
- C. Nada, y que la semana se lea por días. Costo: siete clics para una suma.
- Mi opinión: A.

**4. Dirección de Shelf** (`shelfapp.vercel.app` ya es de otra persona)
- A. Dejar `universo-apps.vercel.app`. Costo: el nombre no dice Shelf.
- B. Otro nombre en Vercel (por ejemplo `shelf-wab`, que no comprobé). Costo: actualizar enlaces y la redirección.
- C. Un dominio propio. Costo: dinero y DNS.
- Mi opinión: B, si el nombre está libre.

**5. ¿Se conecta Claude (MCP) desde la app o se quita la promesa?**
- A. Una sección en Llaves con la dirección y el bloque para copiar. Costo: unas 40 líneas y mantener ese texto.
- B. Quitar «y que Claude lo lea» y la mención de `get_daily` de la copia. Costo: el MCP queda solo para quien ya sabe que existe.
- Mi opinión: A.
