create or replace function public.remove_application_document_from_json(
  p_value jsonb,
  p_document_id text
)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_result jsonb;
  v_child jsonb;
  v_transformed jsonb;
  v_entry record;
  v_removed boolean := false;
  v_removed_document jsonb;
begin
  case jsonb_typeof(p_value)
    when 'array' then
      v_result := '[]'::jsonb;
      for v_child in select value from jsonb_array_elements(p_value) as items(value) loop
        if not v_removed and jsonb_typeof(v_child) = 'object' and v_child ->> 'id' = p_document_id then
          v_removed := true;
          v_removed_document := v_child;
        elsif not v_removed then
          v_transformed := public.remove_application_document_from_json(v_child, p_document_id);
          if (v_transformed ->> 'removed')::boolean then
            v_removed := true;
            v_removed_document := v_transformed -> 'document';
          end if;
          v_result := v_result || jsonb_build_array(v_transformed -> 'value');
        else
          v_result := v_result || jsonb_build_array(v_child);
        end if;
      end loop;
    when 'object' then
      v_result := '{}'::jsonb;
      for v_entry in select key, value from jsonb_each(p_value) loop
        if not v_removed and jsonb_typeof(v_entry.value) = 'object' and v_entry.value ->> 'id' = p_document_id then
          v_removed := true;
          v_removed_document := v_entry.value;
        elsif not v_removed then
          v_transformed := public.remove_application_document_from_json(v_entry.value, p_document_id);
          if (v_transformed ->> 'removed')::boolean then
            v_removed := true;
            v_removed_document := v_transformed -> 'document';
          end if;
          v_result := v_result || jsonb_build_object(v_entry.key, v_transformed -> 'value');
        else
          v_result := v_result || jsonb_build_object(v_entry.key, v_entry.value);
        end if;
      end loop;
    else
      return jsonb_build_object('value', p_value, 'removed', false, 'document', null);
  end case;

  return jsonb_build_object(
    'value', v_result,
    'removed', v_removed,
    'document', v_removed_document
  );
end;
$$;

create or replace function public.append_staff_application_document(
  p_application_id text,
  p_document jsonb
)
returns jsonb
language plpgsql
as $$
declare
  v_application jsonb;
begin
  update public.applications as a
  set documents = jsonb_set(
        coalesce(a.documents, '{}'::jsonb),
        '{staffUploads}',
        (case
          when jsonb_typeof(a.documents -> 'staffUploads') = 'array' then a.documents -> 'staffUploads'
          else '[]'::jsonb
        end) || jsonb_build_array(p_document),
        true
      ),
      updated_at = now()
  where a.id = p_application_id
  returning to_jsonb(a) into v_application;

  return v_application;
end;
$$;

create or replace function public.delete_application_document(
  p_application_id text,
  p_document_id text,
  p_staff_only boolean
)
returns jsonb
language plpgsql
as $$
declare
  v_documents jsonb;
  v_result jsonb;
  v_application jsonb;
  v_target jsonb;
begin
  select a.documents
  into v_documents
  from public.applications as a
  where a.id = p_application_id
  for update;

  if not found then
    return jsonb_build_object('application', null, 'deletedDocument', null);
  end if;

  v_documents := coalesce(v_documents, '{}'::jsonb);
  v_target := case
    when p_staff_only then coalesce(v_documents -> 'staffUploads', 'null'::jsonb)
    else v_documents
  end;
  v_result := public.remove_application_document_from_json(v_target, p_document_id);

  if not (v_result ->> 'removed')::boolean then
    select to_jsonb(a) into v_application
    from public.applications as a
    where a.id = p_application_id;
    return jsonb_build_object('application', v_application, 'deletedDocument', null);
  end if;

  if p_staff_only then
    v_documents := jsonb_set(v_documents, '{staffUploads}', v_result -> 'value', true);
  else
    v_documents := v_result -> 'value';
  end if;

  update public.applications as a
  set documents = v_documents,
      updated_at = now()
  where a.id = p_application_id
  returning to_jsonb(a) into v_application;

  return jsonb_build_object(
    'application', v_application,
    'deletedDocument', v_result -> 'document'
  );
end;
$$;

revoke all on function public.remove_application_document_from_json(jsonb, text) from public, anon, authenticated;
revoke all on function public.append_staff_application_document(text, jsonb) from public, anon, authenticated;
revoke all on function public.delete_application_document(text, text, boolean) from public, anon, authenticated;
grant execute on function public.remove_application_document_from_json(jsonb, text) to service_role;
grant execute on function public.append_staff_application_document(text, jsonb) to service_role;
grant execute on function public.delete_application_document(text, text, boolean) to service_role;