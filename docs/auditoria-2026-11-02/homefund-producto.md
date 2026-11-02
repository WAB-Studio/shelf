# HomeFund: crítica de producto, 2 de noviembre de 2026

Commit `376323f`. Build de producción (`next start`, :3000) sobre el stack local. Capturas en
`apps/homefund/private/critica-2026-11-02/` (abreviado `C/`; el barrido de pantallas está en `C/sweep/`).

## Summary

Recorrí HomeFund como un hogar de dos: Wilson crea el fondo «Casa Parada Nieto» desde el primer uso (onboarding de tres
pasos, tres cuentas, Andrea agregada sin correo), Andrea acepta la invitación (RF-154) y trae diez meses de historia
(`seed:demo`, 423 movimientos, presupuestos, metas, pagos, reglas y deudas). Anoté por la interfaz gastos, ingresos al
fondo con y sin «De quién», un aporte por traspaso, una factura «Del hogar», un abono a tarjeta, un pago planificado, un
aporte a meta, un retiro de efectivo y el filtro de movimientos. Abrí las 26 rutas de `app/[locale]` como propietario y
como miembro, en 360 claro, 360 oscuro, 390, 1280 claro y 1280 oscuro (75 capturas de barrido y 45 de flujo).
Ninguna pantalla tiene desbordamiento horizontal y ninguna tardó más de 1,6 s en cargar con 423 movimientos.
Conteo: **Broken 0 · Hostile 10 · Hollow 5 · Thin 7 · Notas 12.**

Lo que más cuesta tiene una sola raíz: la app muestra todo lo de los dos sin decir de quién es, y ofrece acciones sobre
lo ajeno que después rechaza con mensajes falsos.

## Broken

(ninguno: todo lo que intenté se puede hacer por algún camino)

## Hostile

- **Deudas · «Abonar», 360 y 1280.** «Pagar desde» trae preseleccionada la primera cuenta de activo en orden
  alfabético, que puede ser de la otra persona («Ahorros Bancolombia», de Andrea, al abonar la Visa de Wilson). Al
  guardar sale «Eso ya no existe.» y el abono no queda. La lista también ofrece Efectivo, Nequi y Payoneer de Andrea.
  Solo funciona si la persona adivina que debe cambiar la cuenta. Filtro solo por `kind = 'asset'`, sin mirar si puede
  escribir en la cuenta: `db/queries/debts-screen.ts:286`, `db/queries/debt-detail.ts:115-125`. `C/28-abonar-360.png`.
- **Ajustes · Cuentas, cuenta de otra persona, 360.** El menú ⋮ ofrece «Editar», «Archivar», «Pasar al fondo» y
  «Eliminar» en las cuentas de Andrea. Ninguna funciona y los rechazos mienten: editar dice «Esto cambió mientras lo
  editabas. Vuelve a abrirlo.» (al reabrir pasa lo mismo, sin fin), archivar dice «Eso ya no existe.», y el diálogo de
  pasar al fondo dice «La cuenta deja de ser tuya». `canWrite` solo oculta «Cuadrar»:
  `components/accounts/accounts-screen.tsx:637-657`. `C/23-cuentas-menu-ajena-360.png`,
  `C/24-editar-cuenta-ajena-360.png`, `C/27-archivar-ajena-360.png`.
- **Planeación · Pagos y Metas, elementos de otra persona, 360.** «Registrar pago» sobre «Impuesto predial» de Andrea y
  «Aportar» sobre su «Fondo de emergencia» se le ofrecen a Wilson y responden «Eso ya no existe.». La misma persona, en
  su propia cuenta, sí puede (`C/35-registrar-pago-propio-360.png`). `C/34-registrar-pago-ajeno-360.png`,
  `C/41-aportar-meta-ajena-360.png`.
- **Reportes, Inicio y Nuevo presupuesto, categorías duplicadas, todas las anchuras.** El fondo y cada persona tienen el
  mismo catálogo y desde el 2026-10-30 ninguno lleva marca. «Gastos por categoría» muestra «Arriendo $ 1.411.560 · 38 %»
  y «Arriendo $ 1.400.000 · 38 %», y lo mismo con «Servicios» y «Mercado». Inicio dice «Arriendo 38 % · Arriendo
  38 %». El selector de «Nuevo presupuesto» lista las 19 categorías dos veces, sin encabezado ni sangría para las
  subcategorías, así que elegir «Mercado» es una moneda al aire. `C/sweep/lead_es_reports-360-light.png`,
  `C/sweep/lead_es-1280-light.png`, `C/43-presupuesto-categorias-duplicadas-360.png`.
- **Todo el hogar sin dueño, 360 y 1280.** Wilson ve lo personal de Andrea (RF-58) y en ningún lado dice que es de
  ella. Movimientos: «Mercado semanal · Gasto · Nequi». Cuentas: las de los dos juntas bajo «Personal». Deudas: «Tarjeta
  CMR Falabella» sin dueña. Inicio: «Por pagar · Impuesto predial» y «Cerca del límite» con los presupuestos personales de
  Andrea. Presupuestos, Metas y Pagos llevan la insignia «Fondo» aunque las 5 filas de cada uno son personales de
  Andrea (lo verifiqué en la base: `group_id` nulo). `C/sweep/lead_es_movements-360-light.png`,
  `C/sweep/lead_es_settings_accounts-360-light.png`, `C/sweep/lead_es_planning_budgets-360-light.png`.
- **Ajustes · Cuentas, tarjeta de otra persona.** La insignia dice «Lo que debo» sobre la tarjeta de Andrea en la
  pantalla de Wilson. La app le dice que debe una deuda que no es suya. `C/sweep/lead_es_settings_accounts-360-light.png`.
- **Nuevo movimiento · ingreso al fondo con «De quién», 360.** «Otros ingresos» de 300.000 al fondo arranca en «Sin
  asignar» y queda fuera de «Aportes del mes» sin aviso al guardar. «Salario» arranca con quien escribe, así que si
  Wilson anota la quincena de Andrea, el aporte va a nombre de Wilson salvo que lo corrija. Después de guardar, «De quién»
  no aparece en ninguna parte: ni en la fila de la lista ni en el detalle del movimiento (el detalle sí muestra «Del
  hogar»). La única forma de saber a quién se le contó es abrir «Editar». `components/transactions/movement-form.tsx:419-437`.
  `C/16-ingreso-o-traspaso-360.png`, `C/38-detalle-ingreso-sin-dequien-360.png`, `C/40-editar-ingreso-dequien-360.png`.
- **Nuevo movimiento · primer gasto, 360.** Si no hay una cuenta usada antes, «Categoría» sale vacía: ni fichas, ni
  «Más», ni una línea que diga «elige una cuenta primero». Si se guarda, el error es «Asigna al menos una categoría.» y no
  hay nada que tocar. Las fichas solo aparecen cuando la persona elige una cuenta, más abajo en el formulario.
  `C/12-anotar-vacio-360.png`, `C/18-gasto-personal-sin-categoria-360.png`.
- **Movimientos · lista, 360 claro y oscuro.** Cada fila corta título y cuenta: «Aporte de Wilson…», «Servicios ·
  Cuent…», «Traspaso · Nómin…». En el teléfono no se sabe a qué cuenta fue el movimiento sin abrirlo. Las pestañas de tipo
  también se salen («Tras…», «Diferencia» queda fuera de la vista). En la misma lista, la categoría de un movimiento de
  Andrea aparece como «Gasto» («Internet Claro… · Gasto · Visa» visto por Andrea), aunque Reportes sí la nombra.
  `C/sweep/lead_es_movements-360-dark.png`, `C/sweep/member_es_movements-360-light.txt`.
- **Planeación (mosaico) · Pagos planificados, 360.** Los nombres se cortan a «Impues…», «Matrícu…», «Seguro …», y el
  pago vencido del 27 oct no lleva rojo, aunque en Inicio sí. `C/sweep/lead_es_planning-360-light.png`.

## Hollow

- **Bandeja y «Correos del banco».** La pestaña promete «los mensajes del banco que reenvías» y pide «haz que el correo
  … de tu banco envíe cada aviso a esta dirección». Esa «dirección» es `http://…/api/webhooks/ingest`, que espera un POST
  JSON con «Authorization: Bearer». Un correo no se puede reenviar a una URL. Para un hogar, la bandeja no se conecta a
  nada sin programar un atajo, y ocupa un lugar fijo en la barra inferior que antes tenía Planeación.
  `C/sweep/lead_es_inbox-360-light.png`, `C/sweep/lead_es_settings_webhooks-360-light.txt`.
- **Deuda · «Nueva compra a cuotas».** Aparece dos veces en el detalle y abre el plan de RF-81 (valor financiado,
  número de cuotas, frecuencia, primera cuota, aval). RF-81 se retiró el 2026-09-06, RF-136 sigue sin marcar y
  `DESIGN.md` dice que este diálogo pasa a ser «proponer diferir». Es comportamiento retirado que se ve vigente.
  `components/planning/installment-plan-dialog.tsx`, `components/planning/debt-detail-screen.tsx:17`.
  `C/32-compra-a-cuotas-360.png`.
- **Ajustes · Auditoría.** Cada entrada se nombra por su UUID («f0d0b465-cdaa-4f57-…») y por la tabla en jerga
  («Desgloses»). Parece un visor y nadie puede leerlo. `C/sweep/lead_es_settings_audit-360-light.png`.
- **SPEC de RF-166.** La casilla sigue sin marcar y el texto dice «defaulting to the person writing it». Lo construido
  (#727 y #736, «De quién solo con Salario») propone a quien escribe solo con Salario. El contrato y la app no dicen lo
  mismo. `docs/SPEC.md:115`, `components/transactions/movement-form.tsx:419`.
- **«Efectivo del grupo».** Es el nombre que se siembra para la caja del fondo y lo ven el onboarding, Cuentas, el
  formulario y Retirar efectivo. `DESIGN.md` decidió «fondo, nunca grupo» el 2026-10-15. `lib/fund/seed.ts:25`.
  `C/03-onboarding-cuentas-360.png`.

## Thin

- **Reportes · «Aportes del mes».** Solo dice cuánto puso cada uno (Andrea $ 1.500.000, Wilson $ 1.096.000). No hay
  total, ni gasto del fondo al lado, ni saldo de la caja, ni «quién va arriba». La tabla de `FLOWS.md` §4 promete
  aporte, gasto compartido y saldo de la caja juntos. Se vuelve útil con esas tres cifras y una meta de reparto.
- **Reportes e Inicio.** Mezclan lo del fondo con lo personal de los dos. No hay forma de ver «lo que gastó la casa»
  aparte, ni de filtrar por persona. Se vuelve útil con un selector Fondo / Wilson / Andrea / Todo.
- **Pagos · «Registrar pago».** Solo pide la fecha. El monto y la cuenta quedan como se planearon, aunque el predial o
  el seguro casi nunca cuestan lo planeado. Se vuelve útil si deja corregir el monto antes de registrar.
  `C/35-registrar-pago-propio-360.png`.
- **Metas.** «Fondo de emergencia · 2 sept 2026 · $ 7.400.000/mes» dos meses después de la fecha: una cuota mensual
  de una meta vencida no significa nada. Lo arregla un estado «Venció el …» con «Cambiar fecha».
- **Cuentas · «Pasar al fondo».** Se rechaza en cualquier cuenta con movimientos («Archívala en su lugar»). El caso
  real, «mi Nequi pasa a ser la del hogar», nunca se puede hacer. `C/26-pasar-al-fondo-ajena-resultado-360.png`.
- **Movimientos.** No hay búsqueda por texto. Con 423 movimientos son «1 de 22» páginas de Anteriores/Siguientes.
  Encontrar «la cuota del colegio de marzo» cuesta 22 páginas o adivinar el filtro.
- **Añadir cuenta.** «Lo que debo» solo ofrece «Tarjeta». No se pueden registrar el crédito de vivienda, el del carro
  ni un préstamo familiar, aunque RF-09 nombra «loan».

## Notas

- Tamaño táctil por debajo de los 44 px que fija `DESIGN.md`: interruptores de Recurrentes y de Datos de 35×20 (11
  en Datos), paginador de Auditoría de 30×30, «Copiar» de 32×32 en Bandeja y Correos del banco, «‹ mes anterior» de
  88×20 en Revisar el mes.
- Palabra partida: «Suscripcione / s» en la ficha de categoría (`C/14-anotar-rapido-360.png`). «Trabajo
  independien…» cortado (`C/16-ingreso-o-traspaso-360.png`).
- Onboarding · Invitar: el campo de correo no tiene etiqueta, solo placeholder. «Ir al panel» y «Omitir por ahora» hacen
  lo mismo (`C/08b-onboarding-invitar-dialogo-360.png`).
- Onboarding · Cuentas: «Ya agregadas» no dice cuál es del fondo y cuál personal, y no sigue el orden en que se crearon
  (`C/05-onboarding-cuentas-llenas-360.png`).
- Primer uso sin fondo: «Aquí vas a ver los saldos y los movimientos del fondo.» a alguien que todavía no tiene fondo
  (`C/01-primer-uso-360.png`).
- Inicio: el color identifica la posición y no a la persona. El fondo y «Andrea US$» comparten el lima, y Andrea es
  violeta en COP (`C/sweep/lead_es-1280-light.png`).
- Inicio: «El mes de un vistazo» repite justo debajo las mismas cifras de Ingresos y Gastos de la tarjeta de arriba.
- Reportes: la etiqueta «Promedio $ 4.738.381» se monta sobre «$4,1 M», y «US$ 12» sobre el promedio en USD
  (`C/sweep/lead_es_reports-360-light.png`).
- Recurrentes: una regla «Pausada» sigue mostrando «próxima 13 nov».
- Revisar el mes, visto por quien no puede corregir: «Lo corrige quien maneja Tarjeta Visa Bancolombia.» no dice quién
  es (Andrea).
- El abono a tarjeta queda en la lista con el título «Traspaso» y sin descripción, igual que el gasto de entrada rápida
  «mercado 85 mil», que queda sin nota.
- Inicio muestra a Wilson «3 sin revisar»: son automáticos de Andrea que él no puede revisar.

## Ideas para mejorar (por valor)

1. **Nombrar al dueño en todo lo ajeno.** Agregar «· Andrea» en la fila, el saldo, la deuda, el pago y el
   presupuesto, y separar Cuentas en «Mías», «De Andrea» y «Del fondo». Con eso se resuelven cinco hallazgos de arriba.
2. **No ofrecer lo que no se puede hacer.** Usar `canWrite` en cada menú y botón (cuentas, pagos, metas, abono) y
   filtrar «Pagar desde» a las cuentas propias y del fondo. Cuando el servidor rechace por permiso, decir «Esta cuenta es
   de Andrea; solo ella puede cambiarla», nunca «Eso ya no existe».
3. **Cuentas claras del hogar en una tarjeta.** Mostrar en Reportes, y resumido en Inicio: aportó Andrea, aportó
   Wilson, gastó el fondo, queda en la caja, y la diferencia contra el reparto acordado.
4. **Vista «Fondo / Persona / Todo»** en Inicio, Reportes y Movimientos.
5. **Un solo nombre por categoría a la vista.** Encabezados «Del fondo» y «Mías» en los selectores, y en Reportes
   sumar por nombre o marcar el ámbito.
6. **«De quién» visible después de guardar**, en la fila y en el detalle, más un aviso en Aportes con un enlace a los
   ingresos «Sin asignar» para asignarlos.
7. **Búsqueda por texto en Movimientos.**
8. **Préstamos como clase de deuda** (cuota fija, plazo, tasa), con el próximo pago en Deudas.
9. **Registrar pago con monto editable.**
10. **Estado «Vencida» en metas**, y quitar «próxima» de las reglas pausadas.

## Questions for the user

**1. Las categorías repetidas del fondo y de cada persona.**
- a) Marcar el ámbito otra vez: encabezados en los selectores y un ícono o «· fondo» en Reportes. Cuesta revertir en
  parte la decisión del 2026-10-30 («nombre limpio en todas partes»).
- b) Sumar por nombre en Reportes e Inicio («Arriendo $ 2.811.560»), y separar solo en los selectores. Cuesta que un
  presupuesto del fondo y el reporte cuenten distinto.
- c) No sembrar el catálogo personal a quien entra a un fondo. Cuesta que su gasto personal no tenga categorías hasta
  que cree las suyas, y hay que retirar el código de RF-64.
- Mi opinión: a.

**2. Cuánto ve cada miembro de lo personal del otro (RF-58).**
- a) Lo ve todo, como hoy, pero siempre con el nombre del dueño y sin acciones sobre lo ajeno. Cuesta poco, y no cambia
  el RF.
- b) Ve los saldos del otro pero no sus movimientos, presupuestos ni pagos. Cuesta retirar RF-58 y abrir uno nuevo, y
  cambiar políticas.
- c) Igual que a), pero lo planificado personal del otro sale de Inicio («Por pagar», «Cerca del límite», «Meta»). Cuesta
  un filtro por dueño en esas lecturas.
- Mi opinión: a y c juntas.

**3. ¿Qué significa «estar a mano» en el hogar?**
- a) Nada nuevo: Aportes sigue como lista y se le agregan el gasto del fondo y el saldo de la caja. Es lo más barato.
- b) Reparto 50/50: la app dice «Wilson va $ 202.000 abajo este mes». Cuesta un campo en el fondo y un RF nuevo.
- c) Reparto proporcional al ingreso de cada uno. Cuesta lo mismo que b), más definir qué cuenta como ingreso de cada
  persona.
- Mi opinión: a ahora, y b como opción del fondo en la siguiente tanda.

**4. La Bandeja en la barra del teléfono.**
- a) Dejarla y reescribir el texto: es una dirección para atajos o automatizaciones, no para correos. Cuesta solo
  palabras, pero el lugar más visible de la app sigue vacío para casi todos.
- b) Devolver Planeación a la barra y llevar la Bandeja a Ajustes hasta que exista una entrada que una persona pueda
  conectar. Cuesta revertir la decisión del crítico de usabilidad del 2026-10-30.
- c) Construir una dirección de correo de entrada real. Cuesta un servicio de correo entrante, en tensión con RNF-01
  (costo cero) y RNF-13 (nada sale a terceros).
- Mi opinión: b.

**5. El valor inicial de «De quién».**
- a) Solo con Salario, como hoy, y corregir el texto de RF-166 para que diga eso. El riesgo de acreditar el ingreso a la
  persona equivocada sigue.
- b) Siempre quien escribe, como dice el SPEC hoy. Cuesta que un reembolso o un regalo cuente como aporte.
- c) Sin valor inicial y obligatorio en todo ingreso al fondo. Cuesta un toque más por ingreso, y ningún aporte queda mal
  atribuido ni perdido en silencio.
- Mi opinión: c.

**6. «Nueva compra a cuotas» (RF-81 retirado).**
- a) Quitarla hasta construir RF-136 («proponer diferir»). Quien hoy registra cuotas deja de poder hacerlo, aunque la
  cifra que da no es la que el SPEC acepta.
- b) Construir ya RF-136 y reemplazar el diálogo. Es un módulo con preguntas de deuda abiertas (`DESIGN.md`, los cinco
  casos de deuda).
- Mi opinión: a ahora y b en la tanda de deudas.

## Lo que no pude alcanzar

- **El correo de invitación y el de recordatorio:** no envié correo. Para invitar a la segunda persona escribí en la
  base local un `invite_email` pendiente y probé la aceptación por la pantalla.
- **La Bandeja con avisos reales y «Por completar»:** no había entregas y no llamé al webhook.
- **Import y export de archivos:** abrí Datos, pero no descargué ni subí un archivo.
- **El MCP de Claude:** no lo usé, porque costaría un modelo.
- **Un problema de mi arnés, no de la app:** la identidad de prueba entra sin pasar por `/auth/confirm`, así que no
  recibió las categorías personales que siembra el primer ingreso (`lib/auth/land-session.ts:41`). Se las copié por SQL
  antes de juzgar el formulario. El «sin categorías» de `C/17` y `C/18` no se le pasa a una persona real.
