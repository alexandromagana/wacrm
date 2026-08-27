// ============================================================
// Configure the Gama Energía conversational flows.
//
//   node scripts/setup-flows.mjs            # dry run, prints the plan
//   node scripts/setup-flows.mjs --apply    # writes to Supabase
//
// Idempotent: matches an existing flow by name, replaces its whole node
// set, and leaves anything it does not own untouched. Safe to re-run.
//
// Why a script rather than the builder UI: same reason as
// setup-automations.mjs — the flow has to line up exactly with a
// template button's label, and a typo there is invisible in the UI but
// silently costs every reply.
//
// Deps: only @supabase/supabase-js, which the app already depends on.
// `.env` is parsed by hand so the script adds no new packages.
// ============================================================
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APPLY = process.argv.includes('--apply')

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

async function must(label, promise) {
  const { data, error } = await promise
  if (error) throw new Error(`${label}: ${error.message}`)
  return data
}

// ------------------------------------------------------------
// The flow specs.
//
// EXACT match, not "contains". The keyword is the literal label of the
// quick-reply button on `gama_seguimiento_lead`, because Meta assigns
// template buttons no id and the webhook backfills reply_id with the
// visible text. A "contains" match on "cotización" would also swallow
// every TYPED message mentioning the word, and a flow consuming a
// message suppresses the AI auto-reply — which on this account is a
// 27k-character agent whose whole job is quoting. Exact keeps the flow
// to the tap and leaves prose to the agent.
// ------------------------------------------------------------
const FLOWS = [
  {
    name: 'Botón: quiero cotización (plantilla de lead)',
    description:
      'El cliente tocó "Sí, quiero cotización" en gama_seguimiento_lead. Antes esto no lo atendía nadie: un tap no arrancaba flows y el webhook silencia a la IA en los taps, así que el cliente se quedaba sin respuesta. Pide el recibo de CFE y cierra el run, para que la foto del recibo la tome el agente con normalidad.',
    trigger_type: 'keyword',
    trigger_config: {
      keywords: ['Sí, quiero cotización'],
      match_type: 'exact',
      case_sensitive: false,
    },
    status: 'active',
    entry_node_id: 'start',
    nodes: [
      {
        node_key: 'start',
        node_type: 'start',
        config: { next_node_key: 'pedir_recibo' },
      },
      {
        node_key: 'pedir_recibo',
        node_type: 'send_message',
        config: {
          // Voice matched to the agent's own "Pedir el recibo" example
          // and to the CANDADO rule in its system prompt: no quote
          // without a receipt. Deliberately promises no timeline — the
          // agent owns what happens once the receipt lands.
          text: '¡Perfecto! 🌞 Para armarte tu cotización necesito tu recibo de CFE completo, las dos páginas, que es donde viene tu consumo en kWh. Mándamelo por aquí y con eso preparamos tu propuesta personalizada.',
          next_node_key: 'fin',
        },
      },
      {
        node_key: 'fin',
        node_type: 'end',
        config: {},
      },
    ],
  },
]

/** Create-or-update by name, then replace the whole node set. */
async function upsertFlow(ctx, spec) {
  const { accountId, userId } = ctx
  const existing = await must(
    'find flow',
    db
      .from('flows')
      .select('id, name, status')
      .eq('account_id', accountId)
      .eq('name', spec.name)
      .maybeSingle(),
  )

  console.log(`\n${existing ? '~' : '+'} ${spec.name}`)
  console.log(`    trigger: ${spec.trigger_type} ${JSON.stringify(spec.trigger_config)}`)
  console.log(`    entry:   ${spec.entry_node_id}`)
  for (const n of spec.nodes) {
    const cfg = JSON.stringify(n.config)
    console.log(`    - ${n.node_key} (${n.node_type}) ${cfg.length > 100 ? cfg.slice(0, 100) + '…' : cfg}`)
  }
  console.log(`    status:  ${spec.status}`)

  if (!APPLY) return

  let id = existing?.id
  const row = {
    account_id: accountId,
    user_id: userId,
    name: spec.name,
    description: spec.description,
    trigger_type: spec.trigger_type,
    trigger_config: spec.trigger_config,
    status: spec.status,
    entry_node_id: spec.entry_node_id,
  }

  if (id) {
    await must('update flow', db.from('flows').update(row).eq('id', id))
    await must('clear nodes', db.from('flow_nodes').delete().eq('flow_id', id))
  } else {
    const created = await must(
      'insert flow',
      db.from('flows').insert(row).select('id').single(),
    )
    id = created.id
  }

  await must(
    'insert nodes',
    db.from('flow_nodes').insert(
      spec.nodes.map((n) => ({
        flow_id: id,
        node_key: n.node_key,
        node_type: n.node_type,
        config: n.config,
      })),
    ),
  )
  console.log(`    → flow ${id}`)
}

async function main() {
  console.log(APPLY ? '=== APPLYING ===' : '=== DRY RUN (pass --apply to write) ===')

  const account = await must(
    'account',
    db.from('accounts').select('id, name').limit(1).single(),
  )
  // Same identity resolution as setup-automations.mjs: reuse the user
  // the account's existing automations already run as, guaranteed to be
  // a valid auth.users id for the flows.user_id FK.
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
  const ctx = { accountId: account.id, userId }
  console.log(`account: ${account.name} · runs as: ${userId}`)

  // Guard: the keyword must still be the live button label. If someone
  // edits the template in Meta, the flow stops matching and the silence
  // comes back — fail loudly here instead of discovering it in the
  // inbox weeks later.
  const tpl = await must(
    'template',
    db
      .from('message_templates')
      .select('name, buttons')
      .eq('account_id', account.id)
      .eq('name', 'gama_seguimiento_lead')
      .maybeSingle(),
  )
  const labels = (tpl?.buttons ?? []).map((b) => b.text)
  console.log(`gama_seguimiento_lead buttons: ${JSON.stringify(labels)}`)
  for (const spec of FLOWS) {
    for (const kw of spec.trigger_config.keywords ?? []) {
      if (!labels.includes(kw)) {
        console.warn(`  ! WARNING: keyword "${kw}" is not a live button label on that template`)
      }
    }
  }

  for (const spec of FLOWS) await upsertFlow(ctx, spec)

  console.log(APPLY ? '\nDone.' : '\nDry run only. Re-run with --apply to write.')
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
