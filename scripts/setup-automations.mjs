// ============================================================
// Configure the Gama Energía follow-up automations.
//
//   node scripts/setup-automations.mjs            # dry run, prints the plan
//   node scripts/setup-automations.mjs --apply    # writes to Supabase
//
// Idempotent: matches existing automations by name, replaces their step
// tree, and leaves anything it does not own untouched. Safe to re-run.
//
// Why a script rather than the builder UI: this configures five linked
// automations whose steps reference tag ids that have to be looked up,
// and a half-finished pass through the UI would leave the live account
// in a state where some sequences fire and others do not.
//
// Deps: only @supabase/supabase-js, which the app already depends on.
// `.env` is parsed by hand so the script adds no new packages (running
// `npm install` here rewrites the lockfile in a way the container's npm
// rejects).
// ============================================================
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APPLY = process.argv.includes('--apply')

// ------------------------------------------------------------
// Env
// ------------------------------------------------------------
function loadEnv() {
  const out = {}
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

const env = loadEnv()
const url = env.NEXT_PUBLIC_SUPABASE_URL
const key = env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env')
  process.exit(1)
}
const db = createClient(url, key, { auth: { persistSession: false } })

// ------------------------------------------------------------
// Templates as approved in Meta. `variables` must match the body: a
// template with no {{n}} placeholder is rejected when parameters are
// sent, which is what silently broke the 48h follow-up.
// ------------------------------------------------------------
const TPL = {
  lead: { name: 'gama_seguimiento_lead', language: 'es_MX', variables: { 1: '{{contact.first_name|cliente}}' } },
  coti: { name: 'seguimiento_coti', language: 'es_MX', variables: {} },
  sinResp: { name: 'sin_respuesta', language: 'es_MX', variables: {} },
}

// Quick-reply button labels, which are what the interactive_reply
// trigger matches on (see the existing "Seguimiento" automations).
const BTN = {
  cotiGo: '¡Nada, vamos!',
  cotiDoubt: 'Tengo una duda',
  sinGo: '¡Vamos con todo!',
  sinLater: 'Sí, pero después',
  // Visit templates. "Necesito cambiarla" is on BOTH visita_recordatorio
  // and visita_confirmacion; one handler covers both, because the
  // trigger matches the label string, not the template it came from.
  visitOk: 'Sí, confirmado',
  visitHere: 'Ahí estaré',
  visitMove: 'Necesito cambiarla',
  postGo: 'Sí, avancemos',
  // recordatorio_recibo is DRAFT in Meta, so these two cannot be tapped
  // yet. The handlers are here so approval is the only remaining step.
  reciboYes: 'Sí, claro!',
  reciboLater: 'Contáctame más tarde.',
}

// ------------------------------------------------------------
// Lookups
// ------------------------------------------------------------
async function must(label, promise) {
  const { data, error } = await promise
  if (error) throw new Error(`${label}: ${error.message}`)
  return data
}

async function resolveTagIds(accountId, userId, names) {
  const existing = await must(
    'tags',
    db.from('tags').select('id, name').eq('account_id', accountId).in('name', names),
  )
  const byName = new Map(existing.map((t) => [t.name, t.id]))
  const missing = names.filter((n) => !byName.has(n))

  for (const name of missing) {
    if (!APPLY) {
      byName.set(name, `<new tag "${name}">`)
      continue
    }
    const created = await must(
      `create tag ${name}`,
      db
        .from('tags')
        .insert({ account_id: accountId, user_id: userId, name, color: '#64748b' })
        .select('id')
        .single(),
    )
    byName.set(name, created.id)
  }
  if (missing.length) console.log(`  tags created: ${missing.join(', ')}`)
  return byName
}

// ------------------------------------------------------------
// Step-tree writer (mirrors src/lib/automations/steps-tree.ts)
// ------------------------------------------------------------
function flatten(automationId, steps, parentId = null, branch = null, rows = []) {
  steps.forEach((s, idx) => {
    const id = crypto.randomUUID()
    rows.push({
      id,
      automation_id: automationId,
      parent_step_id: parentId,
      branch,
      step_type: s.step_type,
      step_config: s.step_config,
      position: idx,
    })
    if (s.branches?.yes) flatten(automationId, s.branches.yes, id, 'yes', rows)
    if (s.branches?.no) flatten(automationId, s.branches.no, id, 'no', rows)
  })
  return rows
}

/** Create-or-update by name, then replace the whole step tree. */
async function upsertAutomation(ctx, spec) {
  const { accountId, userId } = ctx
  const existing = await must(
    'find automation',
    db
      .from('automations')
      .select('id, name, is_active')
      .eq('account_id', accountId)
      .eq('name', spec.name)
      .maybeSingle(),
  )

  const verb = existing ? 'update' : 'create'
  console.log(`\n${verb === 'create' ? '+' : '~'} ${spec.name}`)
  console.log(`    trigger: ${spec.trigger_type} ${JSON.stringify(spec.trigger_config)}`)

  // An interactive_reply trigger matches the button's label character
  // for character. Meta assigns template quick-replies no id, so the
  // label IS the id — rename a button over there and this automation
  // stops firing with no error anywhere. Say so here instead.
  if (spec.trigger_type === 'interactive_reply') {
    for (const rid of spec.trigger_config.reply_ids ?? []) {
      if (!ctx.buttonLabels.has(rid)) {
        console.warn(`    ! WARNING: "${rid}" is not a live button label on any template`)
      }
    }
  }
  for (const s of spec.steps) describeStep(s, '    ')
  console.log(
    existing
      ? `    active: ${existing.is_active} (live value kept; spec says ${spec.is_active})`
      : `    active: ${spec.is_active}`,
  )

  if (!APPLY) return

  let id = existing?.id
  const row = {
    account_id: accountId,
    user_id: userId,
    name: spec.name,
    description: spec.description,
    trigger_type: spec.trigger_type,
    trigger_config: spec.trigger_config,
    is_active: spec.is_active,
  }

  if (id) {
    // `is_active` in a spec is the state to CREATE in, never a state to
    // force on re-run. "FB Pendiente WA → pedir recibo" ships inactive
    // here and was switched on from the Automations page after review;
    // a blind update would have quietly switched it back off. Whoever
    // holds the toggle in the UI keeps it.
    delete row.is_active
    await must('update automation', db.from('automations').update(row).eq('id', id))
    await must('clear steps', db.from('automation_steps').delete().eq('automation_id', id))
  } else {
    const created = await must(
      'insert automation',
      db.from('automations').insert(row).select('id').single(),
    )
    id = created.id
  }

  const rows = flatten(id, spec.steps)
  if (rows.length) await must('insert steps', db.from('automation_steps').insert(rows))
}

function describeStep(s, indent) {
  const cfg = JSON.stringify(s.step_config)
  console.log(`${indent}- ${s.step_type} ${cfg.length > 90 ? cfg.slice(0, 90) + '…' : cfg}`)
  for (const b of ['yes', 'no']) {
    for (const child of s.branches?.[b] ?? []) describeStep(child, `${indent}  ${b}: `)
  }
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(APPLY ? '=== APPLYING ===' : '=== DRY RUN (pass --apply to write) ===')

  const account = await must(
    'account',
    db.from('accounts').select('id, name').limit(1).single(),
  )
  // Audit owner for the rows we write. `profiles.role` is 'user' for
  // everyone here (owner/admin live in the account layer), so rather
  // than guess, reuse the identity the account's existing automations
  // already run as — guaranteed valid for both user_id and agent_id.
  const prior = await must(
    'existing automation',
    db
      .from('automations')
      .select('user_id')
      .eq('account_id', account.id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
  )
  const userId =
    prior?.user_id ??
    (await must(
      'fallback profile',
      db.from('profiles').select('user_id').eq('account_id', account.id).limit(1).single(),
    )).user_id
  // Every quick-reply label Meta currently has on this account, used to
  // sanity-check the interactive_reply triggers below.
  const templates = await must(
    'templates',
    db.from('message_templates').select('name, buttons').eq('account_id', account.id),
  )
  const buttonLabels = new Set()
  for (const t of templates ?? []) {
    for (const b of t.buttons ?? []) if (b?.text) buttonLabels.add(b.text)
  }

  const ctx = { accountId: account.id, userId, buttonLabels }
  console.log(`account: ${account.name} · runs as: ${userId}`)
  console.log(`live button labels: ${JSON.stringify([...buttonLabels])}`)

  const tags = await resolveTagIds(ctx.accountId, ctx.userId, [
    'Quote sent',
    'Hot lead',
    'Warm lead',
    'FB Pendiente WA',
  ])
  const quoteSent = tags.get('Quote sent')
  const hot = tags.get('Hot lead')
  const warm = tags.get('Warm lead')
  const fbPending = tags.get('FB Pendiente WA')

  // --- 1. Repair the 48h follow-up -------------------------------
  // Was pointing at "seguimiento_cotizacion", a template that does not
  // exist in Meta — every send failed silently. The real one is
  // "seguimiento_coti", and it carries no {{1}}, so no variables.
  await upsertAutomation(ctx, {
    name: 'Quote follow-up — 48h no reply',
    description:
      'Cotización enviada y sin respuesta en 48h (el tag "Quote sent" sigue puesto) → manda seguimiento_coti, que trae botones para que el cliente responda.',
    trigger_type: 'tag_added',
    trigger_config: { tag_id: quoteSent },
    is_active: true,
    steps: [
      { step_type: 'wait', step_config: { unit: 'hours', amount: 48 } },
      {
        step_type: 'condition',
        step_config: { subject: 'tag_presence', operand: quoteSent },
        branches: {
          yes: [{ step_type: 'send_template', step_config: { template_name: TPL.coti.name, language: TPL.coti.language, variables: TPL.coti.variables } }],
          no: [],
        },
      },
    ],
  })

  // --- 2. Second nudge, later ------------------------------------
  await upsertAutomation(ctx, {
    name: 'Quote follow-up — 5 días sin respuesta',
    description:
      'Segundo empujón con más urgencia (sin_respuesta) si a los 5 días el cliente sigue sin contestar. Se cancela solo en cuanto responde, porque "Clear follow-up tag on reply" le quita el tag.',
    trigger_type: 'tag_added',
    trigger_config: { tag_id: quoteSent },
    is_active: true,
    steps: [
      { step_type: 'wait', step_config: { unit: 'days', amount: 5 } },
      {
        step_type: 'condition',
        step_config: { subject: 'tag_presence', operand: quoteSent },
        branches: {
          yes: [{ step_type: 'send_template', step_config: { template_name: TPL.sinResp.name, language: TPL.sinResp.language, variables: TPL.sinResp.variables } }],
          no: [],
        },
      },
    ],
  })

  // --- 3..5. Button replies --------------------------------------
  // Replaces the two obsolete "Seguimiento" automations, which were
  // wired to a template that no longer exists. The live templates offer
  // three shades, not a yes/no: ready, has a question, postponing.
  await upsertAutomation(ctx, {
    name: 'Botón: cliente listo para avanzar',
    description:
      'Tocó "¡Nada, vamos!" o "¡Vamos con todo!" → cliente caliente. Quita el tag de seguimiento, lo marca Hot lead, confirma y asigna la conversación.',
    trigger_type: 'interactive_reply',
    trigger_config: { reply_ids: [BTN.cotiGo, BTN.sinGo] },
    is_active: true,
    steps: [
      { step_type: 'remove_tag', step_config: { tag_id: quoteSent } },
      { step_type: 'add_tag', step_config: { tag_id: hot } },
      {
        step_type: 'send_message',
        step_config: {
          text: '¡Excelente! 🙌 Alejandro te contacta enseguida para agendar tu visita técnica y dejar todo listo.',
        },
      },
      { step_type: 'assign_conversation', step_config: { mode: 'round_robin' } },
    ],
  })

  await upsertAutomation(ctx, {
    name: 'Botón: cliente tiene una duda',
    description:
      'Tocó "Tengo una duda" → no es un no, es una pregunta pendiente. Quita el tag de seguimiento y asigna la conversación a Alejandro para atención personal.',
    trigger_type: 'interactive_reply',
    trigger_config: { reply_ids: [BTN.cotiDoubt] },
    is_active: true,
    steps: [
      { step_type: 'remove_tag', step_config: { tag_id: quoteSent } },
      {
        step_type: 'send_message',
        step_config: {
          text: 'Claro que sí 🙂 Cuéntame qué duda tienes y te la resolvemos. Alejandro te atiende personalmente en un momento.',
        },
      },
      { step_type: 'assign_conversation', step_config: { mode: 'specific', agent_id: ctx.userId } },
    ],
  })

  await upsertAutomation(ctx, {
    name: 'Botón: cliente lo deja para después',
    description:
      'Tocó "Sí, pero después" → sigue interesado pero pospone. Quita el tag de seguimiento y lo marca Warm lead para retomarlo en campañas.',
    trigger_type: 'interactive_reply',
    trigger_config: { reply_ids: [BTN.sinLater] },
    is_active: true,
    steps: [
      { step_type: 'remove_tag', step_config: { tag_id: quoteSent } },
      { step_type: 'add_tag', step_config: { tag_id: warm } },
      {
        step_type: 'send_message',
        step_config: {
          text: 'Sin problema 🌞 Aquí seguimos cuando estés listo. Tu propuesta no cambia mientras tanto.',
        },
      },
    ],
  })

  // --- 6. Facebook leads that never wrote ------------------------
  // Left INACTIVE on purpose: this one initiates outbound contact with
  // real leads. Turn it on from the Automations page after review.
  await upsertAutomation(ctx, {
    name: 'FB Pendiente WA → pedir recibo',
    description:
      'Lead de Facebook que llenó el formulario pero no ha escrito por WhatsApp (tag "FB Pendiente WA" puesto por Make) → le manda gama_seguimiento_lead, que pide el recibo de luz para poder cotizar. INACTIVA hasta revisión: manda mensajes salientes a leads reales.',
    trigger_type: 'tag_added',
    trigger_config: { tag_id: fbPending },
    is_active: false,
    steps: [
      {
        step_type: 'send_template',
        step_config: { template_name: TPL.lead.name, language: TPL.lead.language, variables: TPL.lead.variables },
      },
    ],
  })

  // --- 7..11. The remaining orphan buttons -----------------------
  // Every template button whose label had no `interactive_reply`
  // handler. An unhandled tap is answered by nobody: the runner only
  // starts a flow on an exact keyword match, and the webhook mutes the
  // AI on taps outright, so the customer just gets silence.
  //
  // Deliberately NOT flows. A flow consuming a tap suppresses
  // `new_message_received`, and this account runs "Clear follow-up tag
  // on reply" and "FB Pendiente WA → quitar al responder" on exactly
  // that trigger — handling these as automations keeps their tag
  // clearing intact for free.
  //
  // "Tengo una duda" is absent on purpose: automation 4 already claims
  // that label, so it covers post_visita's copy of the button too.

  await upsertAutomation(ctx, {
    name: 'Botón: visita confirmada',
    description:
      'Tocó "Sí, confirmado" o "Ahí estaré" en los recordatorios de visita. Solo acusa recibo: la visita ya está agendada y no hay nada que Alejandro tenga que hacer, así que no reasigna ni mueve etiquetas.',
    trigger_type: 'interactive_reply',
    trigger_config: { reply_ids: [BTN.visitOk, BTN.visitHere] },
    is_active: true,
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: '¡Perfecto! 🙌 Tu visita queda confirmada. Si necesitas algo antes, escríbenos por aquí.',
        },
      },
    ],
  })

  await upsertAutomation(ctx, {
    name: 'Botón: reagendar visita',
    description:
      'Tocó "Necesito cambiarla" en cualquiera de los dos recordatorios de visita. Cambiar una fecha ya agendada es cosa de un humano, así que pide el nuevo horario y asigna a Alejandro.',
    trigger_type: 'interactive_reply',
    trigger_config: { reply_ids: [BTN.visitMove] },
    is_active: true,
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: 'Claro que sí 🙂 Dinos qué día y horario te acomodan mejor y la reagendamos. Alejandro te confirma la nueva fecha en un momento.',
        },
      },
      { step_type: 'assign_conversation', step_config: { mode: 'specific', agent_id: ctx.userId } },
    ],
  })

  await upsertAutomation(ctx, {
    name: 'Botón: post-visita, quiere avanzar',
    description:
      'Tocó "Sí, avancemos" después de la visita técnica. Es el lead más caliente que hay: ya vio el techo con un técnico. Mismo trato que "cliente listo para avanzar".',
    trigger_type: 'interactive_reply',
    trigger_config: { reply_ids: [BTN.postGo] },
    is_active: true,
    steps: [
      { step_type: 'remove_tag', step_config: { tag_id: quoteSent } },
      { step_type: 'add_tag', step_config: { tag_id: hot } },
      {
        step_type: 'send_message',
        step_config: {
          text: '¡Excelente noticia! 🙌 Alejandro te contacta enseguida para dejar todo listo y arrancar con tu instalación.',
        },
      },
      { step_type: 'assign_conversation', step_config: { mode: 'round_robin' } },
    ],
  })

  await upsertAutomation(ctx, {
    name: 'Botón: sí mando el recibo',
    description:
      'Tocó "Sí, claro!" en recordatorio_recibo. Solo acusa recibo y deja la conversación abierta: la foto que llegue después la lee el agente por visión, que es quien arma la cotización. Nota: la plantilla sigue en DRAFT en Meta, así que este botón no se puede tocar todavía.',
    trigger_type: 'interactive_reply',
    trigger_config: { reply_ids: [BTN.reciboYes] },
    is_active: true,
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: '¡Gracias! 🌞 Aquí quedo al pendiente de tu recibo de CFE, las dos páginas. En cuanto lo tenga preparamos tu propuesta.',
        },
      },
    ],
  })

  await upsertAutomation(ctx, {
    name: 'Botón: recibo para después',
    description:
      'Tocó "Contáctame más tarde." en recordatorio_recibo. Sigue interesado pero pospone, igual que "Sí, pero después": lo marca Warm lead para retomarlo en campañas. La plantilla sigue en DRAFT en Meta.',
    trigger_type: 'interactive_reply',
    trigger_config: { reply_ids: [BTN.reciboLater] },
    is_active: true,
    steps: [
      { step_type: 'add_tag', step_config: { tag_id: warm } },
      {
        step_type: 'send_message',
        step_config: {
          text: 'Sin problema 🌞 Aquí seguimos cuando estés listo. Cuando quieras retomarlo, mándanos tu recibo de CFE y te armamos tu propuesta.',
        },
      },
    ],
  })

  console.log(
    APPLY
      ? '\nDone. Review them at /automations.'
      : '\nNothing written. Re-run with --apply to write these.',
  )
}

main().catch((err) => {
  console.error('\nFailed:', err.message)
  process.exit(1)
})
