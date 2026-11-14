-- ============================================================================
-- LojaCerta · MIGRAÇÃO v3 — RPCs atômicas (regras de negócio no servidor)
-- Rode no SQL Editor após o setup completo. Idempotente.
-- ============================================================================

-- ---------- VENDA (transação única: valida estoque, desconto por papel,
--            pagamentos, numeração, baixa de estoque, auditoria) --------------
create or replace function public.commit_sale(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t uuid := public.current_tenant_id();
  u uuid := auth.uid();
  r text := public.current_role_app();
  st_status text; cfg jsonb; item jsonb; prow products%rowtype;
  q numeric(14,3); lim numeric;
  v_sub numeric(12,2) := 0; v_disc numeric(12,2) := 0; v_total numeric(12,2);
  v_pago numeric(12,2) := 0; v_numero text; v_id uuid;
  pay jsonb; arr jsonb := '[]'::jsonb; parr jsonb := '[]'::jsonb;
begin
  if t is null or u is null then raise exception 'UNAUTHORIZED'; end if;
  select status, config into st_status, cfg from public.tenants where id = t for update;
  if st_status not in ('trialing','active','past_due') then raise exception 'BILLING_BLOCKED'; end if;
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
  insert into public.sales (tenant_id, numero, user_id, subtotal, desconto, desconto_tipo, total)
  values (t, v_numero, u, v_sub, v_disc, coalesce(p->'discount'->>'tipo','R$'), v_total)
  returning id into v_id;

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

  insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
  values (t, u, (select nome from public.users where id = u),
          'venda.concluida', 'sale', v_id::text, v_numero || ' · R$ ' || v_total::text);

  return jsonb_build_object('id', v_id, 'numero', v_numero, 'subtotal', v_sub, 'desconto', v_disc,
          'total', v_total, 'itens', arr, 'pagamentos', parr, 'at', now(),
          'userName', (select nome from public.users where id = u));
end $$;

-- ---------- CANCELAMENTO DE VENDA (somente admin; devolve estoque) ----------
create or replace function public.cancel_sale(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t uuid := public.current_tenant_id(); u uuid := auth.uid();
  v sales%rowtype; it record;
begin
  if public.current_role_app() is distinct from 'admin' then raise exception 'FORBIDDEN'; end if;
  if coalesce(p->>'reason','') = '' then raise exception 'VALIDATION'; end if;
  select * into v from public.sales where id = (p->>'id')::uuid and tenant_id = t for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v.status = 'cancelada' then raise exception 'ALREADY'; end if;
  update public.sales set status='cancelada', motivo_cancelamento = p->>'reason', canceled_at = now(), updated_at = now() where id = v.id;
  for it in select * from public.sale_items where sale_id = v.id loop
    update public.products set estoque_atual = estoque_atual + it.qtd, updated_at = now() where id = it.product_id;
    insert into public.stock_movements (tenant_id, product_id, tipo, qtd, user_id, origem, obs)
    values (t, it.product_id, 'venda_cancelada', it.qtd, u, v.numero, 'Motivo: ' || (p->>'reason'));
  end loop;
  insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
  values (t, u, (select nome from public.users where id = u), 'venda.cancelada', 'sale', v.id::text, v.numero || ' · ' || (p->>'reason'));
  return jsonb_build_object('ok', true);
end $$;

-- ---------- ENTRADA DE ESTOQUE (staff) --------------------------------------
create or replace function public.stock_entry(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t uuid := public.current_tenant_id(); u uuid := auth.uid();
  prow products%rowtype; q numeric(14,3); c numeric(12,2);
begin
  if not public.is_staff() then raise exception 'FORBIDDEN'; end if;
  q := (p->>'qtd')::numeric(14,3);
  if q <= 0 then raise exception 'VALIDATION'; end if;
  select * into prow from public.products where id = (p->>'productId')::uuid and tenant_id = t for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  c := coalesce((p->>'custo')::numeric, 0);
  update public.products set
    estoque_atual = estoque_atual + q,
    preco_custo = case when c > 0 then c else preco_custo end,
    updated_at = now()
   where id = prow.id;
  insert into public.stock_movements (tenant_id, product_id, tipo, qtd, user_id, origem, obs)
  values (t, prow.id, 'entrada', q, u,
          trim(coalesce('Compra' || case when coalesce(p->>'fornecedor','')='' then '' else ' · Fornecedor: '||(p->>'fornecedor') end || case when coalesce(p->>'nf','')='' then '' else ' · NF '||(p->>'nf') end, 'Compra')),
          coalesce(p->>'note',''));
  insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
  values (t, u, (select nome from public.users where id = u), 'estoque.entrada', 'product', prow.id::text, '+' || q::text || ' ' || prow.unidade);
  return jsonb_build_object('estoque', (select estoque_atual from public.products where id = prow.id));
end $$;

-- ---------- AJUSTE DE ESTOQUE (staff, motivado) ------------------------------
create or replace function public.stock_adjust(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t uuid := public.current_tenant_id(); u uuid := auth.uid();
  prow products%rowtype; d numeric(14,3); novo numeric(14,3); cfg jsonb;
begin
  if not public.is_staff() then raise exception 'FORBIDDEN'; end if;
  d := (p->>'delta')::numeric(14,3);
  if d = 0 or coalesce(p->>'reason','') = '' then raise exception 'VALIDATION'; end if;
  select * into prow from public.products where id = (p->>'productId')::uuid and tenant_id = t for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  select config into cfg from public.tenants where id = t;
  novo := prow.estoque_atual + d;
  if novo < 0 and coalesce((cfg->>'permiteEstoqueNegativo')::boolean,false) is false then raise exception 'STOCK_NEG'; end if;
  update public.products set estoque_atual = novo, updated_at = now() where id = prow.id;
  insert into public.stock_movements (tenant_id, product_id, tipo, qtd, user_id, origem, obs)
  values (t, prow.id, 'ajuste', d, u, p->>'reason', coalesce(p->>'note',''));
  insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
  values (t, u, (select nome from public.users where id = u), 'estoque.ajuste', 'product', prow.id::text, d::text || ' ' || prow.unidade || ' (' || (p->>'reason') || ')');
  return jsonb_build_object('estoque', novo);
end $$;

-- permissões de execução (authenticated)
grant execute on function public.commit_sale(jsonb)   to authenticated;
grant execute on function public.cancel_sale(jsonb)   to authenticated;
grant execute on function public.stock_entry(jsonb)   to authenticated;
grant execute on function public.stock_adjust(jsonb)  to authenticated;
