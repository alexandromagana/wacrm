# El diseño de la cotización

Las reglas del formato de cotización y sus anexos de financiamiento. El diseño
vive en Figma; el código que lo llena está en `src/lib/quotes/` y el que lo
prepara en `scripts/build-quote-template.mjs`.

Cómo se llena, el contrato de datos y las validaciones están en
[quote-handoff.md](./quote-handoff.md).

## Registro de archivos

| Estado | Frame / archivo | Origen |
| --- | --- | --- |
| 📄 sólo diseño | Formato de Cotización 2026 | Figma **Design** · `0rDUmRnUWSDgfmXtVjALD4` |
| 📄 sólo diseño | Anexo de financiamiento Nuvolt | Figma **Design** · `0rDUmRnUWSDgfmXtVjALD4`, hoja `F arena` |
| 📄 sólo diseño | Anexo de financiamiento, horizontal | Figma **Design** · `0rDUmRnUWSDgfmXtVjALD4`, hoja `FH arena` |

Los exports viven en `design/` — SVG por hoja más el PDF completo
(`Bot _Template_Update.pdf`). Esa carpeta está en `.gitignore` a propósito: son
decenas de MB y lo que se despliega es el template ya procesado en
`public/quotes/template.pdf`.

---

**La cotización no se reimplementa como vista.** Se diseña en Figma, se exporta
a PDF y el código dibuja los valores encima. No es una pantalla de la app. Vive
en Figma a propósito: el asesor edita el diseño sin tocar el repo. Reusa la
paleta de la marca y los SVG del logotipo, los mismos que usa la landing
(`gama-energia`, `src/index.css` y `src/assets/`), así que si cambia la marca
hay que actualizar los dos lados.

**El financiamiento es un anexo, no una hoja más.** `F arena — Financiamiento
Nuvolt` reemplaza la tabla que Nuvolt manda en Excel. Se adjunta solo cuando el
cliente pide crédito, por eso su pie dice «Anexo · Financiamiento» en vez de
«Hoja X de Y»: así no rompe la numeración de A1/A2.

**Es la única hoja que no usa la paleta de Gama.** Va en la paleta de Nuvolt
(`color/aliado/*`: noche `#0F2A55`, azul `#375FA0`, cielo claro `#5CC7F0`,
ámbar `#FBC63C`) y abre con una masthead azul noche a sangre. Es a propósito:
el crédito lo da Nuvolt, no Gama, y el cliente tiene que distinguir de un
vistazo qué le vende cada quien. El papel arena, la retícula de 60 px y las dos
tipografías siguen siendo las mismas, así que la hoja se imprime junto a A1/A2
sin desentonar.

El logotipo de Nuvolt está vectorizado en el componente `Logo / Nuvolt`.
**No se recolorea:** el degradado azul→turquesa y el rayo ámbar son la marca
del aliado.

**Hay dos orientaciones y no son la misma hoja estirada.** `F arena` es carta
vertical (816 × 1056) y pone las cinco mensualidades en filas: es la que se
imprime y la que se adjunta al PDF de la cotización. `FH arena` es carta
apaisada (1056 × 816) y las pone en cinco columnas, que es lo que el formato
horizontal sí permite y el vertical no — se comparan de un vistazo, sin
recorrer la lista. Esa es para pantalla: mandarla por WhatsApp, abrirla en la
laptop frente al cliente o meterla en una presentación.

**Las dos usan los mismos nombres de campo**, así que un solo objeto de datos
llena cualquiera de las dos sin tocar el código de llenado.

**El archivo tiene tres cortes del mismo contenido.** La *versión larga* son
dos portadas alternativas, 8 páginas y un anexo, para cuando el cliente pide
detalle. La *versión A* condensa todo en 2 hojas y es la que se manda por
WhatsApp. La *versión B* usa 3 hojas y respira más, para imprimir o presentar.
A y B son precotizaciones: no llevan garantías ni datos del cliente, y su
proceso arranca en «Precotización» para ubicar al cliente en el paso 01.

**Rojo y verde significan cosas.** Toda cifra que va a CFE — el recibo actual,
la proyección a 12 meses, lo que pagaría sin paneles — se pinta en rojo
(`color/dato/rojo`). Producción, ahorro, garantías y mensualidades van en verde
de marca. No es decoración: es lo que hace legible el documento de un vistazo,
y hay que respetarlo al agregar contenido. La excepción es el anexo de
financiamiento, donde las mensualidades van en azul Nuvolt; está explicada en
[quote-handoff.md](./quote-handoff.md), §5.

**Una idea por página, con una forma que la sostenga.** Cada página lleva un
titular a dos tonos y una o dos formas: bloques de color, círculos que crecen
con la cifra, cuadros de panel o fila de datos. En la página 03 los diámetros
de los círculos deben seguir la proporción real de los montos al llenarlos. No
hay bloque de datos del cliente en el cuerpo: eso vive en la portada y en el
cierre. Si hace falta contenido nuevo, se agrega una página, no se aprieta una
existente.

**La tipografía diverge de la landing.** El documento usa **Archivo** para el
texto e **IBM Plex Mono** para etiquetas y datos técnicos, no Poppins. Fue una
decisión de diseño para el registro editorial que pidió Alexandro; el logotipo
sigue siendo vectorial, así que la marca no se ve afectada. Si algún día se
unifica, se cambian los text styles del archivo de Figma y todo el documento se
actualiza solo.

---

## Al cambiar el diseño en Figma

1. Exportar el PDF completo a `design/`.
2. Correr `node scripts/build-quote-template.mjs` — rasteriza la portada y
   valida el tamaño de las 5 páginas.
3. **Mirar las páginas 2 y 5 del resultado.** Todo campo variable tiene que
   estar en opacidad 0 en Figma; un placeholder visible se encima con el valor
   en cada propuesta, y ninguna extracción de texto lo detecta. El aviso largo
   está en el encabezado del script.
4. Si se movieron campos, actualizar `src/lib/quotes/template.json`.
5. Si cambiaron las tasas de Nuvolt, cambian **los dos lados**: el arte en
   Figma y `PLANES` en `src/lib/quotes/financing.ts`. `financing.test.ts` las
   fija justamente para que no se desincronicen.
