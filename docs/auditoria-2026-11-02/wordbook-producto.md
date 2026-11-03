# WordBook — crítica de producto, 2026-11-02

Commit `376323f`, build de producción en :3100 contra el stack local. Capturas en
`apps/wordbook/private/critica-2026-11-02/` (citadas abajo por nombre). Rutas de pago y MyMemory
sustituidas por stubs de Playwright: la traducción de frase devolvía «TRADUCCIÓN SIMULADA de «…»», la
palabra sin entrada «simulada», el ejemplo `204`. Nunca se escribió una dirección en `/cuenta`; la
sesión se acuñó con un `auth.users` local `harness-reader-…@example.invalid`, borrado al terminar.

## Summary

Recorrí `/`, respuesta de palabra, de frase, sin entrada, sugerencias, `/registro` (vacío, 33, 420 filas,
filtro, borrar, vaciar, pendiente sin red), `/registro/<palabra>`, `/repaso` (sesión de 22 tarjetas, «Otra
vez», terminado), `/cuenta` (sin sesión, Información, con sesión, copia, dispositivos, retirar, cerrar
sesión), 404, a 360, 390 y 1280, en claro y oscuro: **0 Broken · 6 Hostile · 2 Hollow · 5 Thin · 6 Notas.**
Nada desborda a 360 y ningún objetivo táctil baja de 44 px; lo que falla es lo que la app *dice* de una
palabra, y a qué hora.

## Broken

(ninguno: todo lo que la app promete se puede hacer)

## Hostile

1. **La palabra más común responde con su sentido raro, y ese sentido sigue a la palabra en todas partes.**
   `/?q=left`, 390 oscuro: el titular de 30 px dice «**sobras**, sobrado» bajo VERBO; «izquierda» es el
   cuarto grupo, abajo del pliegue, y «dejar» queda dentro del bloque de `leave`. El registro guarda
   «left · sobras», la baldosa de inicio dice «sobras», la tarjeta de Anki empieza por «sobras». Lo mismo
   con `stern` → «popa» (quien leyó *sternly*), `creep` → «desgraciado», `swishing` → «swish ·
   sofisticado» (el diccionario no tiene el verbo). Para quien estudia desde el registro, aprende la
   palabra equivocada. Capturas `10-palabra-left-390-oscuro.png`, `20-registro-390-oscuro.png`,
   `24-historia-swish-360-oscuro.png`.
2. **La misma palabra dice tres cosas distintas en tres pantallas.** `left`: la respuesta y `/registro`
   dicen «sobras»; la tarjeta de `/repaso` muestra ADJETIVO «izquierda»; el CSV de Anki da «sobras,
   sobrado, izquierda, izquierdo, de izquierda, a la izquierda». La persona no sabe cuál es «la» traducción
   que está aprendiendo. `32-repaso-reverso-0-390-oscuro.png`.
3. **Todo lo que es una hora o un día sale en UTC, no en la hora del teléfono.** `/repaso`, 390, a las
   16:04 en Bogotá: «La próxima vuelve hoy a las **21:09**» para una tarjeta que vuelve a las 16:09
   (`33-repaso-fin-390-oscuro.png`, `35-repaso-terminado-390-oscuro.png`). Una búsqueda hecha el jueves
   29 de oct a las 20:30 aparece en `/registro` bajo «**VIERNES, 30 OCT**» mientras su página dice «29 oct,
   20:30» (`61-registro-dia-equivocado-390-oscuro.png`). En Colombia, todo lo buscado entre las 19:00 y
   medianoche cae en el día siguiente. Causa: `i18n/request.ts` no fija `timeZone`, y
   `components/review/review-session.tsx:285-286`, `components/log/history-list.tsx:510` y
   `components/search/word-story-panel.tsx:67,95` formatean sin la zona del dispositivo (sí la pasa
   `word-history.tsx:238`).
4. **Un error de tipeo se vuelve palabra de estudio.** `recieve`, 390: la app ofrece «receive» y además
   pide la palabra por internet (una llamada de pago); la respuesta se guarda como fila «recieve», entra al
   mazo de `/repaso` y al CSV de Anki como tarjeta. La persona tiene que borrarla a mano o estudiar una
   palabra que no existe. `10-palabra-recieve-390-oscuro.png`, CSV exportado: `"recieve","simulada"`.
5. **Una frase en `/registro` no se puede leer.** A 360 la fila dice «the … TRADU…»; a 390, «she …
   TRADUCCI…»; a 1280, «the wind h… TRADUCCIÓN SIMU…». Ni la frase ni su traducción caben: hay que abrir
   cada una para saber cuál es. `50-registro-360-oscuro.png`, `20-registro-390-oscuro.png`,
   `50-registro-1280-claro.png`.
6. **Volver a una frase del inicio la traduce otra vez, aunque el registro ya tiene su traducción.**
   Tocar la baldosa «the wind howled through the empty streets» en `/` dispara `POST /api/translate` de
   nuevo (una llamada de pago); sin red, el mismo toque cae al desglose palabra por palabra en vez de
   mostrar la traducción ya guardada. Visto en la traza de `s12` (`translate {"text":"the wind howled…"}`
   tras el toque).

## Hollow

1. **«Con una cuenta lo llevas al teléfono y al portátil»** (`/cuenta`, `40-cuenta-sin-sesion-390-oscuro.png`)
   solo vale para el registro: el calendario de repaso vive en IndexedDB `reading-review`
   (`lib/review/store.ts:5`) y ninguna ruta de copia lo lleva (RL-68 lo dice: «the copy does not carry them
   yet»). Con la cuenta abierta en dos dispositivos, la persona repasa las mismas 20 palabras nuevas en
   cada uno y FSRS no sabe lo que hizo en el otro.
2. **El crédito «Orden de las traducciones» describe una regla retirada.** `/cuenta` › Información dice que
   el orden «se decide con una lista de frecuencia del español» (`messages/es.json:282`); desde RL-83 lo
   decide una pasada de modelo guardada en `scripts/translation-picks.json`, que la página no nombra.
   `41-cuenta-informacion-390-oscuro.png`.

## Thin

1. **La tarjeta de Anki no sirve para estudiar.** Funciona: 32 tarjetas, 2,5 KB. El reverso es la línea
   cortada a 120 caracteres con todas las categorías mezcladas: `take` → «tomar, coger, llevar, prender,
   **violar**, aguantar…», `child` → «…escuintle, chiwchi, ñaño», `row` → 15 glosas. Sin categoría, sin
   IPA, sin la frase de la persona. Valdría la pena con: frente palabra + IPA; reverso categoría + las tres
   primeras traducciones (las mismas de RL-82) + la frase propia como ejemplo.
2. **La tarjeta de repaso no suena ni muestra la pronunciación.** El frente es la palabra y «Palabra
   nueva»; para la mitad de las palabras con IPA y para todas con voz (RL-26) la respuesta ya sabe
   pronunciarlas. Valdría la pena con el mismo botón «Escuchar» de la respuesta y el IPA en el reverso.
   `31-repaso-frente-0-390-oscuro.png`.
3. **`/repaso` en escritorio es una tarjeta de 346 px pegada a la izquierda** de un área de 1 040 px vacía.
   `50-repaso-1280-oscuro.png`, `36-repaso-reverso-1280-claro.png`. Valdría la pena con la tarjeta
   centrada y al doble, y la frase de la persona a la derecha (el panel que ya existe en la respuesta).
4. **El tope de 20 nuevas al día no se ve ni se cambia.** Con 33 entradas, la sesión termina en «Terminaste
   por hoy» y las 12 restantes esperan a mañana sin que la pantalla diga que existen. Valdría la pena con
   una línea «12 palabras nuevas esperan a mañana» y, si el usuario lo decide, un control para subir el tope.
5. **La primera vez no explica el ciclo buscar → registro → repaso.** `/` vacío (`02-inicio-vacio-390-oscuro.png`)
   muestra cuatro ejemplos y nada más; «Repaso» no está en la barra y aparece solo después de buscar.
   Valdría la pena con una línea bajo los ejemplos: «Lo que busques se guarda en Registro y vuelve para
   repasarlo».

### Notas

- `/cuenta` sin sesión no dice que se entra por invitación; se sabe después de escribir el correo («Este
  correo no tiene invitación a WordBook»). `40-cuenta-sin-sesion-390-oscuro.png`.
- «Cerrar sesión» lleva a `/registro` sin decir nada (`app/actions/account.ts:176`).
- La copia todavía habla de «enlace» donde ya se entra con código: «No se pudo enviar el enlace», «Sin
  conexión. No se pudo enviar el enlace.» (`messages/es.json:221,224`).
- «8,0 MiB en este dispositivo»: «MiB» es jerga; «8 MB» dice lo mismo a una lectora.
- «Repasaste 2 entradas. Terminaste por hoy.» cuenta solo la última sesión; esa tarde se habían repasado 22.
- `it` responde «eso, lo» en la caja y la fila del registro dice «lo»: la tabla de palabras función no
  llega al registro.

## Ideas para mejorar (por valor)

1. **Dejar que la persona marque el sentido que leyó.** Un toque sobre un grupo («este») y ese sentido es
   el que guardan el registro, la tarjeta de repaso y Anki. Resuelve Hostile 1 y 2 de una vez, sin pedir
   nada a un modelo.
2. **Fijar la zona horaria del dispositivo** en el proveedor de next-intl. Un cambio corto que corrige la
   hora del repaso y el día del registro (Hostile 3).
3. **No registrar un error de tipeo hasta que la persona lo confirme.** Si la búsqueda tiene una sugerencia
   a distancia 1, mostrar la sugerencia primero y guardar la fila solo si se queda en la palabra escrita.
4. **Reusar la traducción guardada** al volver a una frase desde el inicio o el registro, con o sin red.
5. **Fila de frase en dos líneas** en `/registro`: la frase arriba, la traducción abajo, sin cortar.
6. **Tarjeta de Anki y de repaso con IPA, voz, categoría y la frase propia** (Thin 1 y 2).
7. **Llevar el calendario de repaso en la copia de la cuenta** (Hollow 1).
8. **Repaso de escritorio a la medida**: tarjeta grande y centrada, panel con la frase al lado.

## Questions for the user — Decisiones del usuario

**1. ¿Qué sentido aprende la persona: el que la app pone primero o el que ella marca?**
- a) El primero del primer grupo, como hoy. No cuesta nada; sigue enseñando «left = sobras».
- b) El que la persona toca en la respuesta (idea 1). Un control nuevo y un RL nuevo; sin marca, queda a).
- c) Todos los sentidos en la tarjeta. Es lo que ya hace Anki: tarjetas que nadie puede memorizar.
- Mi opinión: b).

**2. ¿Una forma flexionada y un error de tipeo deben gastar una llamada de pago?** Hoy `lingered`, `went`,
`children`, `swishing`, `sternly` y `recieve` llamaron a `/api/word/unlisted` aunque el diccionario ya
resolvía el lema o sugería la palabra correcta (RL-44, RL-58).
- a) Sí, como hoy. Cada página de lectura cuesta más llamadas contra el tope de 500 diarias.
- b) Solo cuando el diccionario no resuelve un lema ni tiene una sugerencia a distancia 1. Menos gasto; la
  forma pierde su traducción propia («fue» para *went*).
- c) Solo cuando la persona lo pide con un toque. Sin gasto involuntario; un paso más para una palabra rara.
- Mi opinión: b).

**3. ¿Los ejemplos se siguen generando con el modelo?** `DESIGN.md` (2026-10-31) dice «Examples: the
reader's own logged phrases… No paid generation», pero cada palabra exacta todavía llama a
`/api/word/text` (RL-42 sigue marcado).
- a) Retirar RL-42: ejemplo solo de las frases de la persona. Gratis y sin red; casi ninguna palabra tendrá
  ejemplo al principio.
- b) Mantenerlo y corregir el DESIGN. Una llamada por palabra nueva contra el tope diario.
- Mi opinión: a), porque la frase propia ya aparece como pista en el repaso.

**4. ¿El repaso viaja con la cuenta?**
- a) No, como hoy, y quitar «al teléfono y al portátil» de `/cuenta`. Sin trabajo de sincronización.
- b) Sí: un RL nuevo, tabla y política nuevas, y fusión de dos calendarios FSRS. Es el trabajo más grande de
  esta lista.
- Mi opinión: b), si la persona usa el portátil para repasar; si no, a).

**5. ¿El tope de 20 palabras nuevas al día es fijo?**
- a) Fijo, y la pantalla dice cuántas esperan (Thin 4). Solo cambia el texto.
- b) Ajustable en `/cuenta` (10, 20, 50). Un control y un valor guardado en el dispositivo.
- Mi opinión: a) por ahora.

### Lo que no pude alcanzar

- El traductor del dispositivo (RL-08, RL-10, RL-11): Chromium headless no expone la API `Translator`.
- Las respuestas reales del modelo y de MyMemory, ni las notas de frase: estaban sustituidas por stubs, así
  que no juzgo su calidad, solo el texto y la forma de la pantalla.
- El envío de correo y el código de seis dígitos en `/cuenta`: prohibido; la sesión se acuñó sin correo.
- «Pedir al navegador que guarde el registro»: headless no muestra el permiso de almacenamiento persistente.
- La app instalada en la pantalla de inicio y un iPhone real.
