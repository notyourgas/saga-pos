-- Add production transformation to the immutable inventory valuation ledger.
-- Additive migration only; this file does not authorize target-database mutation.
-- Existing valuation tables retain their enabled and forced row level security.

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'sagaops.inventory_valuation_facts'::regclass
       and conname = 'inventory_valuation_fact_type_v2'
  ) then
    if not exists (
      select 1 from pg_constraint
       where conrelid = 'sagaops.inventory_valuation_facts'::regclass
         and conname = 'inventory_valuation_facts_fact_document_check3'
         and pg_get_constraintdef(oid) = 'CHECK ((((fact_document ->> ''type''::text) = ANY (ARRAY[''PROVISIONAL_RECEIPT''::text, ''INVENTORY_CONSUMPTION''::text, ''RECEIPT_REVALUATION''::text])) IS TRUE))'
    ) then
      raise exception 'inventory_valuation_fact_type_v1_constraint_mismatch' using errcode = '55000';
    end if;
    alter table sagaops.inventory_valuation_facts
      drop constraint inventory_valuation_facts_fact_document_check3;
    alter table sagaops.inventory_valuation_facts
      add constraint inventory_valuation_fact_type_v2
      check ((fact_document->>'type' in (
        'PROVISIONAL_RECEIPT',
        'INVENTORY_CONSUMPTION',
        'RECEIPT_REVALUATION',
        'PRODUCTION_TRANSFORMATION'
      )) is true) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'sagaops.inventory_valuation_facts'::regclass
       and conname = 'inventory_valuation_fact_type_v2'
       and pg_get_constraintdef(oid) in (
         'CHECK ((((fact_document ->> ''type''::text) = ANY (ARRAY[''PROVISIONAL_RECEIPT''::text, ''INVENTORY_CONSUMPTION''::text, ''RECEIPT_REVALUATION''::text, ''PRODUCTION_TRANSFORMATION''::text])) IS TRUE))',
         'CHECK ((((fact_document ->> ''type''::text) = ANY (ARRAY[''PROVISIONAL_RECEIPT''::text, ''INVENTORY_CONSUMPTION''::text, ''RECEIPT_REVALUATION''::text, ''PRODUCTION_TRANSFORMATION''::text])) IS TRUE)) NOT VALID'
       )
  ) then
    raise exception 'inventory_valuation_fact_type_v2_constraint_mismatch' using errcode = '55000';
  end if;
  if exists (
    select 1 from pg_constraint
     where conrelid = 'sagaops.inventory_valuation_facts'::regclass
       and conname = 'inventory_valuation_facts_fact_document_check3'
       and pg_get_constraintdef(oid) = 'CHECK ((((fact_document ->> ''type''::text) = ANY (ARRAY[''PROVISIONAL_RECEIPT''::text, ''INVENTORY_CONSUMPTION''::text, ''RECEIPT_REVALUATION''::text])) IS TRUE))'
  ) then
    alter table sagaops.inventory_valuation_facts
      drop constraint inventory_valuation_facts_fact_document_check3;
  elsif exists (
    select 1 from pg_constraint
     where conrelid = 'sagaops.inventory_valuation_facts'::regclass
       and conname = 'inventory_valuation_facts_fact_document_check3'
  ) then
    raise exception 'inventory_valuation_fact_type_v1_constraint_mismatch' using errcode = '55000';
  end if;
end $$;

alter table sagaops.inventory_valuation_facts
  validate constraint inventory_valuation_fact_type_v2;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'sagaops.inventory_valuation_operations'::regclass
       and conname = 'inventory_valuation_operation_fact_type_v2'
  ) then
    if not exists (
      select 1 from pg_constraint
       where conrelid = 'sagaops.inventory_valuation_operations'::regclass
         and conname = 'inventory_valuation_operations_result_document_check9'
         and pg_get_constraintdef(oid) = 'CHECK (((((result_document -> ''fact''::text) ->> ''type''::text) = ANY (ARRAY[''PROVISIONAL_RECEIPT''::text, ''INVENTORY_CONSUMPTION''::text, ''RECEIPT_REVALUATION''::text])) IS TRUE))'
    ) then
      raise exception 'inventory_valuation_operation_fact_type_v1_constraint_mismatch' using errcode = '55000';
    end if;
    alter table sagaops.inventory_valuation_operations
      drop constraint inventory_valuation_operations_result_document_check9;
    alter table sagaops.inventory_valuation_operations
      add constraint inventory_valuation_operation_fact_type_v2
      check ((result_document->'fact'->>'type' in (
        'PROVISIONAL_RECEIPT',
        'INVENTORY_CONSUMPTION',
        'RECEIPT_REVALUATION',
        'PRODUCTION_TRANSFORMATION'
      )) is true) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'sagaops.inventory_valuation_operations'::regclass
       and conname = 'inventory_valuation_operation_fact_type_v2'
       and pg_get_constraintdef(oid) in (
         'CHECK (((((result_document -> ''fact''::text) ->> ''type''::text) = ANY (ARRAY[''PROVISIONAL_RECEIPT''::text, ''INVENTORY_CONSUMPTION''::text, ''RECEIPT_REVALUATION''::text, ''PRODUCTION_TRANSFORMATION''::text])) IS TRUE))',
         'CHECK (((((result_document -> ''fact''::text) ->> ''type''::text) = ANY (ARRAY[''PROVISIONAL_RECEIPT''::text, ''INVENTORY_CONSUMPTION''::text, ''RECEIPT_REVALUATION''::text, ''PRODUCTION_TRANSFORMATION''::text])) IS TRUE)) NOT VALID'
       )
  ) then
    raise exception 'inventory_valuation_operation_fact_type_v2_constraint_mismatch' using errcode = '55000';
  end if;
  if exists (
    select 1 from pg_constraint
     where conrelid = 'sagaops.inventory_valuation_operations'::regclass
       and conname = 'inventory_valuation_operations_result_document_check9'
       and pg_get_constraintdef(oid) = 'CHECK (((((result_document -> ''fact''::text) ->> ''type''::text) = ANY (ARRAY[''PROVISIONAL_RECEIPT''::text, ''INVENTORY_CONSUMPTION''::text, ''RECEIPT_REVALUATION''::text])) IS TRUE))'
  ) then
    alter table sagaops.inventory_valuation_operations
      drop constraint inventory_valuation_operations_result_document_check9;
  elsif exists (
    select 1 from pg_constraint
     where conrelid = 'sagaops.inventory_valuation_operations'::regclass
       and conname = 'inventory_valuation_operations_result_document_check9'
  ) then
    raise exception 'inventory_valuation_operation_fact_type_v1_constraint_mismatch' using errcode = '55000';
  end if;
end $$;

alter table sagaops.inventory_valuation_operations
  validate constraint inventory_valuation_operation_fact_type_v2;
