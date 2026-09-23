# Dónde viven los archivos

Todo archivo que entra o sale por WhatsApp tiene una copia en Supabase Storage.
Meta no sirve de archivo: borra lo que mandan los clientes a los 7 días.

| Qué | Bucket | Acceso | Lo escribe |
| --- | --- | --- | --- |
| Lo que manda el cliente: recibos, fotos, PDFs, audios, videos | `inbound-media` | Privado | El webhook, al recibirlo |
| Lo que manda un agente desde el inbox | `chat-media` | Público | El composer |
| La propuesta PDF que manda el bot | `chat-media` | Público | `sendQuoteProposal` |
| Cotizaciones del Cotizador y el recibo con el que se hicieron | `quote-assets` | Público | `/api/quotes/generate` |
| Archivos de los Flows | `flow-media` | Público | El editor de Flows |

Los públicos lo son porque Meta descarga por URL lo que mandamos. `inbound-media`
no tiene esa necesidad y guarda recibos de CFE (nombre, dirección, número de
servicio), así que solo lo leen los miembros de la cuenta.

Público quiere decir que un link conocido abre, no que se pueda listar. La
política `SELECT` de cada bucket es solo para miembros y su carpeta
`account-<id>` (migración 050); una política `SELECT` que revise únicamente el
`bucket_id` deja que cualquiera con la llave pública enumere cotizaciones y
recibos.

## Archivos de clientes (`inbound-media`)

Ruta: `account-<account_id>/<media_id de Meta>`. El mensaje sigue guardando
`media_url = /api/whatsapp/media/<media_id>`, igual que antes; el proxy de esa
ruta sirve primero nuestra copia y solo va a Meta si no existe.

Tres cosas mantienen las copias al día, en `src/lib/storage/inbound-media.ts`:

1. **El webhook** copia cada archivo en cuanto llega.
2. **El proxy** guarda lo que tenga que traer de Meta, si la copia del webhook
   falló. Eso solo funciona dentro de los 7 días.
3. **`scripts/backfill-inbound-media.ts`** barre lo que falte:

   ```bash
   npx tsx scripts/backfill-inbound-media.ts          # solo revisa, no escribe
   npx tsx scripts/backfill-inbound-media.ts --apply  # copia lo recuperable
   ```

   Sirve también de chequeo: si en modo revisión no encuentra nada pendiente,
   el webhook va al día. Lista los archivos que Meta ya borró, para pedírselos
   de nuevo al cliente.

Lo que llegó antes de la migración 049 y tiene más de 7 días ya no existe en
Meta. De esos recibos queda lo que el bot leyó en `ai_receipt_readings`
(solo admins), que es con lo que se armó la propuesta.
