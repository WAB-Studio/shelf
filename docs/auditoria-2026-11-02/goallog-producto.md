# GoalLog — crítica de producto, 2 de noviembre de 2026

Conducido sobre `next build` + `next start` en :3200 (árbol en `376323f`; `04f3bac6`, que cambia RP-147, llegó después
del build y no está juzgado), Supabase local, sesión de harness `9c5a17e6…`. Capturas en
`apps/goallog/private/critica-2026-11-02/` (abajo, `S/`). Anchos 360, 390, 1280; claro y oscuro.

Datos: primero el primer uso (vacío, en todas las pantallas). Después un plan propio importado por la plantilla
(«Inglés para entrevistas» en horas con 4 compromisos, 2 fases y 5 tareas; «Correr 10K» en km; «Leer» sin final),
con las metas llevadas al 5 de octubre y 71 hechos sembrados entre el 5 de octubre y el 1 de noviembre. Luego, a
mano: una meta «Ahorrar para el viaje» con un compromiso en pesos, un hábito «Estirar», dos sueltas, un día en parte,
una tarea con tiempo y el ejemplo de la plantilla pegado tal cual.

No repito lo de la crítica del 1 de noviembre (cifras dentro de frases en Archivo, título del día pasado, Tag/WeekStrip a 13 px).

## Summary
Conduje Hoy, Semana, Mes, Metas, meta, el plan, por mes, por semana, mes de meta, compromiso, día pasado, sueltas,
exportar, importar y revisión, meta nueva, compromiso nuevo, hábito nuevo, chat (sin enviar) y conexiones: Broken 0 ·
Hostile 8 · Hollow 5 · Thin 9.

## Broken

## Hostile
- **Exportar, «Hasta hoy», 360 y 1280:** suma el mes en curso completo como si ya hubiera pasado. El 2 de noviembre «Correr 10K» dice «83 de 112 km». Lo planeado de verdad hasta hoy es unos 56 km (52 de octubre y 4 de noviembre), así que la persona va adelantada un 48 % y la pantalla la muestra atrasada. Lo mismo pasa con Inglés («15 h de 41 h 25 min»). Causa: `apps/goallog/lib/plan/months.ts:205` (`toDate` toma `row.current` entero). `S/datos-exportar-360-light.png`
- **Importar, pegar el ejemplo de la propia pantalla, 360:** el 2 de noviembre deja 8 de 35 líneas fuera («ya pasó: la meta empieza en noviembre 2026»), porque el ejemplo está fijo en `2026-10` (`messages/es/import.json`, `template.example`). RP-149 fechó el Excel y dejó el texto atrás. Además, el «Leer» del ejemplo coincide con la meta «Leer» de la persona y viene marcado por defecto con «Cambia el ritmo a 40 páginas al mes» (tenía 300) y «Agrega el compromiso «Leer»». Probar el ejemplo estropea una meta real con un toque en «Crear 3 metas y actualizar 1». `S/imp-ejemplo-revision.png`
- **Hoy, hoja de cantidad con una unidad grande, 360:** para «500.000 pesos» ofrece las fichas `499999 · 500000 · 500001 · 500002`, de uno en uno y sin separador de miles, aunque la meta escribe «500.000». La única salida útil es «Escribir otra cantidad». Causa: `components/day/quantity-sheet.tsx:54` (`chipsAround`, ±1 para toda unidad que no sea tiempo). `S/flujo-pesos-hoja-360.png`
- **Hoy con 4 metas y 1 hábito, 360:** el campo «Escribe una tarea…» queda en y = 1540 px de una página de 2388 px, es decir, dos pantallas más abajo, y «Hechas hoy» en y = 2120. Para anotar «llamar al banco» en el minuto en que pasa hay que hacer scroll por todos los compromisos. `S/hoy-completo-4metas-360.png`
- **Hoy, volver a tocar un compromiso en parte, 360:** la hoja pregunta «¿Cuánto hiciste hoy?» como total, con la ficha del valor anterior marcada (10 min). Quien hizo una segunda sesión de 10 min tiene que sumar de cabeza y elegir 20; no hay «sumar». Debajo se apilan «Cambiar», «Anotar y bajar la meta de este día» y «Deshacer», que borra el hecho, pegado a los otros dos, todos a lo ancho. `S/hoy-retap-enparte-360.png`
- **El plan de Inglés, 360 y 1280:** «A este ritmo terminas el 28 de noviembre de 2026, 155 días antes de tu final». La meta va hasta mayo. «Terminas» describe solo cuándo se agotan los estimados de 5 tareas, que llenan los 20 h del ritmo como si los compromisos diarios (monólogo y tutor, unas 18 h al mes, que sí cuentan en la medida) no existieran. La persona lee dos contabilidades con un mismo número (ver Decisión 1). `S/datos-metas_2ed19ddb-1b0b-4df5-8b39-080c709517cb_plan-360-light.png`
- **Mes frente a El plan, 360 y 1280 oscuro:** Mes dice de las 5 tareas de Inglés «de octubre · falta N h», o sea arrastradas, y El plan las lista bajo «noviembre · en curso» sin decir que vienen de octubre. «Grabar 10 respuestas completas» (8 h) aparece «de octubre · falta 8 h» aunque octubre solo tenía sitio para 3 h 25 min de ella. Al marcar una, salta a «de noviembre · 3 h». Dos pantallas cuentan dos historias de las mismas tareas. `S/datos-mes-360-light.png`, `S/d2-mes-1280-dark.png`
- **Chat, vacío, 1280:** «Pon 4 h de inglés para noviembre» está fijo en `messages/es/chat.json:15`. Tocarlo envía el mensaje al instante (`components/chat/chat-screen.tsx:148`), así que gasta una llamada pagada de las 50 del día con una frase que en diciembre habla de un mes pasado y que no tiene sentido para quien no tiene una meta de inglés. `S/d2-chat-1280-light.png`

## Hollow
- **Hoy, la tira bajo cada compromiso (360 y 1280):** 30 barras sin fechas, sin eje y sin «hoy». Lo que significa solo está en un `aria-label` (`components/day/day-row.tsx:64`). En «Repaso de errores · 2 veces al mes» dibuja días sueltos de una cadencia mensual. Parece un dato y se lee como adorno. `S/datos-root-360-light.png`
- **Meta, bloque azul, 1280:** la barra de tiempo tiene un tramo celeste y un tramo con contorno sin leyenda. Solo están nombrados «hoy», «5 de octubre» y «2 de mayo», y nada dice que los tramos son las fases. `S/d2-metas_2ed19ddb-1b0b-4df5-8b39-080c709517cb-1280-light.png`
- **Meta, «Cambiar la medida», 360 y 1280:** se dibuja como un control y justo debajo dice «no se cambia ni se quita». En 1280 vive dentro de la tarjeta «El final», que no tiene nada que ver con la medida. Es un botón que no es botón, en el grupo equivocado. Misma captura.
- **Compromiso nuevo, «lo que anota otra app», 360:** la única fuente es «diccionario». No dice que es WordBook, y TimeLog (RP-146) no está. La opción promete «otra app» y entrega una. `S/flujo-compromiso-evidencia-360.png`
- **Meta, «Abrir en Claude»:** el resumen (1442 caracteres) pierde lo que el registro sí tiene. Lista «2 nov: Monólogo grabado» sin decir que fueron 10 de 20 min (en parte), omite las líneas de los hechos («se me trabó el past perfect», que está en `goals.facts.note` y que la pantalla del compromiso sí muestra) y abre con «2 nov» antes de «27 oct». Justo lo que un tutor de IA necesitaba, las cantidades y los errores anotados, no viaja.

## Thin
- **Meta recién creada a mitad de mes:** escribí `ritmo: 60` y `/metas` dijo «0 de 58 km» y «0 de 290 páginas» (RP-76 prorratea los días) sin decir por qué. Mejoraría con una línea «noviembre desde el 2: 58 de tus 60 km», como ya dice el mes cerrado («desde el 5: 17 h 25 min de tus 20 h»). `S/imp-real-creado.png`
- **Día pasado, 360:** el 1 de noviembre dice «Podcast · 2 de 3 esta semana» y «Repaso de errores · 0 de 2 este mes». Es esa semana y ese mes; Semana ya dice «esa semana». `S/flujo-ayer-360.png`
- **Día de hace más de 7 días:** `/dia/2026-10-20` lleva sin aviso a `/semana?semana=2026-10-20`, mientras Mes dice «Toca un día para abrirlo». Mejoraría con una línea que diga que ese día ya solo se lee en su semana. `S/datos-dia_2026-10-20-360-light.png`
- **Semana, esta semana, 360 y 1280:** de martes a domingo, días que aún no llegan, se dibujan con el mismo círculo vacío que un día pasado sin hacer. A media semana no se distingue lo que falló de lo que falta. `S/d2-semana-1280-light.png`
- **Meta, copia:** «Ritmo 20␣␣h al mes» con doble espacio; «en lugar del ritmo» bajo el monto del mes sin explicar qué reemplaza; «llevas 17 %», un porcentaje que roza la puntuación que RP-16 excluye; «0 min de 24 h» mezcla unidades. `S/d2-metas_2ed19ddb-…-1280-light.png`
- **Mes, 1280:** tres columnas estrechas. Las tareas de Inglés se parten en 3 líneas («Lista de 50 / preguntas de / system design») mientras las otras dos columnas tienen tarjetas de 2 filas, y el calendario de 2 días con algo hecho ocupa media pantalla. Mejoraría si la meta con lista ocupara el ancho. `S/d2-mes-1280-dark.png`
- **Plantilla, «horizonte»:** escribí `2027-05-03` y la app dice «hasta el 2 may 2027», porque el horizonte es «el primer día después». Quien escribe un final escribe el último día. Mejoraría si leyera el último día.
- **Meta nueva:** viene con «con final» marcado y 12 semanas. Quien escribe solo el nombre recibe un final el 24 de enero de 2027 que no pidió; SPEC RP-99 trata el final como optativo. `S/flujo-meta-nueva-360.png`
- **Compromisos, copia cruzada:** «Fondo largo · sábado» en la meta y «solo los sábados» en Exportar; «2 al mes» en Semana y «2 veces al mes» en la meta.

## Lo que no alcancé
- RP-29 (aviso desde el día 20): hoy es 2 de noviembre.
- RNP-04 (fuente caída): pide el servidor de fallo, que no levanté.
- El chat y la importación con IA: modelo pagado, no los usé y los juzgué por código y copia.
- `/entrar`: envía un correo real.
- El diálogo de impresión del PDF.
- Crear una llave en Conexiones.
- El estado «cargando», que no se ve a más de 700 ms.
- RP-147 después de `04f3bac6`, porque no está en el build.

## Ideas para mejorar (por valor)
1. **Captura arriba en Hoy:** un campo o un «+» fijo sobre la barra de pestañas en el teléfono, para que la suelta cueste un toque y no dos pantallas de scroll.
2. **«Sumar» en la hoja de cantidad:** «+10 min» sobre lo ya anotado, con el total a la vista («llevas 10 de 20»). Es la segunda sesión del día, el caso común del monólogo y de la lectura.
3. **«Hasta hoy» verdadero:** el mes en curso prorrateado por días transcurridos, igual que la semana (RP-58). Arregla una cifra que hoy engaña en el informe que se imprime.
4. **Ejemplo de la plantilla fechado al mes en curso**, como el Excel (RP-149), y con las coincidencias por nombre desmarcadas cuando el texto es el ejemplo literal.
5. **Fichas de cantidad proporcionales:** ±10 % y ±25 % redondeados, con separador de miles, para km, páginas, pesos o repeticiones.
6. **«Abrir en Claude» con cantidades, «en parte» y las líneas de cada hecho**, en orden de fecha.
7. **Una vista de notas por compromiso:** todas las líneas escritas («lo que me trabé») y no solo los últimos 8 días. Es el material del «repaso de errores» que el propio plan pide dos veces al mes.
8. **Fechas y «hoy» en la tira de 30 días**, o quitarla de Hoy y dejarla en la pantalla del compromiso, donde ya tiene título.
9. **TimeLog como fuente (RP-146)**, que convierte «otra app» en una promesa cumplida.
10. **Un cierre de semana:** el domingo, una pantalla con lo hecho frente a lo planeado y un «¿qué mueves?». Es lo siguiente obvio de un registro que ya lo sabe todo y hoy no lo junta en ninguna parte.

## Decisiones del usuario

**1. El ritmo, ¿lo llenan las tareas o lo llenan los compromisos?**
- a) El plan reparte en las tareas solo el ritmo menos lo que los compromisos ya planean ese mes (20 h − ~18 h). Coste: cambia RP-50 y RP-52; las fechas de fin se alargan mucho; es un módulo de motor más pruebas.
- b) Se queda el motor y cambia la copia: «Tus tareas caben hasta el 28 nov», nunca «terminas». Coste: una cadena; la doble contabilidad sigue, pero dicha.
- c) Las tareas suman horas al hacerse (deshacer RP-128). Coste: vuelve el doble conteo que RP-65 retiró.
- Mi opinión: b) ahora y a) cuando se pueda.

**2. «Hasta hoy» en el informe y el papel**
- a) Prorratear el mes en curso por días. Coste: una función y sus pruebas; la cifra baja a mitad de mes.
- b) Llamarlo «Hasta fin de mes». Coste: una cadena; la cifra sigue sin servir para saber si vas atrás.
- Mi opinión: a).

**3. Pegar el ejemplo cuando ya hay una meta con su nombre**
- a) Una meta que coincide por nombre llega desmarcada y hay que marcarla para actualizarla. Coste: cambia RP-130 (hoy aplica por defecto); un toque más para quien sí quiere actualizar.
- b) Solo cambiar los nombres y las fechas del ejemplo para que no choque. Coste: el riesgo sigue para cualquier plan con un nombre repetido.
- Mi opinión: a), junto con fechar el ejemplo.

**4. Dónde va la captura de sueltas en el teléfono**
- a) Arriba, bajo la tira de la semana. Coste: empuja los compromisos 60 px.
- b) Un «+» fijo que abre una hoja. Coste: un toque más, pero siempre al alcance del pulgar.
- c) Dejarla al final. Coste: dos pantallas de scroll con 4 metas.
- Mi opinión: b).

**5. «llevas 17 %» en la meta**
- a) Quitarlo y decir lo que falta en cifras («faltan 19 h 50 min»). Coste: una línea.
- b) Dejarlo. Coste: es una puntuación, contra RP-16.
- Mi opinión: a).
