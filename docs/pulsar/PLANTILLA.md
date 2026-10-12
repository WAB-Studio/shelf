# La plantilla de un plan

Un plan escrito así se lee en la app, sin IA y sin tope (RP-37). Cualquier otro texto se envía a OpenAI.

## Gramática

- La primera línea no vacía es exactamente `pulsar · plantilla 2`. Sin ella, el texto no es una plantilla. `pulsar · plantilla 1` se sigue leyendo como antes: una sola capa de metas, sin `dentro de:` y sin nota de meta, hasta 12 metas.
- Las líneas en blanco se ignoran. Cada meta empieza en `# <nombre>`; un archivo trae de 1 a 40. Dos metas no llevan el mismo nombre.
- `horizonte: AAAA-MM-DD` es obligatorio y va justo después del nombre. Es el primer día después de la meta.
- `dentro de: <nombre>` es opcional y va después de `horizonte:`. El nombre es exactamente el de una meta que aparece antes en el archivo. Así se arman tres niveles: una meta general, las grandes dentro de ella y las pequeñas dentro de una grande. Una cuarta capa, un nombre que no está antes o un nombre repetido es un error de esa línea.
- Nota de la meta: líneas `nota: <texto>` sin sangría, después de las cabeceras de la meta y antes de su primera sección. Mismas reglas que la nota de una tarea; el tope es el de la nota de una meta, y más es un error de su primera línea `nota:`. Una `nota:` sin sangría bajo una sección es una línea fuera de forma.
- `medida: <nombre> · <unidad>` es opcional. Sin ella, la meta no lleva montos ni tiempo. Una medida en horas (`horas`) se guarda en minutos.
- `ritmo: <monto>` es opcional y va justo después de `medida:`, solo si la medida es en horas o minutos: `12 h`, `12 h 30 min` o `90 min`, y se guarda en minutos. En otro lugar, o con otra unidad, detiene la lectura. Con `ritmo:`, las tareas entran al plan y su mes solo las ordena (RP-67). Una plantilla sin `ritmo:` se lee como antes.
- Las secciones `## Fases`, `## Meses`, `## Compromisos` y `## Tareas` van en cualquier orden y son opcionales; cada una lista líneas que empiezan en `- `.
- Fase: `- AAAA-MM-DD a AAAA-MM-DD · <objetivo>`.
- Mes: `- AAAA-MM · <monto>`. El mes va de 01 a 12; otro número dice que ese mes no existe. Un mes no se repite.
- Compromiso: `- <nombre> · <cadencia> · <toque o monto>`. Un monto cuenta en la unidad de la medida.
- Cadencia: `cada día`, `lunes y jueves` (días separados por coma o «y»), `3 veces por semana`, `cada 2 días`, `2 veces al mes`.
- Tarea: `- AAAA-MM · <nombre>` o `- AAAA-MM · <monto> · <nombre>`.
- Sub-tarea: una línea `- ` con exactamente dos espacios antes, justo bajo su tarea: `  - <nombre>` o `  - <monto> · <nombre>`.
- Nota: una línea `nota: <texto>` justo bajo su tarea, con dos espacios antes, o bajo su sub-tarea, con cuatro. La de una tarea va antes de sus sub-tareas.
- Una nota de varias líneas repite la línea: cada `nota:` es una línea de la nota, y `nota:` sola es una línea en blanco. El texto va tal cual; la nota entera se recorta en ambos extremos y, toda en blanco, no es nota. Máximo 2000 caracteres: más es un error de su primera línea `nota:`. Una `nota:` con sangría en otro lugar es una línea fuera de forma. Una plantilla sin `nota:` se lee sin ninguna.
- Monto: con una medida en horas o minutos, `12 h`, `12 hrs`, `12 hs`, `1,5 h`, `12 h 30 min` o `90 min` (también `hora`, `horas`, `minuto`, `minutos`), y se guarda en minutos; con cualquier otra unidad, un número entero. Con `ritmo:`, las tareas entran al plan y su mes solo las ordena (RP-67).
- Las líneas que no siguen la forma se dicen todas a la vez, en orden, cada una con su número, su texto y lo que debía decir (RP-72). Una cabecera rota detiene la lectura: se dice solo ella, la más alta, y ninguna otra línea.

## Ejemplo

```
pulsar · plantilla 2

# Carrera en IA
horizonte: 2028-10-01
nota: Lo que busco en dos años.
nota: Un ritmo que pueda sostener.

# IA aplicada
horizonte: 2027-10-01
dentro de: Carrera en IA

# Evals y harness
horizonte: 2027-03-01
dentro de: IA aplicada
medida: horas de estudio · minutos
ritmo: 12 h
nota: Empezar por lo que ya sé medir.

## Fases
- 2026-10-01 a 2026-12-31 · Evals y harness

## Meses
- 2026-10 · 12 h
- 2026-11 · 20 h

## Compromisos
- Tema técnico · martes y jueves · 2 h
- Inglés pasivo · cada día · toque

## Tareas
- 2026-10 · 4 h · Leer AI Engineering cap. 1–4
- 2026-10 · Tutor
  nota: Preguntar por la tarifa por hora.
  nota: Pedir una clase de prueba antes de pagar.
  - 1 h · Elegir tutor
    nota: Comparar tres perfiles.
  - 6 h · Sesiones 1–4
```

## En Excel

El libro `.xlsx` de la plantilla lleva la misma información en cinco hojas. Cada hoja lleva sus encabezados en la primera fila (en `Metas`, en la segunda, bajo la marca), y cada fila de datos es una línea de la plantilla.

- La marca `pulsar · plantilla 2` va en `Metas!A1`; los encabezados de `Metas` van en la fila 2.
- `Metas`: `nombre`, `dentro de`, `horizonte`, `medida`, `unidad`, `ritmo`, `nota`. `dentro de` es el nombre exacto de una meta de una fila anterior; los nombres no se repiten.
- `Fases`: `meta`, `desde`, `hasta`, `objetivo`.
- `Meses`: `meta`, `mes`, `monto`.
- `Compromisos`: `meta`, `nombre`, `cadencia`, `toque o monto`.
- `Tareas`: `meta`, `mes`, `tarea`, `sub-tarea`, `monto`, `nota`. Una fila con `sub-tarea` es una sub-tarea de la última tarea sin ella del mismo mes y meta.
- `meta` nombra una fila de `Metas`. Las cadencias, los montos y las fechas se escriben como en el texto.
- Una nota de varias líneas va en una sola celda, con saltos de línea.
- Un número solo en el monto de una meta en horas cuenta horas.
- Las filas en blanco se ignoran. Los errores dicen la hoja y la fila, todos a la vez (RP-72).
