# Lecciones de diseño de Agenda Amiga

Críticas de diseño y usabilidad que el usuario hizo al construir Agenda Amiga (agendaamiga.com), escritas como reglas
para que el crítico de cualquier app juzgue con los mismos criterios.

- Fuentes: `#N` es un PR de `WAB-Studio/turno`; un hash es un commit de `Cxrkeyb/agenda-amiga`; `D<n>`, `RF-`, `RNF-`
  viven en `docs/SPEC*.md` de ese repo. Entre «…» van las palabras citadas por la fuente.
- Juzga con estas reglas; el diseño de cada app sigue siendo suyo (`AGENTS.md`: nunca copiar un patrón entre apps).

## Marca y color

- Elige la marca entre variantes dibujadas y fija la elegida como decisión con nombre; deja nombre, colores y letras en
  pocos lugares para cambiarlos («y luego miramos si cambiamos»). (SPEC-9 D54, `DESIGN.md` §0)
- Usa un acento fuerte y uno de apoyo sobre fondo blanco (cobalto #1E3BFF y amarillo #FFD23F); gasta el de apoyo solo
  en lo que se resalta: la palabra clave del titular, el bloque final, la tarjeta de lo ganado. (#119, D54)
- Mide el contraste antes de fijar un acento: `jade` daba 3,15:1 con texto blanco y se cambió. (`DESIGN.md` §2.1, #8 → #117)
- Reserva el color fuerte para el estado y para distinguir personas; nunca comuniques un estado solo con color.
  (`DESIGN.md` §1.4 y §2.2, RNF-12)
- Pinta los bloques de color en tono suave con borde del color, no en color pleno: el pleno no pasaba AA. (#128)
- Deriva todos los tonos de un color que elige el usuario y rechaza el que no se lee (≥ 3:1 sobre blanco, AA en texto);
  pruébalo con miles de colores al azar. (RF-346, RNF-75)
- Da un color por defecto según el tipo de cliente; nunca cambies uno ya guardado. (abda9be)
- Muestra el sitio público siempre en claro aunque el dispositivo pida oscuro. (#119)
- Lleva la marca a cada superficie: favicon, ícono PWA, imagen OG, entrada, correo del código, QR, onboarding. (#123, #144, #148)
- Deja que la página del cliente final lleve la marca del negocio, no la tuya; la tuya va solo en el pie. (`DESIGN.md` §0, RF-332)

## Tipografía

- Usa dos familias: una de títulos con carácter (Space Grotesk) y una de texto legible (DM Sans). (D54)
- Pon cifras tabulares en horas, precios y totales; formatea en el idioma local («3:00 p. m.», «$45.000»). (`DESIGN.md` §1.5)
- Recorta familias: diez pasaron a cuatro y luego a tres; descarga solo las de la página, ninguna precargada. (#137, #139, RNF-76)
- Da a la letra de lectura al menos 14 px. (#160)
- Revisa que ninguna palabra se corte: la crítica lo encontró en los estilos. (D59)

## Composición y jerarquía

- Diseña móvil, tablet y escritorio por separado; el usuario pidió que no fuera «móvil primero» estirado. (#4, RNF-11)
- Prueba también a 1920 × 1080 y en pantallas altas: el pie llega al fondo, la foto no crece sin fin, el contenido se
  centra. (#141, #148, #150)
- Quita el margen de 8 px del navegador: deja franjas blancas junto a las bandas de color. (#121)
- Prohíbe el scroll horizontal de página desde 360 px; pasa tablas a tarjetas en el celular. (RNF-11, #139, #150)
- Haz que la pantalla principal sea el producto (la agenda) y que todo lo demás quede a un toque, sin taparla. (`DESIGN.md` §1)
- Usa el ancho en escritorio: dos columnas con el resumen fijo al lado; en el celular, una columna y barra fija abajo. (RF-344)
- Prefiere un diseño básico y bonito que el usuario arma con bloques a muchos temas parecidos. (D61)
- Diferencia de verdad o no ofrezcas variantes: los estilos con estructura común «se veían casi iguales al bajar». (D60)
- Agrupa los ajustes por lo que hacen y pliega lo avanzado; separa dinero de equipo y stock. (#150, bad8520)
- Muestra los resúmenes como cifras grandes en tarjetas. (#144, #148)
- Cabe sin scroll en la barra lateral. (d08636f)
- Quita el espacio vacío de las secciones en el celular. (6c90aec)
- Compón en mosaico (grande, mediana, de color, ancha), no en zigzag de bloques iguales. (#139)
- Di la promesa en una frase, no en tres. (#134)

## Imágenes y fotos

- Usa fotos con caras y calidez, revisadas una a una; cambia las frías o sin caras. (#128)
- Entrega fotos nítidas: recorta a su marco, sirve a doble densidad (hasta 2400 px), `sizes` según el ancho real; el
  usuario criticó fotos borrosas. (#134, #135)
- Mantén la foto liviana (WebP pequeño) para pintar antes de 2,5 s en 4G. (89c25d3, RNF-23)
- Desenfoca letreros y marcas ajenas dentro de la foto. (#135, `FOTOS.md`)
- Anota fuente, autor y licencia de cada foto en un documento. (`FOTOS.md`)
- Muestra capturas reales del producto, nunca maquetas que el producto no tenga. (RF-102)
- Llena las capturas con datos creíbles («Casa Lila»), nunca con «Uñas Demo 7216»; sácalas al doble de resolución. (#134)
- Cambia seis celulares diminutos por uno grande y legible con pestañas por paso. (#134)
- Dibuja la pantalla del hero en HTML en vez de una imagen: pinta con el texto (LCP de 2,0 a 1,5 s). (#119)
- Llena el hueco cuando falta foto: logo, foto del tipo de negocio o inicial sobre el color; nunca un bloque vacío. (#137, abda9be)

## Copia y tono

- Escribe escenas con voz real: día, hora y un caso concreto («Sábado, 9:12 de la noche. Te escriben 14 personas…»). (#128)
- Marca cada función «Incluido» o «Llega pronto» desde una sola lista; no prometas lo que no está. (RF-104, #123, #160)
- No nombres a la competencia en el sitio, el importador ni los precios. (D11, abda9be)
- Escribe textos neutros que sirvan a cualquier tipo de negocio y nombres que digan lo que hace cada cosa. (#160, bad8520)
- Abre con una línea que dice qué es y un titular que vende («Una página que se ve como tu salón»). (#137, #150)
- Explica el acceso cuando no es libre («Por ahora se entra por invitación»). (5ae4177, sitio en vivo)
- Pon nombres humanos a los planes: «Independiente» en vez de «Solo». (#123)
- Muestra el precio en la moneda del usuario, nunca la base interna. (RF-327)
- Titula cada página con lo que la gente busca. (RF-331)
- Llama a la persona por su nombre («¡Listo, nombre!»; el de la dueña en vez de «Dueño(a)»). (#128, #160)
- Explica por qué una cifra da 0 y qué hacer. (5ae4177)
- Di en el error qué pasó y qué hacer, junto al campo o al botón, nunca solo en un aviso flotante. (`DESIGN.md` §5, #156)

## Usabilidad móvil

- Haz cada control táctil de al menos 44 × 44 px y deja la acción principal al alcance del pulgar. (`DESIGN.md` §5, RNF-11)
- No dependas del hover: lo que en escritorio se prueba al pasar el mouse va en una tira en el celular. (#128)
- Deja «Entrar» a la vista en el celular, o en el menú con el botón fuerte aparte. (#117, #150)
- Haz caber los pasos del onboarding en una línea. (#144)
- Pon la vista previa primero en el celular. (#137)
- Fija abajo una barra con el resumen de lo elegido. (#128)
- Nombra el mes en la tira de días. (#160)
- Abre la vista del día en la hora actual; la cabecera fija no tapa el contenido. (#160)

## Formularios y flujos

- Prueba cada pantalla con personas simuladas por rondas (dueña, empleada, cliente) y arregla lo que encuentran. (#156, #160)
- Pon la etiqueta visible arriba del campo, nunca solo el placeholder. (`DESIGN.md` §4.4, #139)
- Un paso por pantalla en el celular, el paso en la URL y un Atrás que sigue lo que se ve. (#156, 5ae4177)
- Bloquea el doble envío al volver atrás: «Ya reservaste esta hora» con «Ver mi cita». (#160)
- Preelige lo obvio (primer día con cupo, lo que trae el enlace) y conserva lo marcado al volver. (#156, #160)
- Avisa antes de un cambio grande («pasa del … al …») y haz que el botón lo nombre. (#160)
- Edita con vista previa en vivo, tocando el texto mismo, con Descartar y Guardar a la vista. (#128, RF-349)
- Publica solo con un botón explícito («Publicar cambios»). (RF-349)
- Aleja lo destructivo del botón principal («Cancelar cita» lejos de «Cobrar»). (5ae4177)
- Usa dos botones en vez de botón más casilla («Rechazar» y «Rechazar y bloquear»). (D65)
- Resuelve lo que falta en el lugar: abrir la caja desde el cobro en un toque, agregar un método y volver. (#160, abda9be)
- Explica cada interruptor con una línea y pliega las opciones avanzadas. (D63, 5ae4177)
- Marca los miles mientras se escribe un monto. (5ae4177)
- Guía la primera vez sobre los botones reales, saltable y sin volver solo. (RF-350)

## Lo que el usuario rechazó

- Los adornos de plantilla que hacían ver la portada «hecha con IA»: cejas con punto en mayúsculas, destellos, manchas de
  degradado, onda y aro, subrayado y flecha dibujados, chips de tipos, chulos azules, anillo en los llamados. (#123 → #134)
- Diez estilos que eran «la misma plantilla con otra ropa», pese a haber pedido «10 estilos para que tengan que elegir». (D55 → D59)
- Cuatro estilos con estructura común: casi iguales al bajar. (D59 → D60)
- La dirección «Moderna» al usarla: prefirió «un diseño sencillo y bonito» por bloques. (D60 → D61)
- Las fotos borrosas, frías o sin caras. (#128, #134)
- Los datos de demo a la vista en capturas («Uñas Demo 7216»). (#134)
- El zigzag de cuatro bloques iguales. (#139)
- El diseño «móvil primero» estirado a tablet y escritorio. (#4)
- Un tipo de cliente premarcado («Uñas») y textos atados a un solo oficio. (#160)
- Un interruptor encendido por defecto que perjudica al usuario real: se retiró por ser «una medida vaga que perjudica al salón». (4213536, D64)
