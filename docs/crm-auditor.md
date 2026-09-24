# Auditor operativo del CRM

Este repositorio incluye un recolector local, de solo lectura, para que Hermes revise el estado técnico del CRM y la calidad operativa de las conversaciones sin enviar mensajes ni modificar datos.

## Ejecutarlo

```bash
/usr/bin/env -i /usr/bin/sandbox-exec \
  -f scripts/gama-crm-auditor.sb \
  /usr/local/bin/node scripts/audit-crm.mjs
```

El comando lee únicamente las variables allowlisteadas del archivo de capacidad `.crm-audit.env`, que debe ser regular, no enlazado, propiedad del usuario, modo `0600`, de hasta 65,536 bytes y anclado a la raíz del proyecto. Consulta Supabase por REST y escribe un único JSON en `stdout`. Los errores van a `stderr`; las credenciales nunca forman parte del resultado ni de los mensajes de error. El sandbox bloquea lectura de los entornos privilegiados de la aplicación, Keychain y credenciales de Hermes, además de toda escritura a disco. El alias `npm run audit:crm` queda para desarrollo, pero la frontera endurecida y el cron fijan `sandbox-exec`, el perfil y Node por ruta absoluta con un entorno mínimo.

### Resolver referencias para el operador

Las alertas conservan sólo referencias opacas. Después de una petición directa del usuario, el operador puede abrir el activo correspondiente sin imprimir el UUID ni la URL:

```bash
/usr/bin/env -i /usr/local/bin/node scripts/resolve-crm-audit-ref.mjs conversation <conversation_ref>
/usr/bin/env -i /usr/local/bin/node scripts/resolve-crm-audit-ref.mjs automation <automation_ref>
/usr/bin/env -i /usr/local/bin/node scripts/resolve-crm-audit-ref.mjs flow <flow_ref>
```

El resolver valida una referencia HMAC-SHA-256 hexadecimal de 128 bits (32 caracteres), vuelve a aislar y validar cada fila por la cuenta fijada, rechaza duplicados o colisiones, exige una coincidencia única, carga configuración sólo desde la raíz anclada del proyecto, construye exclusivamente rutas HTTPS bajo `CRM_AUDIT_UI_ORIGIN` y llama `/usr/bin/open` sin shell, con entorno vacío y timeout. Su `stdout` devuelve únicamente `{opened, kind, reference}`. No forma parte del cron y no debe invocarse desde un snapshot, diff, alerta o subagente; requiere una solicitud directa del usuario.

Configuración dedicada del auditor; usar `.crm-audit.env.example` como inventario, no como mecanismo de provisión:

```bash
CRM_AUDIT_SUPABASE_URL=https://<project-ref>.supabase.co
CRM_AUDIT_API_KEY=                        # JWT anon del mismo proyecto; nunca service-role
CRM_AUDIT_ACCESS_TOKEN=                   # JWT role=gama_crm_auditor, ligado a una cuenta
CRM_AUDIT_ACCOUNT_ID=                     # UUID exacto de la única cuenta permitida
CRM_AUDIT_REFERENCE_KEY=                  # 32 bytes aleatorios en base64url
CRM_AUDIT_UI_ORIGIN=https://crm.example.com # Obligatorio sólo para resolver referencias
CRM_AUDIT_SUPABASE_ORIGIN=                # Cross-check HTTPS opcional; debe coincidir con la URL
CRM_AUDIT_HISTORY_DAYS=90
CRM_AUDIT_INCIDENT_LOOKBACK_DAYS=30
CRM_AUDIT_RESPONSE_SLA_MINUTES=30
CRM_AUDIT_STALE_SENT_MINUTES=120
CRM_AUDIT_PENDING_GRACE_MINUTES=15
```

La API key debe ser una JWT `anon`, y el bearer debe declarar exactamente `role: "gama_crm_auditor"`, el mismo `ref`, el `account_id` configurado y una expiración futura. El `ref` común fija el host a `https://<project-ref>.supabase.co`; se rechazan service-role, proyectos o cuentas distintos, tokens vencidos, claves opacas, redirects y cualquier origen distinto antes de enviar credenciales. El bearer dedicado es una capacidad temporal: debe rotarse antes de su `exp` sin copiar autoridad administrativa al archivo del auditor.

Las opciones temporales deben ser enteros decimales estrictos dentro de su dominio; sólo la ausencia usa defaults. Además deben conservar 30 minutos de solapamiento: historia ≥ lookback y SLA, y lookback ≥ umbral de entrega. Los límites de salida son constantes (`3/1/1/1`) y una variable que intente cambiarlos hace fallar la ejecución.

## Qué revisa

| Área             | Señal                                                                                                                            | Interpretación                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Atención         | Existe una intervención del cliente sin respuesta saliente confirmada, la conversación sigue abierta o pendiente y superó el SLA | Candidato a respuesta; `failed`, `sending` y `sent` no cuentan, y un handoff sólo se resuelve con respuesta humana confirmada y marcada como no generada por IA |
| Calidad          | Una interacción activa reciente con sender, estado, IA/handoff y señal local acotada                                             | Línea base de metadatos para decidir si hace falta revisión humana; no evalúa el texto ni afirma corrección semántica                                           |
| Entrega          | Mensaje saliente reciente cuyo estado actual sigue en `failed`                                                                   | Fallo observado incluso si la conversación ya se cerró; una entrega posterior no borra un fallo distinto                                                        |
| Entrega          | Mensaje saliente detenido en `sending` o `sent` después del umbral                                                               | Señal de conciliación incluso si la conversación ya se cerró; no prueba por sí sola que el cliente no lo recibió                                                |
| Automatizaciones | Log `failed`, `error_message`, o paso con estado `failed`                                                                        | Incidente agrupado por referencia opaca, código de error y tipo de paso permitido                                                                               |
| Automatizaciones | Ejecución `pending` cuyo `run_at` venció más allá de la tolerancia                                                               | Posible problema del cron o de la cola                                                                                                                          |
| Flows            | Run `failed`, o `active` después del timeout configurado                                                                         | Fallo o barrido de Flow ausente                                                                                                                                 |
| Webhooks         | Endpoint inactivo o con fallos consecutivos                                                                                      | Integración externa degradada                                                                                                                                   |
| WhatsApp         | Configuración ausente, distinta de `connected` o con error de registro                                                           | Incidente de conectividad/configuración; la ausencia se emite con estado `unknown`                                                                              |

Un log de automatización `partial` que sólo contiene un paso `wait` exitoso **no** se reporta como error: es el estado normal de una automatización estacionada hasta que el cron la reanuda.

## Privacidad y seguridad

- El cliente local (recolector y resolver) sólo ejecuta solicitudes HTTP `GET` contra una allowlist total de once vistas con prefijo `crm_audit_`, siempre con `Accept-Profile: crm_audit_api`; no consulta tablas base ni acepta rutas construidas por el snapshot.
- El rol efectivo `gama_crm_auditor` es `NOLOGIN`, `NOINHERIT`, sin superusuario, creación de roles/bases, replicación o bypass de RLS. No recibe grants directos de escritura sobre tablas ni grants sobre secuencias; recibe `SELECT` sólo sobre las once vistas del esquema dedicado y `EXECUTE` directo sólo sobre tres helpers acotados. Como todo rol PostgreSQL, hereda los `EXECUTE` ambientales que `PUBLIC` aún conserve en `public`; esa autoridad no es alcanzable por el bearer porque el hook rechaza antes de despachar cualquier perfil distinto de `crm_audit_api`, donde no existen esas funciones.
- Las vistas usan barrera de seguridad y fijan toda lectura al `account_id` del JWT firmado. La función privada exige el rol dedicado, un método `GET`/`HEAD`, claims canónicos y el mismo UUID; el cliente vuelve a validar el tenant en cada fila como defensa en profundidad.
- Un hook global `pgrst.db_pre_request` exige el perfil exacto `crm_audit_api` y niega cualquier método distinto de `GET`/`HEAD` cuando el rol efectivo es `gama_crm_auditor`. Las lecturas se ejecutan en una transacción `read only`; una RPC de prueba no mutante permite verificarlo por GET. Los grants negativos se verifican por catálogo, sin intentar una mutación real del CRM.
- El origen se valida antes de usar las credenciales, debe ser el HTTPS derivado de ambas JWT y los redirects se rechazan. Las páginas usan cursor por `id`, orden estable, timeout que cubre headers y cuerpo, UTF-8 estricto y límites acumulados de filas, páginas y bytes; cada respuesta exige un `Content-Range` consistente. Un fallo cancela las lecturas hermanas y aborta todo el snapshot.
- Mensajes y logs se limitan a una ventana histórica (90 días por defecto); los incidentes históricos de mensajes, automatizaciones y Flows se limitan a 30 días por defecto.
- El proceso del auditor no recibe ni puede leer `SUPABASE_SERVICE_ROLE_KEY`. El archivo dedicado contiene sólo la API key pública, el bearer reducido, el tenant, la clave HMAC y opciones allowlisteadas; cualquier clave desconocida o duplicada hace fallar la carga.
- El esquema v2 es estructurado únicamente: nunca exporta `content_text`, `status_error`, `error_message`, `end_reason`, `ai_handoff_summary`, nombres de contactos, nombres de automatizaciones/Flows ni errores de registro. Esos valores se inspeccionan localmente sólo para producir enums cerrados, booleanos y códigos.
- No consulta columnas de teléfono o correo ni incluye nombres, identificadores crudos, texto libre o enlaces de conversación. Cada conversación, mensaje, automatización, Flow, webhook y configuración de WhatsApp usa una referencia HMAC-SHA-256 truncada a 128 bits, con detección fail-closed de colisiones. La clave se acepta únicamente como base64url canónico sin padding que decodifique a exactamente 32 bytes; sólo el resolver local y aprobado maneja el UUID en memoria para abrir la ruta sin imprimirlo.
- `privacy.pii_redaction: structured_only`, `customer_message_text_included: false` y `untrusted_free_text_included: false` son parte obligatoria del contrato que valida el wrapper.
- El generador valida antes de clasificar: todas las colecciones deben ser arreglos, cada fila debe tener un identificador válido y único, cada mensaje debe resolver a una conversación y cada ejecución de Flow a su Flow y conversación cuando exista, estados y booleanos deben pertenecer al contrato cerrado, y los campos libres consultados sólo pueden ser texto o `null`. Un valor malformado invalida la cobertura sin copiarlo a la salida.
- Todos los timestamps emitidos usan exactamente UTC ISO con milisegundos (`YYYY-MM-DDTHH:mm:ss.sssZ`), pero la clasificación, los umbrales y el orden conservan hasta nanosegundos de la fuente. Un timestamp fuente requerido ausente, futuro, con otro formato, con calendario imposible, cuya normalización UTC salga del rango de años de cuatro dígitos, una opción temporal no entera o inválida o un miembro JSON duplicado invalida el snapshot completo. `run_at` sí puede ser futuro porque representa trabajo programado.
- Un timeout de Flow ausente, cuyo tipo JSON no sea un entero —incluidas cadenas numéricas y fracciones—, infinito, no positivo o superior a 8,760 horas usa el fallback local de 24 horas; así un desbordamiento o coerción no puede suprimir un Flow atascado.
- Los desempates usan comparación binaria estable en lugar de la configuración regional del sistema; identificadores ausentes, duplicados, con caracteres de control o con sustitutos UTF-16 aislados fallan antes de construir referencias o claves de incidente.
- Las listas visibles se acotan a tres esperas, una interacción reciente, un mensaje de contexto y un incidente por subcategoría técnica. Esos topes `3/1/1/1` son parte fija del esquema v2, no opciones ajustables del productor; cualquier valor distinto falla antes de generar un snapshot. `omitted` indica cuántos candidatos quedaron fuera; los más antiguos o de mayor severidad se priorizan según el tipo de señal.
- Los límites duros y la ausencia de texto libre mantienen incluso el snapshot adversarial cubierto por tests debajo de 7,000 bytes. El wrapper vuelve a validar el esquema exacto y falla con cobertura desconocida si el JSON compacto supera 7,600 bytes, por debajo del límite de 8,000 caracteres que Hermes inyecta al agente.
- El resultado no contiene una hora de generación y usa rangos de antigüedad. Así, el `monitor` de Hermes no despierta al agente en cada ejecución si nada cambió.
- El cron no conserva continuidad textual entre ejecuciones: usa únicamente el diff `previous → current` del monitor para no arrastrar snapshots ni texto no confiable a ejecuciones futuras.
- El auditor no debe tener permiso para enviar WhatsApp, cambiar contactos, asignar conversaciones, hacer commits, `push`, merge o deploy.

### Comprobaciones de despliegue

Antes de habilitar el job se exige, sin imprimir secretos ni UUIDs:

1. comprobar propietario, archivo regular, ausencia de symlink y modo `0600` de `.crm-audit.env`;
2. validar que el token efectivo tenga rol `gama_crm_auditor`, una única cuenta y el mismo proyecto que la API key;
3. leer por catálogo que el rol no tiene grants de escritura ni grants directos a funciones mutadoras, e inventariar explícitamente cualquier `EXECUTE` ambiental heredado desde `PUBLIC`;
4. confirmar por REST que el perfil `public` queda bloqueado con SQLSTATE `42501`, el rol dedicado ve exactamente su cuenta dentro de `crm_audit_api`, el GET de prueba corre `read only` y un POST no mutante queda bloqueado con SQLSTATE `25006`;
5. ejecutar dos snapshots bajo el sandbox y exigir esquema, privacidad, cobertura y bytes válidos, además de igualdad determinista cuando la fuente no cambió;
6. verificar que el wrapper instalado sea byte a byte idéntico al versionado antes de habilitar el cron.

## Separación de decisiones

1. **Recolector determinista:** encuentra señales, clasifica texto localmente y emite sólo datos estructurados.
2. **Agente auditor:** prioriza con metadatos y códigos; cuando el contenido no está disponible, recomienda revisión humana sin inventar semántica.
3. **Delegación técnica:** otro agente puede inspeccionar el repositorio en modo de sólo lectura y proponer causa, prueba de regresión y arreglo.
4. **Aprobación humana:** cualquier respuesta al cliente, modificación de producción o parche de código requiere autorización explícita.

No se debe delegar un error de Meta como si fuera automáticamente un bug de software. Primero se clasifica como proveedor/política, configuración, datos, operación humana o código reproducible.

## Formato de salida

Campos principales:

- `customer_review.awaiting_response`: hasta tres candidatos priorizados que superaron el SLA, con referencia opaca y un `customer_signal` cerrado. Normalmente sólo admite `commercial_request`, `frustration`, `media`, `other` o `question`; un handoff de IA aún no resuelto también conserva `closure`, `do_not_contact` o `empty` para que no desaparezca antes de una respuesta humana confirmada. `do_not_contact` exige revisión interna y nunca autoriza insistencia comercial.
- `customer_review.recent_interactions`: una conversación reciente no duplicada en la lista anterior, sólo con metadatos estructurados.
- `technical.failed_messages`
- `technical.stale_sent_messages`
- `technical.automation_failures`
- `technical.overdue_automation_executions`
- `technical.flow_incidents`
- `technical.webhook_incidents`
- `technical.whatsapp_incidents`
- `omitted`: total no incluido por cada límite de salida; cada subcategoría técnica conserva el incidente de mayor prioridad.

Cada incidente tiene un `incident_key` estable que no incorpora el rango de antigüedad. Los cambios de rango (`30m-2h`, `2h-24h`, `1d-7d`, `7d+`) pueden escalar una alerta sin cambiar la identidad del incidente.

## Job de Hermes

- Se ejecuta cada 30 minutos, con continuidad textual desactivada y adjunto a la sesión.
- Tiene `enabled_toolsets: [clarify]`; Hermes deshabilita `clarify` en cron, por lo que la ejecución programada no dispone de herramientas operativas.
- El LLM recibe sólo el JSON v2 validado y el diff del monitor; no abre el repositorio, archivos de entorno ni la base.
- Una falla de recolección/esquema o un aumento de cualquier `omitted` es una alerta de cobertura y nunca puede quedar bajo `[SILENT]`.
- El job no delega, responde clientes ni cambia conversaciones, automatizaciones, Flows, webhooks, Meta, código o infraestructura.
- La configuración y el prompt completos están versionados en `docs/crm-auditor-cron-spec.json`. El monitor usa hash SHA-256 de los bytes exactos: una salida idéntica omite por completo la ejecución del agente; una salida distinta inyecta un diff acotado; una falla alerta sin actualizar el hash; y `[SILENT]` suprime la entrega. El hash nuevo sólo se confirma después de que la alerta cruce su frontera de entrega; una respuesta `[SILENT]`, un fallo del agente o una entrega fallida conserva el hash anterior para reintentar el mismo cambio. Si Bot Chat admite la alerta en cola, Hermes guarda un snapshot atómico por hash junto con el recibo, suprime turnos duplicados mientras está pendiente y confirma el hash únicamente cuando el recibo queda `settled`.
- La activación es fail-closed: el job permanece pausado durante las tres revisiones independientes; después se ejecuta el E2E final sobre el mismo bundle aprobado y sólo entonces se reanuda. Cualquier cambio, revisión inválida o E2E fallido conserva el estado pausado.

## Pruebas

```bash
npx vitest run src/lib/audit/*.test.ts
/usr/bin/python3 -I -B -m unittest discover -s scripts -p 'test_gama_crm_audit_monitor*.py'
npm run typecheck
```

Los tests versionados cargan el wrapper adyacente, no la copia instalada, e incluyen un contrato diferencial offline productor JS → validador Python. Cubren ausencia de texto libre, clasificación estructurada e inflexiones en español, esquema v2 estricto, formas de colección, IDs y relaciones, estados y booleanos, fechas futuras, opciones temporales, cuenta única, minimización de columnas, origen HTTPS fijado, paginación, límites y cancelación, SLA, handoff humano confirmado, entrega, automatizaciones, Flows, webhooks, WhatsApp, HMAC y estabilidad ante permutaciones y Unicode. La identidad SHA-256 entre candidato e instalación se verifica por separado al desplegar el wrapper.
