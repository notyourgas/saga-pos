CREATE ROLE "sagaops-production" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 6;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
CREATE DATABASE sagaops_production;
REVOKE ALL ON DATABASE sagaops_production FROM PUBLIC;
GRANT CONNECT ON DATABASE sagaops_production TO "sagaops-production";
\connect sagaops_production
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA auth;
-- Ledger name is retained for compatibility with the immutable migration verifier.
CREATE TABLE public.sagaops_private_schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.current_user_id',true),'')::uuid $$;
