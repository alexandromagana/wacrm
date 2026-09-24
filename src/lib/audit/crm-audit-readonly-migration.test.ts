import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/051_crm_auditor_readonly.sql'
);

const viewNames = [
  'crm_audit_accounts',
  'crm_audit_contacts',
  'crm_audit_conversations',
  'crm_audit_messages',
  'crm_audit_automations',
  'crm_audit_automation_logs',
  'crm_audit_pending_executions',
  'crm_audit_flows',
  'crm_audit_flow_runs',
  'crm_audit_webhook_endpoints',
  'crm_audit_whatsapp_config',
] as const;

describe('CRM auditor read-only migration', () => {
  it('creates a non-login, non-inheriting, non-bypass role for PostgREST', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toMatch(/create role gama_crm_auditor/i);
    expect(sql).toMatch(
      /create role gama_crm_auditor\s+no(?:login|inherit)[\s\S]*no(?:login|inherit)/i
    );
    for (const unsafeAttribute of [
      'rolsuper',
      'rolinherit',
      'rolcreaterole',
      'rolcreatedb',
      'rolcanlogin',
      'rolreplication',
      'rolbypassrls',
    ]) {
      expect(sql.toLowerCase()).toContain(unsafeAttribute);
    }
    expect(sql).toMatch(/grant gama_crm_auditor to authenticator/i);
    expect(sql).not.toMatch(
      /grant\s+(?:anon|authenticated|service_role)\s+to\s+gama_crm_auditor/i
    );
    expect(sql).toMatch(
      /alter role gama_crm_auditor\s+set default_transaction_read_only = on/i
    );
  });

  it('does not require superuser-only ALTER ROLE attribute changes', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).not.toMatch(
      /alter role gama_crm_auditor with[^;]*(?:nosuperuser|nobypassrls)/
    );
    expect(sql).toMatch(
      /raise exception 'gama_crm_auditor has unsafe role attributes'/i
    );
  });

  it('binds every security-barrier view to the signed account claim', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    );
    expect(sql).toMatch(/current_setting\('request\.jwt\.claims', true\)/i);
    expect(sql).toMatch(/current_setting\('request\.method', true\)/i);
    expect(sql).toMatch(/current_user\s*<>\s*'gama_crm_auditor'/i);

    for (const viewName of viewNames) {
      expect(sql).toMatch(
        new RegExp(
          `create or replace view crm_audit_api\\.${viewName}\\s+with\\s*\\([^)]*security_barrier\\s*=\\s*true[^)]*security_invoker\\s*=\\s*false`,
          'i'
        )
      );
      expect(sql).toMatch(
        new RegExp(
          `revoke all (?:privileges )?on (?:table )?crm_audit_api\\.${viewName} from public, anon, authenticated, service_role`,
          'i'
        )
      );
      expect(sql).toMatch(
        new RegExp(
          `grant select on (?:table )?crm_audit_api\\.${viewName} to gama_crm_auditor`,
          'i'
        )
      );
    }
  });

  it('grants the audit role no direct CRM table or mutating view privilege', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toMatch(
      /revoke all privileges on all tables in schema public from gama_crm_auditor/i
    );
    expect(sql).toMatch(
      /revoke all privileges on all sequences in schema public from gama_crm_auditor/i
    );
    expect(sql).not.toMatch(
      /grant\s+(?:insert|update|delete|truncate|references|trigger|all)\b[\s\S]*?to\s+gama_crm_auditor/i
    );
  });

  it('keeps the auditor out of public and exposes a dedicated API schema', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toMatch(
      /revoke all privileges on schema public from gama_crm_auditor/i
    );
    expect(sql).not.toMatch(/grant usage on schema public to gama_crm_auditor/i);
    expect(sql).toMatch(/create schema if not exists crm_audit_api/i);
    expect(sql).toMatch(/grant usage on schema crm_audit_api to gama_crm_auditor/i);
    expect(sql).toMatch(
      /alter role authenticator\s+set pgrst\.db_schemas\s*=\s*'public, graphql_public, crm_audit_api'/i
    );
  });

  it('removes every legacy audit endpoint from the public schema', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    for (const viewName of viewNames) {
      expect(sql).toMatch(
        new RegExp(`drop view if exists public\\.${viewName}`, 'i')
      );
    }
    expect(sql).toMatch(
      /drop function if exists public\.crm_audit_verify_transaction_read_only\(\)/i
    );
  });

  it('exposes a non-mutating transaction-mode proof for live verification', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    const proof = sql.match(
      /create or replace function crm_audit_api\.crm_audit_verify_transaction_read_only\(\)[\s\S]*?\$function\$;/i
    )?.[0];
    const proofBody = proof?.match(/\$function\$([\s\S]*?)\$function\$/i)?.[1];

    expect(proof).toBeDefined();
    expect(proof).toMatch(/current_setting\('transaction_read_only'\)/i);
    expect(proofBody).not.toMatch(
      /\b(?:insert|update|delete|merge|truncate|create|alter|drop)\b/i
    );
    expect(sql).toMatch(
      /grant execute on function crm_audit_api\.crm_audit_verify_transaction_read_only\(\)\s+to gama_crm_auditor/i
    );
    expect(sql).toMatch(
      /revoke all privileges on function crm_audit_api\.crm_audit_verify_transaction_read_only\(\)\s+from public, anon, authenticated, service_role, gama_crm_auditor/i
    );
  });

  it('exposes a sanitized live authority contract without catalog identifiers', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    const proof = sql.match(
      /create or replace function crm_audit_api\.crm_audit_authority_contract\(\)[\s\S]*?\$function\$;/i
    )?.[0];
    const proofBody = proof?.match(/\$function\$([\s\S]*?)\$function\$/i)?.[1];

    expect(proof).toBeDefined();
    expect(proof).toMatch(/security definer/i);
    expect(proof).toMatch(/set search_path = pg_catalog/i);
    for (const invariant of [
      'no_role_memberships',
      'no_direct_table_writes',
      'public_schema_usage_present',
      'public_function_execute_count',
      'pre_request_guard_configured',
      'transaction_read_only_configured',
    ]) {
      expect(proof).toContain(`'${invariant}'`);
    }
    expect(proofBody).not.toMatch(
      /(?:^|;)\s*(?:insert|update|delete|merge|truncate|create|alter|drop)\b/im
    );
    expect(sql).toMatch(
      /revoke all privileges on function crm_audit_api\.crm_audit_authority_contract\(\)\s+from public, anon, authenticated, service_role, gama_crm_auditor/i
    );
    expect(sql).toMatch(
      /grant execute on function crm_audit_api\.crm_audit_authority_contract\(\)\s+to gama_crm_auditor/i
    );
  });

  it('installs a fail-closed pre-request guard for every non-read HTTP method', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    const guard = sql.match(
      /create or replace function crm_audit_private\.enforce_http_read_only\(\)[\s\S]*?\$function\$;/i
    )?.[0];
    const guardBody = guard?.match(/\$function\$([\s\S]*?)\$function\$/i)?.[1];

    expect(guard).toBeDefined();
    expect(guard).toMatch(/current_user\s*=\s*'gama_crm_auditor'/i);
    expect(guard).toMatch(/request\.method/i);
    expect(guard).toMatch(/not in\s*\('GET',\s*'HEAD'\)/i);
    expect(guardBody).not.toMatch(
      /\b(?:insert|update|delete|merge|truncate|create|alter|drop)\b/i
    );
    expect(sql).toMatch(
      /alter role authenticator\s+set pgrst\.db_pre_request\s*=\s*'crm_audit_private\.enforce_http_read_only'/i
    );
    expect(sql).toMatch(/notify pgrst, 'reload config'/i);
  });

  it('rejects auditor requests outside the dedicated schema profile', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    const guard = sql.match(
      /create or replace function crm_audit_private\.enforce_http_read_only\(\)[\s\S]*?\$function\$;/i
    )?.[0];

    expect(guard).toBeDefined();
    expect(guard).toMatch(/request\.headers/i);
    expect(guard).toMatch(/accept-profile/i);
    expect(guard).toMatch(/crm_audit_api/i);
    expect(guard).toMatch(/errcode\s*=\s*'42501'/i);
  });
});
