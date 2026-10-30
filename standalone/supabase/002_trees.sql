-- Adds the tree counts of a field. Run once in the Supabase SQL editor, after schema.sql.
-- Run it before publishing the app version that uses these columns.

alter table public.fields
  add column total_trees int check (total_trees >= 0),
  add column female_trees int check (female_trees >= 0),
  add constraint female_within_total check (female_trees <= total_trees);

create or replace function public.push_change(p_col text, p_id text, p_data jsonb, p_deleted boolean, p_client_ts timestamptz)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  uid uuid := auth.uid();
  applied boolean;
begin
  if uid is null then raise exception 'not signed in'; end if;

  if p_deleted then
    if p_col = 'fields' then
      update public.fields set deleted = true, client_updated_at = p_client_ts, updated_at = clock_timestamp()
       where user_id = uid and id = p_id and client_updated_at <= p_client_ts;
    elsif p_col = 'invoices' then
      update public.invoices set deleted = true, client_updated_at = p_client_ts, updated_at = clock_timestamp()
       where user_id = uid and id = p_id and client_updated_at <= p_client_ts;
    elsif p_col = 'entries' then
      update public.entries set deleted = true, client_updated_at = p_client_ts, updated_at = clock_timestamp()
       where user_id = uid and id = p_id and client_updated_at <= p_client_ts;
    else
      raise exception 'unknown collection %', p_col;
    end if;
    return;
  end if;

  if p_col = 'fields' then
    insert into public.fields as t (user_id, id, name, area, variety, planted_year, total_trees, female_trees, note, client_updated_at)
    values (uid, p_id, p_data->>'name', (p_data->>'area')::numeric, p_data->>'variety', p_data->>'plantedYear', nullif(p_data->>'totalTrees', '')::int, nullif(p_data->>'femaleTrees', '')::int, p_data->>'note', p_client_ts)
    on conflict (user_id, id) do update
      set name = excluded.name, area = excluded.area, variety = excluded.variety, planted_year = excluded.planted_year,
          total_trees = excluded.total_trees, female_trees = excluded.female_trees,
          note = excluded.note, deleted = false, client_updated_at = excluded.client_updated_at, updated_at = clock_timestamp()
      where t.client_updated_at <= excluded.client_updated_at;

  elsif p_col = 'invoices' then
    insert into public.invoices as t (user_id, id, number, date, supplier, vat, file_id, client_updated_at)
    values (uid, p_id, p_data->>'number', (p_data->>'date')::date, p_data->>'supplier', nullif(p_data->>'vat', '')::numeric, p_data->>'fileId', p_client_ts)
    on conflict (user_id, id) do update
      set number = excluded.number, date = excluded.date, supplier = excluded.supplier, vat = excluded.vat,
          file_id = excluded.file_id, deleted = false, client_updated_at = excluded.client_updated_at, updated_at = clock_timestamp()
      where t.client_updated_at <= excluded.client_updated_at;
    get diagnostics applied = row_count;
    if applied then
      delete from public.invoice_lines where user_id = uid and invoice_id = p_id;
      insert into public.invoice_lines (user_id, invoice_id, id, position, product, formula, qty, unit, price)
      select uid, p_id, l.value->>'id', l.ordinality::int, l.value->>'product', l.value->>'formula',
             (l.value->>'qty')::numeric, l.value->>'unit', nullif(l.value->>'price', '')::numeric
        from jsonb_array_elements(coalesce(p_data->'lines', '[]'::jsonb)) with ordinality as l;
    end if;

  elsif p_col = 'entries' then
    insert into public.entries as t (user_id, id, type, date, field_id, product, formula, qty, unit, stage, method, note, invoice_id, line_id, details, client_updated_at)
    values (uid, p_id, coalesce(p_data->>'type', 'fertilizer'), (p_data->>'date')::date, p_data->>'fieldId', p_data->>'product', p_data->>'formula',
            nullif(p_data->>'qty', '')::numeric, p_data->>'unit', p_data->>'stage', p_data->>'method', p_data->>'note',
            p_data->>'invoiceId', p_data->>'lineId', coalesce(p_data->'details', '{}'::jsonb), p_client_ts)
    on conflict (user_id, id) do update
      set type = excluded.type, date = excluded.date, field_id = excluded.field_id, product = excluded.product, formula = excluded.formula,
          qty = excluded.qty, unit = excluded.unit, stage = excluded.stage, method = excluded.method, note = excluded.note,
          invoice_id = excluded.invoice_id, line_id = excluded.line_id, details = excluded.details,
          deleted = false, client_updated_at = excluded.client_updated_at, updated_at = clock_timestamp()
      where t.client_updated_at <= excluded.client_updated_at;

  else
    raise exception 'unknown collection %', p_col;
  end if;
end $$;

-- Everything changed since the given time, in the shape the app stores on the device.
create or replace function public.pull_changes(p_since timestamptz)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'server_time', clock_timestamp(),
    'fields', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'deleted', f.deleted, 'data', jsonb_build_object(
        'name', f.name, 'area', f.area, 'variety', f.variety, 'plantedYear', f.planted_year, 'totalTrees', f.total_trees, 'femaleTrees', f.female_trees, 'note', f.note)))
      from public.fields f where f.user_id = auth.uid() and (p_since is null or f.updated_at > p_since)), '[]'::jsonb),
    'invoices', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'deleted', i.deleted, 'data', jsonb_build_object(
        'number', i.number, 'date', i.date, 'supplier', i.supplier, 'vat', i.vat, 'fileId', i.file_id,
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object('id', l.id, 'product', l.product, 'formula', l.formula, 'qty', l.qty, 'unit', l.unit, 'price', l.price) order by l.position)
          from public.invoice_lines l where l.user_id = i.user_id and l.invoice_id = i.id), '[]'::jsonb))))
      from public.invoices i where i.user_id = auth.uid() and (p_since is null or i.updated_at > p_since)), '[]'::jsonb),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'deleted', e.deleted, 'data', jsonb_build_object(
        'type', e.type, 'date', e.date, 'fieldId', e.field_id, 'product', e.product, 'formula', e.formula, 'qty', e.qty, 'unit', e.unit,
        'stage', e.stage, 'method', e.method, 'note', e.note, 'invoiceId', e.invoice_id, 'lineId', e.line_id, 'details', e.details)))
      from public.entries e where e.user_id = auth.uid() and (p_since is null or e.updated_at > p_since)), '[]'::jsonb)
  )
$$;
