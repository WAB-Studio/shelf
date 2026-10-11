# La plantilla de un plan

Un plan escrito así se lee en la app, sin IA y sin tope (RP-37). Cualquier otro texto se envía a OpenAI.

## Gramática

- La primera línea no vacía es exactamente `pulsar · plantilla 1`. Sin ella, el texto no es una plantilla.
- Las líneas en blanco se ignoran. Cada meta empieza en `# <nombre>`; un archivo trae de 1 a 12.
- `horizonte: AAAA-MM-DD` es obligatorio y va justo después del nombre. Es el primer día después de la meta.
- `medida: <nombre> · <unidad>` es opcional. Sin ella, la meta no lleva montos ni tiempo. Una medida en horas (`horas`) se guarda en minutos.
- `ritmo: <monto>` es opcional y va justo después de `medida:`, solo si la medida es en horas o minutos: `12 h`, `12 h 30 min` o `90 min`, y se guarda en minutos. En otro lugar, o con otra unidad, detiene la lectura. Con `ritmo:`, las tareas entran al plan y su mes solo las ordena (RP-67). Una plantilla sin `ritmo:` se lee como antes.
- Las secciones `## Fases`, `## Meses`, `## Compromisos` y `## Tareas` van en cualquier orden y son opcionales; cada una lista líneas que empiezan en `- `.
- Fase: `- AAAA-MM-DD a AAAA-MM-DD · <objetivo>`.
- Mes: `- AAAA-MM · <monto>`. Un mes no se repite.
- Compromiso: `- <nombre> · <cadencia> · <toque o monto>`. Un monto cuenta en la unidad de la medida.
- Cadencia: `cada día`, `lunes y jueves` (días separados por coma o «y»), `3 veces por semana`, `cada 2 días`, `2 veces al mes`.
- Tarea: `- AAAA-MM · <nombre>` o `- AAAA-MM · <monto> · <nombre>`.
- Sub-tarea: una línea `- ` con exactamente dos espacios antes, justo bajo su tarea: `  - <nombre>` o `  - <monto> · <nombre>`.
- Nota: una línea `nota: <texto>` justo bajo su tarea, con dos espacios antes, o bajo su sub-tarea, con cuatro. La de una tarea va antes de sus sub-tareas.
- Una nota de varias líneas repite la línea: cada `nota:` es una línea de la nota, y `nota:` sola es una línea en blanco. El texto va tal cual; la nota entera se recorta en ambos extremos y, toda en blanco, no es nota. Máximo 2000 caracteres: más es un error de su primera línea `nota:`. Una `nota:` en otro lugar es una línea fuera de forma. El encabezado no cambia: una plantilla sin `nota:` se lee como antes.
- Monto: con una medida en horas o minutos, `12 h`, `1,5 h`, `12 h 30 min` o `90 min`, y se guarda en minutos; con cualquier otra unidad, un número entero. Con `ritmo:`, las tareas entran al plan y su mes solo las ordena (RP-67).
- Las líneas que no siguen la forma se dicen todas a la vez, en orden, cada una con su número, su texto y lo que debía decir (RP-72). Una cabecera rota detiene la lectura: se dice solo ella, la más alta, y ninguna otra línea.

## Ejemplo

```
pulsar · plantilla 1

# IA aplicada
horizonte: 2027-10-01
medida: horas de estudio · minutos
ritmo: 12 h

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
