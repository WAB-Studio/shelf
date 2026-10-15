import type { ImportExpect } from "./grade";

export type ImportCase = { id: string; text: string; expect: ImportExpect };

export const importCases: ImportCase[] = [
  {
    id: "import/template-like",
    text: `pulsar · plantilla 2

# Inglés B1
horizonte: 2027-03-01
medida: horas de estudio · horas
ritmo: 5 h

## Meses
- 2026-10 · 20 h
- 2026-11 · 22 h

## Compromisos
- Vocabulario · cada día · toque

## Tareas
- 2026-10 · 6 h · Unidad 1 y 2
- 2026-11 · 8 h · Unidad 3`,
    expect: {
      goals: [
        {
          name: /ingl/i,
          unit: /hora|minut/i,
          horizon: "2027-03-01",
          months: [["2026-10", 20, "h"], ["2026-11", 22, "h"]],
          commitments: [{ name: /vocabulario/i, kind: "daily" }],
          estimates: [[/unidad 1/i, 6, "h"], [/unidad 3/i, 8, "h"]],
        },
      ],
      maxGoals: 1,
      uncoveredMax: 0.1,
    },
  },
  {
    id: "import/monthly-hours",
    text: `Quiero estudiar inglés este semestre.
Octubre: 20 horas
Noviembre: 25 horas
Diciembre: 30 horas`,
    expect: {
      goals: [{ name: /ingl/i, unit: /hora|minut/i, months: [["2026-10", 20, "h"], ["2026-11", 25, "h"], ["2026-12", 30, "h"]] }],
      uncoveredMax: 0.1,
    },
  },
  {
    id: "import/roadmap-pasted",
    text: `Roadmap 2026-2027: Applied AI Engineer

Fase 1 · Fundamentos (oct–dic 2026)
- Octubre: 40 h. Leer AI Engineering caps. 1-4, montar un repositorio de evals.
- Noviembre: 40 h. Construir un agente con tool calls y medirlo.
- Diciembre: 30 h. Publicar el proyecto y escribir un post.

Fase 2 · Portafolio (ene–mar 2027)
- Enero: 35 h. Segundo proyecto: RAG sobre documentos propios.
- Febrero: 35 h. Mejorar el RAG con reranking.
- Marzo: 20 h. Preparar entrevistas.

Compromisos: estudiar 2 veces por semana; revisar ofertas cada 2 días.`,
    expect: {
      goals: [
        {
          name: /ia|ai|engineer|roadmap/i,
          months: [["2026-10", 40, "h"], ["2026-11", 40, "h"], ["2026-12", 30, "h"], ["2027-01", 35, "h"], ["2027-02", 35, "h"], ["2027-03", 20, "h"]],
        },
      ],
      mustCover: ["Octubre: 40 h", "Marzo: 20 h", "Compromisos:"],
      uncoveredMax: 0.2,
    },
  },
  {
    id: "import/pdf-like",
    text: `Plan de lectura 2026
Página 1 de 3

Meta: leer 24 li-
bros antes de fin de año.

Octubre: 2 libros
Noviembre: 2 libros
Diciembre: 2 libros

Página 2 de 3
Plan de lectura 2026

Lista prioritaria
- Sapiens
- Meditaciones
- El principito

Página 3 de 3`,
    expect: {
      goals: [{ name: /lectur|libro|leer/i, unit: /libro/i, months: [["2026-10", 2], ["2026-11", 2], ["2026-12", 2]] }],
      mustCover: ["Sapiens", "Meditaciones"],
      allowedNumbers: [24, 2026],
    },
  },
  {
    id: "import/ambiguous-dates",
    text: `Aprender guitarra.
Terminar el curso básico para el 03/04/2027.
Después, seguir con el avanzado "cuando se pueda".
Tarea: comprar cuerdas nuevas, algún día de la primavera.`,
    expect: {
      goals: [{ name: /guitarra/i, tasks: [/cuerdas/i] }],
      // No end the plan does not state: either the dd/mm reading or none, never another day.
      maxGoals: 2,
    },
  },
  {
    id: "import/horizon-day-after",
    text: `Proyecto de tesis: de octubre de 2026 a marzo de 2027.
- Octubre: marco teórico
- Noviembre: encuesta
- Enero: análisis
- Marzo: entrega`,
    expect: {
      goals: [{ name: /tesis/i, horizon: "2027-04-01" }],
      noEstimates: true,
      uncoveredMax: 0.1,
    },
  },
  {
    id: "import/units-pages",
    text: `Lectura: 40 páginas al mes.
Octubre: 40 páginas
Noviembre: 40 páginas
Tarea de octubre: terminar Sapiens (25 páginas).`,
    expect: {
      goals: [{ name: /lectur/i, unit: /p[aá]gina/i, months: [["2026-10", 40], ["2026-11", 40]], rate: { amount: 40, per: "month" } }],
      allowedNumbers: [],
    },
  },
  {
    id: "import/units-mixed-time",
    text: `Rutina de estudio
- 45 minutos de lectura técnica cada día
- 3 horas de inglés cada semana
- Sábado: repaso de 90 minutos`,
    expect: {
      goals: [{ name: /estudio|rutina/i, unit: /hora|min/i, rules: [3] }],
      allowedNumbers: [45, 90, 3, 180, 270],
    },
  },
  {
    id: "import/hierarchy-3-levels",
    text: `Carrera profesional
  Idiomas
    Inglés B2 (hasta 2027-06-01)
    Alemán A1 (hasta 2027-12-01)
  Finanzas
    Fondo de emergencia`,
    expect: {
      goals: [
        { name: /carrera/i, parent: null },
        { name: /idiomas/i, parent: /carrera/i },
        { name: /ingl/i, parent: /idiomas/i, horizon: "2027-06-01" },
        { name: /alem/i, parent: /idiomas/i, horizon: "2027-12-01" },
        { name: /fondo/i, parent: /finanzas/i },
      ],
      noEstimates: true,
    },
  },
  {
    id: "import/rule-weekly",
    text: `Inglés: la regla es 3 horas cada semana.
Semana 1 (5-11 oct): 1 h de gramática, 2 h de escucha.
Semana 2 (12-18 oct): 3 h de conversación.`,
    expect: {
      goals: [{ name: /ingl/i, unit: /hora|min/i, rules: [3], tasks: [/gram/i, /escucha/i, /conversaci/i] }],
      uncoveredMax: 0.1,
    },
  },
  {
    id: "import/weeks-with-subtasks",
    text: `Proyecto agente
Semana 1
  - Leer la documentación (3 h)
  - Montar el repositorio (2 h)
Semana 2
  - Primer tool call (4 h)
  - Escribir pruebas (2 h)`,
    expect: {
      goals: [{ name: /agente|proyecto/i, tasks: [/documentaci/i, /repositorio/i, /tool call/i, /pruebas/i], estimates: [[/documentaci/i, 3, "h"], [/pruebas/i, 2, "h"]] }],
      mustCover: ["Leer la documentación", "Escribir pruebas"],
      uncoveredMax: 0.1,
    },
  },
  {
    id: "import/commitments-cadence",
    text: `Hábitos de salud
- Caminar 4 veces por semana
- Meditar todos los días
- Pesarme cada 3 días
- Ir al gimnasio lunes y jueves`,
    expect: {
      goals: [
        {
          name: /salud|h[aá]bitos/i,
          commitments: [
            { name: /caminar/i, kind: "times_per_week", n: 4 },
            { name: /meditar/i, kind: "daily" },
            { name: /pesar/i, kind: "every_n_days", n: 3 },
            { name: /gimnasio/i, kind: "weekdays" },
          ],
        },
      ],
      noEstimates: true,
      uncoveredMax: 0.1,
    },
  },
  {
    id: "import/context-heavy",
    text: `Diagnóstico: llevo dos años sin estudiar de forma constante y trabajo 50 horas a la semana.
Costos: el curso cuesta 1.200 dólares; el libro 45.
Fuentes: Anthropic Engineering, Latent Space.

Plan:
Octubre: 10 h de práctica de SQL
Noviembre: 12 h de práctica de SQL`,
    expect: {
      goals: [{ name: /sql/i, months: [["2026-10", 10, "h"], ["2026-11", 12, "h"]] }],
      maxGoals: 2,
      mustCover: ["Octubre: 10 h"],
    },
  },
  {
    id: "import/no-figures",
    text: `Mudanza
- Buscar apartamento
- Firmar contrato
- Empacar la cocina
- Cambiar la dirección en el banco`,
    expect: {
      goals: [{ name: /mudanza/i, tasks: [/apartamento/i, /contrato/i, /cocina/i, /banco/i] }],
      noEstimates: true,
      uncoveredMax: 0,
    },
  },
  {
    id: "import/english-plan",
    text: `Data engineering upskilling
October: 12 hours — learn dbt
November: 12 hours — build a warehouse project
Tasks:
- Read "Fundamentals of Data Engineering"
- Ship the dbt project to GitHub`,
    expect: {
      goals: [{ name: /data engineering|upskilling/i, months: [["2026-10", 12, "h"], ["2026-11", 12, "h"]], tasks: [/fundamentals/i, /dbt/i] }],
    },
  },
  {
    id: "import/not-a-plan",
    text: `Receta de arepas: mezclar 2 tazas de harina con 2 tazas de agua y sal. Amasar, formar discos y asar 5 minutos por lado.`,
    expect: { status: "empty" },
  },
  {
    id: "import/csv-table",
    text: `Mes,Horas,Tema
2026-10,15,Álgebra lineal
2026-11,15,Probabilidad
2026-12,10,Repaso`,
    expect: {
      goals: [{ name: /.+/, unit: /hora|min/i, months: [["2026-10", 15, "h"], ["2026-11", 15, "h"], ["2026-12", 10, "h"]] }],
      mustCover: ["Álgebra lineal", "Probabilidad", "Repaso"],
    },
  },
  {
    id: "import/words-for-numbers",
    text: `Guitarra: tres horas por semana, cinco meses.
Octubre: practicar escalas.
Noviembre: aprender dos canciones.`,
    expect: {
      goals: [{ name: /guitarra/i, tasks: [/escalas/i, /canciones/i] }],
      allowedNumbers: [3, 5, 2, 180],
    },
  },
  {
    id: "import/two-goals",
    text: `Meta 1: Correr una media maratón. Plazo 2027-05-01. 3 salidas por semana.
Meta 2: Ahorrar para el viaje. Octubre: 500, noviembre: 500, diciembre: 800 (dólares).`,
    expect: {
      goals: [
        { name: /marat/i, horizon: "2027-05-01", parent: null },
        { name: /ahorr|viaje/i, parent: null, months: [["2026-10", 500], ["2026-11", 500], ["2026-12", 800]] },
      ],
      mustCover: ["Meta 1", "Meta 2"],
    },
  },
  {
    id: "import/notes-kept",
    text: `Escribir un libro
Octubre: 20 h. Definir el índice.
Detalle del índice: 1. Origen; 2. Método; 3. Casos; 4. Cierre.
Nota: no quiero publicar antes de tener cuatro capítulos terminados.`,
    expect: {
      goals: [{ name: /libro/i, months: [["2026-10", 20, "h"]] }],
      mustCover: ["Detalle del índice", "Nota: no quiero publicar"],
      uncoveredMax: 0,
    },
  },
];
