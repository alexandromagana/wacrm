import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

// Who can EXECUTE each SECURITY DEFINER function in `public` once every
// migration has run. PostgREST serves any function a role can execute
// at /rest/v1/rpc/<name>, and a SECURITY DEFINER one runs as postgres,
// past RLS, so for these the grants are the access control.
//
// The migrations are replayed in order rather than read one at a time:
// Postgres gives a new function to PUBLIC and Supabase's default
// privileges add anon, authenticated and service_role by name, so a
// migration that revokes from PUBLIC alone still leaves anon able to
// call the function. That is how 018, 019, 022 and 036 left theirs open
// until 053.

const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations')

const ROLES = ['public', 'anon', 'authenticated', 'service_role'] as const
type Role = (typeof ROLES)[number]

// Every SECURITY DEFINER function in public must be closed to these
// roles unless it is listed here.
const OPEN_TO: Record<Exclude<Role, 'service_role'>, string[]> = {
  // RLS policies evaluate it as whichever role runs the query.
  public: ['is_account_member'],
  // ...and the /join page calls this before the visitor signs in.
  anon: ['is_account_member', 'peek_invitation'],
  // ...and the app sends these with a signed-in user's session.
  authenticated: [
    'is_account_member',
    'peek_invitation',
    'redeem_invitation',
    'remove_account_member',
    'set_member_role',
    'touch_presence',
    'transfer_account_ownership',
  ],
}

// The RPCs the server sends with the service-role client.
const SERVICE_ROLE_CALLED = [
  'claim_ai_reply_slot',
  'increment_automation_execution_count',
  'increment_flow_execution_count',
  'record_webhook_failure',
]

type Fn = {
  definer: boolean
  grants: Set<Role>
}

// Splits a migration into lower-cased statements with comments dropped
// and quoted text blanked out, so a `security definer` or a GRANT inside
// a function body, a string or a comment never reads as its own.
function splitStatements(sql: string): string[] {
  const dollarQuote = /\$[A-Za-z_]*\$/y
  const statements: string[] = []
  let current = ''
  let i = 0

  const push = () => {
    const statement = current.replace(/\s+/g, ' ').trim().toLowerCase()
    if (statement) statements.push(statement)
    current = ''
  }

  while (i < sql.length) {
    const char = sql[i]
    dollarQuote.lastIndex = i
    const tag = char === '$' ? dollarQuote.exec(sql)?.[0] : undefined

    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
    } else if (tag) {
      const end = sql.indexOf(tag, i + tag.length)
      i = end === -1 ? sql.length : end + tag.length
      current += ' $$ '
    } else if (char === "'" || char === '"') {
      // A doubled quote inside reads as one literal ending and the next
      // starting, which blanks (or keeps) the same text either way.
      const end = sql.indexOf(char, i + 1)
      const next = end === -1 ? sql.length : end + 1
      current += char === '"' ? sql.slice(i, next) : " '' "
      i = next
    } else if (char === ';') {
      push()
      i++
    } else {
      current += char
      i++
    }
  }
  push()
  return statements
}

// `public.name` or a bare `name` gives 'name'; any other schema, null.
function publicName(ref: string): string | null {
  const match = /^(?:public\.)?([a-z_][a-z0-9_]*)$/.exec(ref.trim())
  return match ? match[1] : null
}

// `public.a(uuid, integer), b()` gives ['a', 'b']. Keyed by name alone:
// no function in public is overloaded.
function functionNames(list: string): string[] {
  let bare = list
  while (/\([^()]*\)/.test(bare)) bare = bare.replace(/\([^()]*\)/g, '')
  return bare
    .replace(/ (?:cascade|restrict)$/, '')
    .split(',')
    .map(publicName)
    .filter((name): name is string => name !== null)
}

function roleList(list: string): Role[] {
  return list
    .replace(/ (?:with grant option|cascade|restrict)$/, '')
    .split(',')
    .map((role) => role.trim())
    .filter((role): role is Role => (ROLES as readonly string[]).includes(role))
}

function apply(fns: Map<string, Fn>, statement: string) {
  const create = /^create (?:or replace )?function ([\w.]+) ?\(/.exec(statement)
  if (create) {
    const name = publicName(create[1])
    if (!name) return
    // CREATE OR REPLACE keeps the grants of a function that exists.
    fns.set(name, {
      definer: / security definer\b/.test(statement),
      grants: fns.get(name)?.grants ?? new Set(ROLES),
    })
    return
  }

  const alter = /^alter function ([\w.]+).* security (definer|invoker)\b/.exec(
    statement,
  )
  if (alter) {
    const fn = fns.get(publicName(alter[1]) ?? '')
    if (fn) fn.definer = alter[2] === 'definer'
    return
  }

  const drop = /^drop function (?:if exists )?(.+)$/.exec(statement)
  if (drop) {
    for (const name of functionNames(drop[1])) fns.delete(name)
    return
  }

  const privilege =
    /^(grant|revoke) (?:all(?: privileges)?|execute) on (all functions in schema|functions?|routines?) (.+?) (?:to|from) (.+)$/.exec(
      statement,
    )
  if (!privilege) return
  const [, action, target, objects, roles] = privilege
  const names =
    target !== 'all functions in schema'
      ? functionNames(objects)
      : objects.split(',').some((schema) => schema.trim() === 'public')
        ? [...fns.keys()]
        : []
  for (const name of names) {
    const fn = fns.get(name)
    if (!fn) continue
    for (const role of roleList(roles)) {
      if (action === 'grant') fn.grants.add(role)
      else fn.grants.delete(role)
    }
  }
}

function replayMigrations(): Map<string, Fn> {
  const fns = new Map<string, Fn>()
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    for (const statement of splitStatements(sql)) apply(fns, statement)
  }
  return fns
}

describe('SECURITY DEFINER functions in public', () => {
  const fns = replayMigrations()
  const definers = [...fns].filter(([, fn]) => fn.definer)
  const callableBy = (role: Role) =>
    definers
      .filter(([, fn]) => fn.grants.has(role))
      .map(([name]) => name)
      .sort()

  it('include every function the app calls', () => {
    // Guards the replay itself: finding nothing would pass every check
    // below.
    const names = definers.map(([name]) => name)
    for (const name of [...OPEN_TO.authenticated, ...SERVICE_ROLE_CALLED]) {
      expect(names).toContain(name)
    }
  })

  for (const role of ['public', 'anon', 'authenticated'] as const) {
    it(`are open to ${role} only where the app needs it`, () => {
      expect(callableBy(role)).toEqual([...OPEN_TO[role]].sort())
    })
  }

  it('stay open to the service role where the server calls them', () => {
    for (const name of SERVICE_ROLE_CALLED) {
      expect(fns.get(name)?.grants.has('service_role'), name).toBe(true)
    }
  })
})

describe('053_rpc_execute_grants.sql', () => {
  it('grants and revokes one function in public at a time', () => {
    // PostgREST's pre-request hook (crm_audit_private, migration 051)
    // runs on every API request and relies on explicit grants to anon
    // and authenticated. A schema-wide revoke or a default-privilege
    // change here could take it, and every REST call, down with it.
    const sql = fs.readFileSync(
      path.join(migrationsDir, '053_rpc_execute_grants.sql'),
      'utf8',
    )
    const statements = splitStatements(sql)

    expect(statements.length).toBeGreaterThan(0)
    for (const statement of statements) {
      expect(statement).toMatch(
        /^(?:grant execute|revoke all) on function public\.\w+\([^)]*\) (?:to|from) [\w, ]+$/,
      )
    }
  })
})
