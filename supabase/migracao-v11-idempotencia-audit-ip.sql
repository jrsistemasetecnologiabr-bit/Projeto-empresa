-- ============================================================================
-- LojaCerta · Migração v11 — Idempotência da venda + IP na auditoria
-- ----------------------------------------------------------------------------
-- ONDA 3b/4a do fechamento para produção (auditoria externa):
--   1. audit_logs.ip + audit_logs.origem — o trilha de auditoria passa a
--      registrar DE ONDE veio cada escrita sensível mediada pela Edge
--      (função api) — triggers de banco continuam com origem 'db' (o banco
--      não conhece o IP real do cliente; limitação documentada no SECURITY.md).
--   2. commit_sale aceita p.idempotencyId (uuid gerado pelo front no início
--      da finalização). Mesmo id → mesma venda (sem duplicar estoque/auditoria
--      em duplo-clique/retry de rede). Retrocompatível: sem o campo, o
--      comportamento anterior é mantido (id gerado pelo banco).
--      Implementação: pré-checagem + INSERT ... ON CONFLICT (id) DO NOTHING +
--      retorno da venda existente — à prova de corrida entre duas requisições.
-- ============================================================================

-- ---------- 1 · auditoria com IP/origem ----------
alter table public.audit_logs add column if not exists ip text;
alter table public.audit_logs add column if not exists origem text not null default 'db';
comment on column public.audit_logs.ip is 'IP do cliente quando a escrita passou pela Edge Function (api); triggers de banco não têm como conhecer o IP real';
comment on column public.audit_logs.origem is 'db = trigger/RPC direto no banco · edge = função api (com IP)';

-- ---------- 2 · payload de venda reutilizável (retorno idempotente) ----------
create or replace function public.sale_payload(p_sale uuid)
returns jsonb
language sql
stable
security definer
set search_path = 'public'
as $$
  select jsonb_build_object(
    'id', s.id, 'numero', s.numero, 'subtotal', s.subtotal, 'desconto', s.desconto,
    'total', s.total,
    'itens', (select coalesce(jsonb_agg(jsonb_build_object(
                 'productId', i.product_id, 'nome', i.nome_snapshot, 'un', i.unidade,
                 'qtd', i.qtd, 'preco', i.preco_unitario, 'subtotal', i.subtotal)
                 order by i.nome_snapshot), '[]'::jsonb)
              from public.sale_items i where i.sale_id = s.id),
    'pagamentos', (select coalesce(jsonb_agg(jsonb_build_object('forma', p.forma, 'valor', p.valor)), '[]'::jsonb)
              from public.sale_payments p where p.sale_id = s.id),
    'at', s.created_at,
    'userName', (select w.nome from public.users w where w.id = s.user_id))
  from public.sales s
  where s.id = p_sale;
$$;

-- ---------- 3 · commit_sale idempotente ----------
create or replace function public.commit_sale(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  t uuid := public.current_tenant_id();
  u uuid := auth.uid();
  r text := public.current_role_app();
  st_status text; st_plan text; cfg jsonb; item jsonb; prow products%rowtype;
  q numeric(14,3); lim numeric;
  v_sub numeric(12,2) := 0; v_disc numeric(12,2) := 0; v_total numeric(12,2);
  v_pago numeric(12,2) := 0; v_numero text; v_id uuid;
  v_idem uuid; v_tchk uuid;   -- idempotência (Onda 4a)
  pay jsonb; arr jsonb := '[]'::jsonb; parr jsonb := '[]'::jsonb;
begin
  if t is null or u is null then raise exception 'UNAUTHORIZED'; end if;

  -- idempotência: id gerado pelo front, usado como PK da venda.
  begin
    v_idem := nullif(p->>'idempotencyId', '')::uuid;
  exception when others then
    v_idem := null;            -- payload malformado → comportamento antigo
  end;

  if v_idem is not null then
    select tenant_id into v_tchk from public.sales where id = v_idem;
    if v_tchk is not null then
      if v_tchk <> t then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
      return public.sale_payload(v_idem);  -- mesma tentativa: devolve a venda já gravada
    end if;
  end if;

  perform public.billing_refresh_status();   -- vira trial vencido em read_only
  select status, plan_id, config into st_status, st_plan, cfg from public.tenants where id = t for update;
  if st_status not in ('trialing','active','past_due') then
    if st_plan is null then raise exception 'TRIAL_EXPIRED'; end if;
    raise exception 'BILLING_BLOCKED';
  end if;
  if coalesce(jsonb_array_length(p->'items'),0) = 0 then raise exception 'EMPTY_CART'; end if;

  for item in select * from jsonb_array_elements(p->'items') loop
    select * into prow from public.products
     where id = (item->>'productId')::uuid and tenant_id = t and ativo for update;
    if not found then raise exception 'PROD_OFF'; end if;
    q := (item->>'qtd')::numeric(14,3);
    if q <= 0 then raise exception 'VALIDATION'; end if;
    if coalesce((cfg->>'permiteEstoqueNegativo')::boolean,false) is false and q > prow.estoque_atual
      then raise exception 'NO_STOCK'; end if;
    v_sub := v_sub + prow.preco_venda * q;
    arr := arr || jsonb_build_object('productId', prow.id, 'nome', prow.nome, 'un', prow.unidade,
             'qtd', q, 'preco', prow.preco_venda, 'subtotal', round(prow.preco_venda * q, 2));
  end loop;
  v_sub := round(v_sub, 2);

  if coalesce(p->'discount'->>'tipo','R$') = '%' then
    v_disc := round(v_sub * coalesce((p->'discount'->>'valor')::numeric, 0) / 100, 2);
  else
    v_disc := round(coalesce((p->'discount'->>'valor')::numeric, 0), 2);
  end if;
  v_disc := least(greatest(v_disc, 0), v_sub);
  lim := coalesce((cfg->>'descontoCaixaPct')::numeric, 10);
  if r = 'caixa' and v_sub > 0 and (v_disc / v_sub) * 100 > lim + 0.001 then raise exception 'DISCOUNT_LIMIT'; end if;
  v_total := round(v_sub - v_disc, 2);

  for pay in select * from jsonb_array_elements(coalesce(p->'payments','[]'::jsonb)) loop
    if coalesce((pay->>'valor')::numeric, 0) > 0 then
      if coalesce(pay->>'forma','') not in ('pix','credito','debito','dinheiro') then raise exception 'VALIDATION'; end if;
      v_pago := v_pago + (pay->>'valor')::numeric;
      parr := parr || jsonb_build_object('forma', pay->>'forma', 'valor', round((pay->>'valor')::numeric, 2));
    end if;
  end loop;
  if abs(v_pago - v_total) > 0.011 then raise exception 'PAY_MISMATCH'; end if;

  v_numero := public.next_sale_numero(t);
  insert into public.sales (id, tenant_id, numero, user_id, subtotal, desconto, desconto_tipo, total)
  values (coalesce(v_idem, gen_random_uuid()), t, v_numero, u, v_sub, v_disc, coalesce(p->'discount'->>'tipo','R$'), v_total)
  on conflict (id) do nothing
  returning id into v_id;

  if v_id is null then
    -- corrida: a mesma tentativa foi gravada por outra requisição entre a
    -- pré-checagem e o INSERT — devolve a venda que já existe (idempotente).
    select tenant_id into v_tchk from public.sales where id = v_idem;
    if v_tchk is null or v_tchk <> t then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return public.sale_payload(v_idem);
  end if;

  insert into public.sale_items (sale_id, product_id, nome_snapshot, unidade, qtd, preco_unitario, subtotal)
  select v_id, (x->>'productId')::uuid, x->>'nome', x->>'un', (x->>'qtd')::numeric,
         (x->>'preco')::numeric, (x->>'subtotal')::numeric
    from jsonb_array_elements(arr) x;

  insert into public.sale_payments (sale_id, forma, valor)
  select v_id, x->>'forma', (x->>'valor')::numeric from jsonb_array_elements(parr) x;

  update public.products pr
     set estoque_atual = pr.estoque_atual - (x->>'qtd')::numeric,
         updated_at = now()
    from jsonb_array_elements(arr) x
   where pr.id = (x->>'productId')::uuid;

  insert into public.stock_movements (tenant_id, product_id, tipo, qtd, user_id, origem)
  select t, (x->>'productId')::uuid, 'saida', (x->>'qtd')::numeric, u, v_numero
    from jsonb_array_elements(arr) x;

  insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes, origem)
  values (t, u, (select nome from public.users where id = u),
          'venda.concluida', 'sale', v_id::text, v_numero || ' · R$ ' || v_total::text, 'rpc');

  return jsonb_build_object('id', v_id, 'numero', v_numero, 'subtotal', v_sub, 'desconto', v_disc,
          'total', v_total, 'itens', arr, 'pagamentos', parr, 'at', now(),
          'userName', (select nome from public.users where id = u));
end $function$;

-- ---------- 4 · RLS continua: audit_logs é escrita por trigger/service role ----------
-- (nenhuma policy nova: leitura continua dev-only via admin_audit_list)
