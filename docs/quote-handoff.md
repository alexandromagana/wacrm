# Handoff: llenar la precotización desde el agente

Cómo dejar el diseño de Figma listo para que un agente lo llene con los datos
de un recibo CFE y mande el PDF.

Las reglas del diseño están en [quote-design.md](./quote-design.md).

> ## Estado: parte de esta guía ya se implementó
>
> El documento se escribió **antes** de que existiera `src/lib/quotes/`, cuando
> todavía se estaba decidiendo cómo llenar el PDF. Se conserva porque el
> contrato de datos, las reglas de diseño y las validaciones siguen siendo la
> referencia de por qué los números y los colores son los que son — pero varias
> secciones describen un camino que no fue el que se tomó.
>
> | Sección | Estado |
> | --- | --- |
> | §1.1 convención de capas `campo.*` | **Superado.** El renderer dibuja encima de placeholders en opacidad 0, no busca capas por nombre. Ver el aviso en `scripts/build-quote-template.mjs`. |
> | §1.2 plantilla limpia de 2 hojas en `assets/` | **Superado.** Hoy son 5 páginas (4 verticales + el anexo apaisado), de `design/Bot _Template_Update.pdf` a `public/quotes/template.pdf` vía `scripts/build-quote-template.mjs`. |
> | §2 elegir el motor (Opción A vs B) | **Histórico.** Se eligió A: `pdf-lib` sobre el template exportado. Ver `src/lib/quotes/render.ts`. |
> | §3 sacar coordenadas de la API de Figma | **Superado.** Viven en `src/lib/quotes/template.json` y las coloca `layout.ts`, que además reduce el tamaño para que una cifra larga no se salga. |
> | §4 contrato de datos y formato de números | **Vigente.** Es lo que producen `pricing.ts`, `finance.ts`, `financing.ts` y `fields.ts`. Las cinco tasas coinciden con `PLANES` en `financing.ts`. |
> | §5 reglas de diseño | **Vigente.** |
> | §6 flujo y revisión humana | **Vigente.** |
> | §7 validaciones mínimas | **Vigente.** |
> | §8 pendientes | **Revisar.** Escrito antes de `pricing.ts`; algunos ya se resolvieron. |

---

## 0. El dato que define todo lo demás

**La API pública de Figma es de solo lectura para el contenido.** No existe un
endpoint para escribir texto en un archivo. Escribir requiere un plugin
corriendo dentro del editor, con una sesión de Figma abierta.

Consecuencia práctica: el agente **no** puede tomar el archivo de Figma y
rellenarlo. Figma se queda como la fuente de verdad del diseño; el llenado se
hace en tu repo, sobre un artefacto exportado.

Lo que sí puedes hacer con la API pública, y conviene aprovechar, es **leer**
la posición y el estilo de cada campo (sección 3).

---

## 1. Preparar el archivo de Figma

Una sola vez, en el archivo donde pegaste las hojas finales.

### 1.1 Nombrar las capas editables

Renombra cada capa de texto que va a cambiar con un prefijo consistente. La
convención sugerida:

```
campo.folio
campo.vigencia
campo.fecha_emision
campo.gasto_sin_bimestre
campo.gasto_sin_anio
campo.gasto_sin_25
campo.gasto_con_bimestre
campo.gasto_con_anio
campo.gasto_con_25
campo.ahorro_25
campo.payback_frase
campo.paneles
campo.watt_panel
campo.kwp
campo.kwh_bimestre
campo.precio_total
campo.enganche
campo.mensualidad_12
campo.mensualidad_24
campo.mensualidad_36
campo.mensualidad_48
campo.mensualidad_60
campo.tasa_12
campo.tasa_24
campo.tasa_36
campo.tasa_48
campo.tasa_60
campo.sistema_resumen
```

`campo.folio` y `campo.vigencia` van separados a propósito. Antes eran una
sola tira de texto («Precotización GE-… · Vigencia 15 días naturales») que a
6.8 px se leía como un borrón; ahora son dos pares etiqueta/valor alineados a
la derecha, igual que en A1. Se cambió en las dos hojas donde estaba apretado:
`A2 arena` y `F arena`.

Los `campo.tasa_*` y `campo.sistema_resumen` son de la hoja de financiamiento
(`F arena`). Las tasas traen los valores vigentes de Nuvolt como default: son
constantes contractuales, no datos del cliente, así que la plantilla limpia
**sí** las conserva. Lo que se vacía ahí es el enganche y las cinco
mensualidades.

El nombre de capa es el ancla: es lo que amarra el diseño con el código, sin
importar qué motor elijas después. Si algún día mueves un texto de lugar, el
código sigue funcionando porque busca por nombre, no por coordenada escrita a
mano.

### 1.2 Exportar una "plantilla limpia"

Duplica las hojas, **borra el contenido de las capas `campo.*`** dejando las
capas vacías, y exporta ese duplicado.

Este paso es fácil de saltarse y rompe todo: si exportas con los guiones y el
`$56,359` puestos, esos textos quedan grabados en el PDF y al dibujar encima te
van a quedar los dos superpuestos.

- **Formato:** PDF, una página por hoja (Figma exporta el frame completo).
- **Tamaño:** las hojas están a 816 × 1056 px, que es carta a 96 dpi. Figma lo
  exporta a 8.5 × 11 in.

Guarda ese PDF en el repo, por ejemplo `assets/plantilla-precotizacion.pdf`.

### 1.3 Fuentes

El diseño usa **Archivo** (titulares y cifras) e **IBM Plex Mono** (etiquetas,
folios, micro-copy). Las dos son de Google Fonts con licencia OFL, así que se
pueden empaquetar en el repo sin problema.

Descarga los `.ttf` y guárdalos junto a la plantilla. Vas a necesitar:

- `Archivo-Medium.ttf` — cifras y titulares
- `Archivo-Regular.ttf` — texto corrido
- `IBMPlexMono-Regular.ttf` y `-Medium.ttf` — etiquetas

Los titulares van en **Medium, nunca Bold**. Es lo que mantiene el documento
calmado en vez de gritado.

---

## 2. Elegir el motor de llenado

Dos caminos razonables. La diferencia es cuánto trabajo inicial contra cuánta
flexibilidad después.

### Opción A — Dibujar sobre el PDF exportado (`pdf-lib`)

El agente abre la plantilla, incrusta las fuentes y escribe los ~21 textos en
coordenadas conocidas.

**A favor:** el resultado es idéntico al diseño, píxel por píxel. No hay que
reimplementar nada. No necesita navegador, así que corre en cualquier lambda y
es rápido y barato.

**En contra:** el texto no se reacomoda. Si un valor sale más largo de lo
previsto se encima con lo de al lado. Como aquí casi todo son cifras cortas,
el riesgo es bajo, pero existe.

**Recomendada si el diseño ya está congelado**, que es tu caso.

### Opción B — Reimplementar en HTML y renderizar con Chromium headless

Se rehace el diseño en HTML/CSS con `@page` tamaño carta y se renderiza con
Playwright o Puppeteer.

**A favor:** el texto se reacomoda solo. Si un nombre o un monto crece, el
layout aguanta. Más fácil de mantener si vas a seguir moviendo el diseño.

**En contra:** hay que reconstruir las dos hojas a mano y mantener dos fuentes
de verdad —Figma y el HTML— que se pueden desincronizar. Además Chromium en
serverless necesita `@sparticuz/chromium` y pesa.

---

## 3. Sacar el mapa de coordenadas (para la Opción A)

Esto se hace una vez y se commitea. La API de lectura de Figma te da la
posición exacta de cada campo, así que no tienes que medir a mano.

```
GET https://api.figma.com/v1/files/:fileKey/nodes?ids=:nodeIds
Header: X-Figma-Token: <tu personal access token>
```

De cada nodo de texto te interesan:

- `absoluteBoundingBox` → `x`, `y`, `width`, `height`
- `style.fontSize`, `style.fontFamily`, `style.textAlignHorizontal`
- `fills[0].color` → el color

Con eso generas un JSON tipo `campos.json`:

```json
{
  "precio_total": {
    "hoja": 2, "x": 60, "y": 156, "size": 58,
    "font": "Archivo-Medium", "align": "LEFT", "color": "#093F1F"
  }
}
```

### El detalle que siempre muerde: el eje Y

Figma tiene el origen **arriba a la izquierda**. PDF lo tiene **abajo a la
izquierda**. Además `drawText` de `pdf-lib` posiciona por la **línea base**, no
por la caja del texto.

```js
const alturaPagina = 792          // 11 in × 72 pt
const escala = 72 / 96            // Figma exporta a 96 dpi, el PDF trabaja en puntos
const yFigma = campo.y * escala
const tamano = campo.size * escala
// aproximación de la línea base: ~80% del tamaño desde el borde superior de la caja
const yPdf = alturaPagina - yFigma - tamano * 0.8
```

Ajusta ese `0.8` una vez comparando contra la plantilla y déjalo fijo.

### Texto alineado a la derecha

Los montos de las mensualidades y las columnas del comparativo van alineados.
Mide antes de dibujar:

```js
const ancho = fuente.widthOfTextAtSize(texto, tamano)
const x = campo.align === 'RIGHT' ? (campo.x + campo.width) * escala - ancho : campo.x * escala
```

---

## 4. El contrato de datos

Esto es lo que el agente tiene que producir. Un solo objeto, sin ambigüedad.

```json
{
  "folio": "GE-2026-0042",
  "fecha_emision": "2026-08-10",

  "consumo": {
    "kwh_bimestre": 812,
    "tarifa": "1D",
    "pago_bimestre": 4210.00
  },

  "sistema": {
    "paneles": 5,
    "watt_panel": 625,
    "kwp": 3.75,
    "kwh_bimestre": 800
  },

  "gasto": {
    "sin_paneles": { "bimestre": 4210, "anio": 25260, "veinticinco_anios": 1284500 },
    "con_paneles": { "bimestre": 285,  "anio": 1710,  "veinticinco_anios": 96400 }
  },

  "ahorro": {
    "veinticinco_anios": 1188100,
    "payback_anios": 3,
    "payback_meses": 7
  },

  "precio": {
    "total": 56359,
    "enganche": 6763.08,
    "mensualidades": [
      { "plazo": 12, "tasa": 11.99, "monto": 5407.74 },
      { "plazo": 24, "tasa": 12.99, "monto": 2893.48 },
      { "plazo": 36, "tasa": 13.99, "monto": 2080.02 },
      { "plazo": 48, "tasa": 14.99, "monto": 1693.69 },
      { "plazo": 60, "tasa": 15.99, "monto": 1479.86 }
    ]
  }
}
```

**Del recibo solo salen tres cosas:** `kwh_bimestre`, `tarifa` y
`pago_bimestre`. Todo lo demás es derivado. Cuando le escribas las
instrucciones al agente, sé explícito sobre cuál es cuál — es donde más fácil
se cuela un número inventado que se ve razonable.

### Formato de los números

```js
const pesos = new Intl.NumberFormat('es-MX', {
  style: 'currency', currency: 'MXN',
  minimumFractionDigits: 0, maximumFractionDigits: 0,
})            // $56,359

const pesosCentavos = new Intl.NumberFormat('es-MX', {
  style: 'currency', currency: 'MXN',
  minimumFractionDigits: 2, maximumFractionDigits: 2,
})            // $5,407.74
```

Montos grandes sin centavos; mensualidades y enganche con centavos, como en la
tabla de Nuvolt.

---

## 5. Reglas del diseño que el agente tiene que respetar

No son decoración: son lo que hace legible el documento.

1. **Rojo es lo que sale de su bolsillo. Verde es lo que se queda.** Todo lo
   que va a CFE en `#C8452F`; producción, ahorro y mensualidades en `#108040`.
   Si un número sale con el color contrario, el cliente lee lo opuesto de lo
   que quisiste decir.
   **Excepción: la hoja `F arena` (financiamiento).** Ahí las mensualidades van
   en azul Nuvolt `#375FA0`, no en verde. La regla rojo/verde solo significa
   algo donde ambos aparecen y se comparan, y en esa hoja no hay ni un número
   de CFE: todo es pago a Nuvolt. El azul no rompe la lectura, marca de quién
   es el producto. **No la «corrijas» a verde.**
2. **El bloque amarillo del seguro es único.** Es el único amarillo del
   documento y por eso funciona. No lo repitas en otro lado.
3. **Un campo que no se pudo calcular se queda en guion gris `—`, nunca en
   cero.** Un `$0` se lee como un dato real y es peor que un hueco visible.
4. **Archivo Medium en cifras, IBM Plex Mono en etiquetas.** Sin excepciones.
5. **Al crear rellenos ligados a variables, el color base del paint tiene que
   ser el valor de la variable, no negro.** Si el binding no resuelve —pasa—
   el nodo cae al color base y una cifra blanca sobre azul se vuelve negra
   sobre azul sin que nada marque error. Con el color base correcto, el peor
   caso es un nodo que se ve bien pero no sigue al token.

---

## 6. El flujo, de la foto al PDF

```
Foto por WhatsApp
   → OCR del recibo
   → extraer kwh_bimestre, tarifa, pago_bimestre, periodo
   → validar (sección 7)
   → calcular sistema, gasto, ahorro, precio
   → construir el JSON
   → dibujar sobre la plantilla
   → REVISIÓN HUMANA
   → enviar
```

### Sobre la revisión humana

**Recomiendo fuerte que el agente prepare y una persona apruebe con un clic,
no que salga solo.** Tres razones concretas:

- El OCR de una foto de recibo arrugado o a contraluz falla, y un dígito de
  más en el consumo desplaza todo el documento.
- El documento dice *"el precio no se mueve entre la firma y la puesta en
  marcha"*. Eso es un compromiso comercial, no una frase de relleno.
- La vigencia de 15 días naturales corre desde la fecha de emisión. Un folio
  mal fechado es un problema que aparece después.

Un botón de "revisar y enviar" en tu CRM con el PDF en preview resuelve las
tres y cuesta muy poco.

---

## 7. Validaciones mínimas antes de renderizar

Si alguna falla, el flujo se detiene y avisa en vez de mandar.

| Campo | Regla |
| --- | --- |
| `kwh_bimestre` | entero, entre 100 y 5000 para residencial |
| `tarifa` | una de `1D`, `DAC`, `PDBT`, `GDMTH` |
| `pago_bimestre` | > 0, y `pago / kwh` dentro de un rango plausible por tarifa |
| `sistema.kwp` | > 0 y coherente con `paneles × watt_panel / 1000` |
| `gasto.con_paneles.bimestre` | menor que `sin_paneles.bimestre` |
| `ahorro.payback_anios` | entre 1 y 10; fuera de eso, revisar a mano |
| `precio.total` | > 0 |
| Todas las mensualidades | presentes las 5, y decrecientes conforme sube el plazo |

La de `pago / kwh` es la que más OCR malo atrapa: si el consumo se leyó mal, la
relación se sale de rango de inmediato.

---

## 8. Qué queda pendiente

- **Garantías de paneles y microinversores.** Nunca aparecieron en la
  cotización anterior. No estorban en las dos hojas condensadas, pero si algún
  día usas el anexo hacen falta.
- **El cargo fijo de CFE con paneles.** Es el número de la columna verde y hoy
  no existe en ningún documento; hay que fijarlo por tarifa.
- **Reglas de precio.** Si no hay tabla cerrada de paquetes, ese campo tiene
  que quedar como entrada manual del asesor.

---

## 9. Referencias

- Diseño: archivo de Figma `0rDUmRnUWSDgfmXtVjALD4`, hojas `A1 arena` y
  `A2 arena`, más `Portada C` si la incluyes.
- Financiamiento: hoja `F arena — Financiamiento Nuvolt`, opcional. Va como
  anexo después de A2 y solo se manda cuando el cliente pide crédito; el pie
  dice «Anexo · Financiamiento» y no «Hoja X de Y» justamente para que no
  rompa la numeración de las dos hojas base. Es la única hoja en paleta
  Nuvolt, con masthead azul noche a sangre. Ejemplo lleno en
  `★ GE-2026-0042 · Financiamiento`.
- Financiamiento horizontal: hoja `FH arena`, carta apaisada (1056 × 816), para
  pantalla en vez de impresión. Comparte los mismos `campo.*` que la vertical,
  así que el mismo JSON llena cualquiera de las dos. Ojo con las coordenadas:
  si llenas por posición (Opción A), cada orientación necesita su propio
  `campos.json`. Ejemplo lleno en `★ GE-2026-0042 · Financiamiento (horizontal)`.
- Contacto que aparece en el pie: WhatsApp 985 202 4427 · Llamadas
  998 492 0709 · gamaenergiamx@gmail.com
- El código que llena el documento vive en `src/lib/quotes/`; el que prepara
  el template, en `scripts/build-quote-template.mjs`.
- El formulario público de captación de leads es otra cosa y vive en el repo de
  la landing (`gama-energia`, `api/cotizacion.ts`): manda un correo con Resend
  cuando alguien pide cotización desde la página. No genera este documento.
