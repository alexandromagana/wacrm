-- ============================================================
-- 051_crm_auditor_readonly.sql
--
-- A dedicated PostgREST role and security-barrier views for the local
-- CRM auditor. The role has no login, no inherited privileges, no RLS
-- bypass, no direct table access and a read-only transaction default.
-- Every view is additionally bound to the account_id in the signed JWT.
-- No account identifier or credential is stored in this migration.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'gama_crm_auditor'
  ) THEN
    CREATE ROLE gama_crm_auditor
      NOLOGIN
      NOINHERIT;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'gama_crm_auditor'
      AND (
        rolsuper
        OR rolinherit
        OR rolcreaterole
        OR rolcreatedb
        OR rolcanlogin
        OR rolreplication
        OR rolbypassrls
      )
  ) THEN
    RAISE EXCEPTION 'gama_crm_auditor has unsafe role attributes';
  END IF;
END
$$;

ALTER ROLE gama_crm_auditor SET default_transaction_read_only = on;
ALTER ROLE gama_crm_auditor SET statement_timeout = '60s';
ALTER ROLE gama_crm_auditor SET lock_timeout = '1s';
ALTER ROLE gama_crm_auditor SET idle_in_transaction_session_timeout = '60s';

-- PostgREST connects as authenticator and may assume only explicitly granted
-- JWT roles. This membership grants impersonation, not data privileges.
GRANT gama_crm_auditor TO authenticator;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM gama_crm_auditor;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM gama_crm_auditor;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM gama_crm_auditor;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM gama_crm_auditor;

CREATE SCHEMA IF NOT EXISTS crm_audit_api AUTHORIZATION postgres;
ALTER SCHEMA crm_audit_api OWNER TO postgres;
REVOKE ALL PRIVILEGES ON SCHEMA crm_audit_api
  FROM PUBLIC, anon, authenticated, service_role, gama_crm_auditor;
GRANT USAGE ON SCHEMA crm_audit_api TO gama_crm_auditor;

CREATE SCHEMA IF NOT EXISTS crm_audit_private AUTHORIZATION postgres;
ALTER SCHEMA crm_audit_private OWNER TO postgres;
REVOKE ALL PRIVILEGES ON SCHEMA crm_audit_private
  FROM PUBLIC, anon, authenticated, service_role, gama_crm_auditor;
GRANT USAGE ON SCHEMA crm_audit_private
  TO anon, authenticated, service_role, gama_crm_auditor;

CREATE OR REPLACE FUNCTION crm_audit_private.request_account_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  claims jsonb;
  account_text text;
BEGIN
  IF current_user <> 'gama_crm_auditor' THEN
    RAISE EXCEPTION 'CRM audit role required' USING ERRCODE = '42501';
  END IF;

  IF current_setting('request.method', true) NOT IN ('GET', 'HEAD') THEN
    RAISE EXCEPTION 'CRM audit requests are read-only' USING ERRCODE = '25006';
  END IF;

  BEGIN
    claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid CRM audit claims' USING ERRCODE = '42501';
  END;

  account_text := claims ->> 'account_id';
  IF jsonb_typeof(claims) <> 'object'
     OR claims ->> 'role' <> 'gama_crm_auditor'
     OR account_text IS NULL
     OR account_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (account_text::uuid)::text <> account_text THEN
    RAISE EXCEPTION 'Invalid CRM audit claims' USING ERRCODE = '42501';
  END IF;

  RETURN account_text::uuid;
END;
$$;

ALTER FUNCTION crm_audit_private.request_account_id() OWNER TO postgres;
REVOKE ALL PRIVILEGES ON FUNCTION crm_audit_private.request_account_id()
  FROM PUBLIC, anon, authenticated, service_role, gama_crm_auditor;
GRANT EXECUTE ON FUNCTION crm_audit_private.request_account_id()
  TO gama_crm_auditor;

CREATE OR REPLACE FUNCTION crm_audit_private.enforce_http_read_only()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  request_headers jsonb;
BEGIN
  IF current_user = 'gama_crm_auditor' THEN
    IF COALESCE(current_setting('request.method', true), '') NOT IN ('GET', 'HEAD') THEN
      RAISE EXCEPTION 'CRM audit requests are read-only' USING ERRCODE = '25006';
    END IF;

    BEGIN
      request_headers := COALESCE(
        NULLIF(current_setting('request.headers', true), ''),
        '{}'
      )::jsonb;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Invalid CRM audit request headers' USING ERRCODE = '42501';
    END;

    IF jsonb_typeof(request_headers) <> 'object'
       OR request_headers ->> 'accept-profile' IS DISTINCT FROM 'crm_audit_api' THEN
      RAISE EXCEPTION 'CRM audit schema profile required' USING ERRCODE = '42501';
    END IF;
  END IF;
END
$function$;

ALTER FUNCTION crm_audit_private.enforce_http_read_only() OWNER TO postgres;
REVOKE ALL PRIVILEGES ON FUNCTION crm_audit_private.enforce_http_read_only()
  FROM PUBLIC, anon, authenticated, service_role, gama_crm_auditor;
GRANT EXECUTE ON FUNCTION crm_audit_private.enforce_http_read_only()
  TO anon, authenticated, service_role, gama_crm_auditor;

DO $config$
DECLARE
  existing_pre_request text;
  existing_db_schemas text;
BEGIN
  SELECT split_part(setting, '=', 2)
  INTO existing_pre_request
  FROM pg_catalog.pg_roles AS role,
       unnest(COALESCE(role.rolconfig, ARRAY[]::text[])) AS setting
  WHERE role.rolname = 'authenticator'
    AND setting LIKE 'pgrst.db_pre_request=%';

  IF existing_pre_request IS NOT NULL
     AND existing_pre_request <> 'crm_audit_private.enforce_http_read_only' THEN
    RAISE EXCEPTION 'An unrelated PostgREST pre-request hook is already configured';
  END IF;

  ALTER ROLE authenticator
    SET pgrst.db_pre_request = 'crm_audit_private.enforce_http_read_only';

  SELECT split_part(setting, '=', 2)
  INTO existing_db_schemas
  FROM pg_catalog.pg_roles AS role,
       unnest(COALESCE(role.rolconfig, ARRAY[]::text[])) AS setting
  WHERE role.rolname = 'authenticator'
    AND setting LIKE 'pgrst.db_schemas=%';

  IF existing_db_schemas IS NOT NULL
     AND existing_db_schemas <> 'public, graphql_public, crm_audit_api' THEN
    RAISE EXCEPTION 'An unrelated PostgREST schema list is already configured';
  END IF;

  ALTER ROLE authenticator
    SET pgrst.db_schemas = 'public, graphql_public, crm_audit_api';
END
$config$;

-- This VOLATILE function is intentionally non-mutating. Calling it with GET
-- verifies PostgREST's read-only transaction for read requests; the pre-request
-- guard above rejects POST and every other non-read method for the audit role.
CREATE OR REPLACE FUNCTION crm_audit_api.crm_audit_verify_transaction_read_only()
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT current_setting('transaction_read_only') = 'on'
$function$;

ALTER FUNCTION crm_audit_api.crm_audit_verify_transaction_read_only() OWNER TO postgres;
REVOKE ALL PRIVILEGES ON FUNCTION crm_audit_api.crm_audit_verify_transaction_read_only()
  FROM PUBLIC, anon, authenticated, service_role, gama_crm_auditor;
GRANT EXECUTE ON FUNCTION crm_audit_api.crm_audit_verify_transaction_read_only()
  TO gama_crm_auditor;

-- Return only boolean authority invariants so operators can verify the live
-- catalog without exposing role memberships, object names, account IDs, or
-- any other catalog identifiers to the audit principal.
CREATE OR REPLACE FUNCTION crm_audit_api.crm_audit_authority_contract()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT jsonb_build_object(
    'no_role_memberships',
      NOT EXISTS (
        SELECT 1
        FROM pg_auth_members AS membership
        JOIN pg_roles AS member_role
          ON member_role.oid = membership.member
        WHERE member_role.rolname = 'gama_crm_auditor'
      ),
    'no_direct_table_writes',
      NOT EXISTS (
        SELECT 1
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND (
            has_table_privilege('gama_crm_auditor', relation.oid, 'INSERT')
            OR has_table_privilege('gama_crm_auditor', relation.oid, 'UPDATE')
            OR has_table_privilege('gama_crm_auditor', relation.oid, 'DELETE')
            OR has_table_privilege('gama_crm_auditor', relation.oid, 'TRUNCATE')
            OR has_table_privilege('gama_crm_auditor', relation.oid, 'REFERENCES')
            OR has_table_privilege('gama_crm_auditor', relation.oid, 'TRIGGER')
          )
      ),
    'public_schema_usage_present',
      has_schema_privilege('gama_crm_auditor', 'public', 'USAGE'),
    'public_function_execute_count',
      (
        SELECT count(*)
        FROM pg_proc AS routine
        JOIN pg_namespace AS namespace
          ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = 'public'
          AND has_function_privilege(
            'gama_crm_auditor',
            routine.oid,
            'EXECUTE'
          )
      ),
    'pre_request_guard_configured',
      COALESCE(
        (
          SELECT role.rolconfig @> ARRAY[
            'pgrst.db_pre_request=crm_audit_private.enforce_http_read_only'
          ]::text[]
          FROM pg_roles AS role
          WHERE role.rolname = 'authenticator'
        ),
        false
      ),
    'transaction_read_only_configured',
      COALESCE(
        (
          SELECT role.rolconfig @> ARRAY[
            'default_transaction_read_only=on'
          ]::text[]
          FROM pg_roles AS role
          WHERE role.rolname = 'gama_crm_auditor'
        ),
        false
      )
  )
$function$;

ALTER FUNCTION crm_audit_api.crm_audit_authority_contract() OWNER TO postgres;
REVOKE ALL PRIVILEGES ON FUNCTION crm_audit_api.crm_audit_authority_contract()
  FROM PUBLIC, anon, authenticated, service_role, gama_crm_auditor;
GRANT EXECUTE ON FUNCTION crm_audit_api.crm_audit_authority_contract()
  TO gama_crm_auditor;

CREATE OR REPLACE VIEW crm_audit_api.crm_audit_accounts
WITH (security_barrier = true, security_invoker = false)
AS
SELECT a.id
FROM public.accounts AS a
WHERE a.id = (SELECT crm_audit_private.request_account_id());

CREATE OR REPLACE VIEW crm_audit_api.crm_audit_contacts
WITH (security_barrier = true, security_invoker = false)
AS
SELECT c.id, c.account_id
FROM public.contacts AS c
WHERE c.account_id = (SELECT crm_audit_private.request_account_id());

CREATE OR REPLACE VIEW crm_audit_api.crm_audit_conversations
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  c.id,
  c.account_id,
  c.status,
  c.assigned_agent_id,
  c.ai_autoreply_disabled,
  c.ai_handoff_summary,
  c.last_message_at
FROM public.conversations AS c
WHERE c.account_id = (SELECT crm_audit_private.request_account_id());

CREATE OR REPLACE VIEW crm_audit_api.crm_audit_messages
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  m.id,
  m.conversation_id,
  m.sender_type,
  m.content_type,
  m.content_text,
  m.status,
  m.status_error,
  m.created_at,
  m.ai_generated,
  c.account_id
FROM public.messages AS m
INNER JOIN public.conversations AS c ON c.id = m.conversation_id
WHERE c.account_id = (SELECT crm_audit_private.request_account_id());

CREATE OR REPLACE VIEW crm_audit_api.crm_audit_automations
WITH (security_barrier = true, security_invoker = false)
AS
SELECT a.id, a.account_id
FROM public.automations AS a
WHERE a.account_id = (SELECT crm_audit_private.request_account_id());

CREATE OR REPLACE VIEW crm_audit_api.crm_audit_automation_logs
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  l.id,
  l.account_id,
  l.automation_id,
  l.status,
  l.error_message,
  l.steps_executed,
  l.created_at
FROM public.automation_logs AS l
WHERE l.account_id = (SELECT crm_audit_private.request_account_id());

CREATE OR REPLACE VIEW crm_audit_api.crm_audit_pending_executions
WITH (security_barrier = true, security_invoker = false)
AS
SELECT p.id, p.account_id, p.automation_id, p.status, p.run_at, p.created_at
FROM public.automation_pending_executions AS p
WHERE p.account_id = (SELECT crm_audit_private.request_account_id());

CREATE OR REPLACE VIEW crm_audit_api.crm_audit_flows
WITH (security_barrier = true, security_invoker = false)
AS
SELECT f.id, f.account_id, f.fallback_policy
FROM public.flows AS f
WHERE f.account_id = (SELECT crm_audit_private.request_account_id());

CREATE OR REPLACE VIEW crm_audit_api.crm_audit_flow_runs
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  r.id,
  r.account_id,
  r.flow_id,
  r.conversation_id,
  r.status,
  r.last_advanced_at,
  r.end_reason
FROM public.flow_runs AS r
WHERE r.account_id = (SELECT crm_audit_private.request_account_id());

CREATE OR REPLACE VIEW crm_audit_api.crm_audit_webhook_endpoints
WITH (security_barrier = true, security_invoker = false)
AS
SELECT w.id, w.account_id, w.is_active, w.failure_count, w.last_delivery_at
FROM public.webhook_endpoints AS w
WHERE w.account_id = (SELECT crm_audit_private.request_account_id());

CREATE OR REPLACE VIEW crm_audit_api.crm_audit_whatsapp_config
WITH (security_barrier = true, security_invoker = false)
AS
SELECT w.id, w.account_id, w.status, w.last_registration_error
FROM public.whatsapp_config AS w
WHERE w.account_id = (SELECT crm_audit_private.request_account_id());

ALTER VIEW crm_audit_api.crm_audit_accounts OWNER TO postgres;
ALTER VIEW crm_audit_api.crm_audit_contacts OWNER TO postgres;
ALTER VIEW crm_audit_api.crm_audit_conversations OWNER TO postgres;
ALTER VIEW crm_audit_api.crm_audit_messages OWNER TO postgres;
ALTER VIEW crm_audit_api.crm_audit_automations OWNER TO postgres;
ALTER VIEW crm_audit_api.crm_audit_automation_logs OWNER TO postgres;
ALTER VIEW crm_audit_api.crm_audit_pending_executions OWNER TO postgres;
ALTER VIEW crm_audit_api.crm_audit_flows OWNER TO postgres;
ALTER VIEW crm_audit_api.crm_audit_flow_runs OWNER TO postgres;
ALTER VIEW crm_audit_api.crm_audit_webhook_endpoints OWNER TO postgres;
ALTER VIEW crm_audit_api.crm_audit_whatsapp_config OWNER TO postgres;

REVOKE ALL PRIVILEGES ON TABLE crm_audit_api.crm_audit_accounts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE crm_audit_api.crm_audit_contacts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE crm_audit_api.crm_audit_conversations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE crm_audit_api.crm_audit_messages FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE crm_audit_api.crm_audit_automations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE crm_audit_api.crm_audit_automation_logs FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE crm_audit_api.crm_audit_pending_executions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE crm_audit_api.crm_audit_flows FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE crm_audit_api.crm_audit_flow_runs FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE crm_audit_api.crm_audit_webhook_endpoints FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE crm_audit_api.crm_audit_whatsapp_config FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE crm_audit_api.crm_audit_accounts TO gama_crm_auditor;
GRANT SELECT ON TABLE crm_audit_api.crm_audit_contacts TO gama_crm_auditor;
GRANT SELECT ON TABLE crm_audit_api.crm_audit_conversations TO gama_crm_auditor;
GRANT SELECT ON TABLE crm_audit_api.crm_audit_messages TO gama_crm_auditor;
GRANT SELECT ON TABLE crm_audit_api.crm_audit_automations TO gama_crm_auditor;
GRANT SELECT ON TABLE crm_audit_api.crm_audit_automation_logs TO gama_crm_auditor;
GRANT SELECT ON TABLE crm_audit_api.crm_audit_pending_executions TO gama_crm_auditor;
GRANT SELECT ON TABLE crm_audit_api.crm_audit_flows TO gama_crm_auditor;
GRANT SELECT ON TABLE crm_audit_api.crm_audit_flow_runs TO gama_crm_auditor;
GRANT SELECT ON TABLE crm_audit_api.crm_audit_webhook_endpoints TO gama_crm_auditor;
GRANT SELECT ON TABLE crm_audit_api.crm_audit_whatsapp_config TO gama_crm_auditor;

-- Remove the development version of these endpoints from the shared schema.
DROP VIEW IF EXISTS public.crm_audit_accounts;
DROP VIEW IF EXISTS public.crm_audit_contacts;
DROP VIEW IF EXISTS public.crm_audit_conversations;
DROP VIEW IF EXISTS public.crm_audit_messages;
DROP VIEW IF EXISTS public.crm_audit_automations;
DROP VIEW IF EXISTS public.crm_audit_automation_logs;
DROP VIEW IF EXISTS public.crm_audit_pending_executions;
DROP VIEW IF EXISTS public.crm_audit_flows;
DROP VIEW IF EXISTS public.crm_audit_flow_runs;
DROP VIEW IF EXISTS public.crm_audit_webhook_endpoints;
DROP VIEW IF EXISTS public.crm_audit_whatsapp_config;
DROP FUNCTION IF EXISTS public.crm_audit_verify_transaction_read_only();

NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
