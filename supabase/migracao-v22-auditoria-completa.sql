-- LojaCerta · migração v22 — auditoria completa no servidor (v2.0.2) — APLICADA
--   (v22 + v22b no histórico do Supabase; este arquivo já contém as duas)
-- Antes: o modo demo gravava "produto.inativado/editado/criado", mas em
-- produção o app altera products/customers/quotes/tenants direto via REST e
-- nada ia para audit_logs. Agora gatilhos no banco registram toda ação
-- sensível, seja qual for a origem (app, Edge, SQL) — não dá para "pular".
-- Movimento de estoque continua auditado pelas RPCs (stock_entry/adjust,
-- commit_sale/cancel_sale); por isso o gatilho de products ignora mudança
-- só de estoque_atual. Idempotente.

-- ---------------------------------------------------------------------
-- helper interno (não exposto à API)
-- ---------------------------------------------------------------------
create or replace function public.audit_put(p_tenant uuid, p_acao text, p_entidade text, p_id text, p_det text, p_user uuid default null)
returns void language plpgsql security definer set search_path = 'public' as $$
declare u uuid := coalesce(p_user, auth.uid()); who text;
begin
  if p_tenant is null then return; end if;
  -- exclusão da loja (cascade/LGPD): a loja já não existe, não há onde auditar
  -- (sem isto, apagar uma loja falhava na FK de audit_logs — corrigido em v22b)
  if not exists (select 1 from public.tenants where id = p_tenant) then return; end if;
  select nome into who from public.users where id = u;
  insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes, origem)
  values (p_tenant, u, coalesce(who, case when u is null then 'servidor (service role)' end, ''),
          p_acao, p_entidade, p_id, left(coalesce(p_det, ''), 500),
          'db');
end $$;
revoke all on function public.audit_put(uuid, text, text, text, text, uuid) from public, anon, authenticated;

-- "campo: antes→depois" só quando mudou
create or replace function public.audit_diff(p_label text, p_old text, p_new text)
returns text language sql immutable set search_path = '' as $$
  select case when p_old is distinct from p_new
    then p_label || ': ' || coalesce(nullif(p_old, ''), '—') || '→' || coalesce(nullif(p_new, ''), '—') end
$$;
revoke all on function public.audit_diff(text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- produtos
-- ---------------------------------------------------------------------
create or replace function public.audit_products() returns trigger
language plpgsql security definer set search_path = 'public' as $$
declare bits text[];
begin
  if tg_op = 'INSERT' then
    perform public.audit_put(new.tenant_id, 'produto.criado', 'product', new.id::text,
      new.codigo || ' · ' || new.nome || ' · R$ ' || new.preco_venda::text ||
      case when new.estoque_atual <> 0 then ' · estoque inicial ' || new.estoque_atual::text else '' end);
    return new;
  end if;
  if new.ativo is distinct from old.ativo then
    perform public.audit_put(new.tenant_id, case when new.ativo then 'produto.reativado' else 'produto.inativado' end,
      'product', new.id::text, new.codigo || ' · ' || new.nome);
  end if;
  bits := array_remove(array[
    public.audit_diff('nome', old.nome, new.nome),
    public.audit_diff('código', old.codigo, new.codigo),
    public.audit_diff('preço', old.preco_venda::text, new.preco_venda::text),
    public.audit_diff('custo', old.preco_custo::text, new.preco_custo::text),
    public.audit_diff('categoria', old.category_id::text, new.category_id::text),
    public.audit_diff('unidade', old.unidade, new.unidade),
    public.audit_diff('mínimo', old.estoque_minimo::text, new.estoque_minimo::text),
    public.audit_diff('fornecedor', old.fornecedor, new.fornecedor),
    public.audit_diff('NCM', old.ncm, new.ncm),
    public.audit_diff('CFOP', old.cfop, new.cfop),
    public.audit_diff('CSOSN', old.csosn, new.csosn),
    public.audit_diff('CEST', old.cest, new.cest),
    public.audit_diff('origem', old.origem::text, new.origem::text)
  ], null);
  if cardinality(bits) > 0 then
    perform public.audit_put(new.tenant_id, 'produto.editado', 'product', new.id::text,
      new.nome || ' · ' || array_to_string(bits, ' · '));
  end if;
  return new;
end $$;
drop trigger if exists trg_audit_products on public.products;
create trigger trg_audit_products after insert or update on public.products
  for each row execute function public.audit_products();

-- ---------------------------------------------------------------------
-- categorias
-- ---------------------------------------------------------------------
create or replace function public.audit_categories() returns trigger
language plpgsql security definer set search_path = 'public' as $$
begin
  if tg_op = 'INSERT' then
    perform public.audit_put(new.tenant_id, 'categoria.criada', 'category', new.id::text, new.nome);
  elsif tg_op = 'UPDATE' then
    if new.nome is distinct from old.nome then
      perform public.audit_put(new.tenant_id, 'categoria.editada', 'category', new.id::text, public.audit_diff('nome', old.nome, new.nome));
    end if;
  else
    perform public.audit_put(old.tenant_id, 'categoria.excluida', 'category', old.id::text, old.nome);
    return old;
  end if;
  return new;
end $$;
drop trigger if exists trg_audit_categories on public.categories;
create trigger trg_audit_categories after insert or update or delete on public.categories
  for each row execute function public.audit_categories();

-- ---------------------------------------------------------------------
-- clientes
-- ---------------------------------------------------------------------
create or replace function public.audit_customers() returns trigger
language plpgsql security definer set search_path = 'public' as $$
declare bits text[];
begin
  if tg_op = 'INSERT' then
    perform public.audit_put(new.tenant_id, 'cliente.criado', 'customer', new.id::text,
      new.nome || case when new.limite_credito > 0 then ' · limite R$ ' || new.limite_credito::text else '' end);
    return new;
  end if;
  if new.ativo is distinct from old.ativo then
    perform public.audit_put(new.tenant_id, case when new.ativo then 'cliente.reativado' else 'cliente.inativado' end,
      'customer', new.id::text, new.nome);
  end if;
  bits := array_remove(array[
    public.audit_diff('nome', old.nome, new.nome),
    public.audit_diff('documento', old.documento, new.documento),
    public.audit_diff('limite de crédito', old.limite_credito::text, new.limite_credito::text),
    public.audit_diff('telefone', old.telefone, new.telefone),
    public.audit_diff('e-mail', old.email, new.email)
  ], null);
  if cardinality(bits) > 0 then
    perform public.audit_put(new.tenant_id, 'cliente.editado', 'customer', new.id::text,
      new.nome || ' · ' || array_to_string(bits, ' · '));
  end if;
  return new;
end $$;
drop trigger if exists trg_audit_customers on public.customers;
create trigger trg_audit_customers after insert or update on public.customers
  for each row execute function public.audit_customers();

-- ---------------------------------------------------------------------
-- financeiro (lançamento manual; a baixa já é auditada por fin_settle e o
-- fiado nasce dentro de commit_sale, já auditado como venda)
-- ---------------------------------------------------------------------
create or replace function public.audit_receivables() returns trigger
language plpgsql security definer set search_path = 'public' as $$
begin
  if new.sale_id is null then
    perform public.audit_put(new.tenant_id, 'financeiro.receber_criado', 'receber', new.id::text,
      coalesce(new.descricao, '') || ' · R$ ' || new.valor::text || ' · vence ' || new.vencimento::text);
  end if;
  return new;
end $$;
drop trigger if exists trg_audit_receivables on public.receivables;
create trigger trg_audit_receivables after insert on public.receivables
  for each row execute function public.audit_receivables();

create or replace function public.audit_payables() returns trigger
language plpgsql security definer set search_path = 'public' as $$
begin
  perform public.audit_put(new.tenant_id, 'financeiro.pagar_criado', 'pagar', new.id::text,
    coalesce(new.descricao, '') || coalesce(' · ' || nullif(new.fornecedor, ''), '') || ' · R$ ' || new.valor::text || ' · vence ' || new.vencimento::text);
  return new;
end $$;
drop trigger if exists trg_audit_payables on public.payables;
create trigger trg_audit_payables after insert on public.payables
  for each row execute function public.audit_payables();

-- ---------------------------------------------------------------------
-- orçamentos
-- ---------------------------------------------------------------------
create or replace function public.audit_quotes() returns trigger
language plpgsql security definer set search_path = 'public' as $$
begin
  if tg_op = 'INSERT' then
    perform public.audit_put(new.tenant_id, 'orcamento.criado', 'quote', new.id::text,
      coalesce(new.numero, '') || ' · ' || coalesce(nullif(new.cliente_nome, ''), 'consumidor') || ' · R$ ' || new.total::text);
  elsif new.status is distinct from old.status then
    perform public.audit_put(new.tenant_id, 'orcamento.' || new.status, 'quote', new.id::text,
      coalesce(new.numero, '') || ' · ' || public.audit_diff('status', old.status, new.status));
  end if;
  return new;
end $$;
drop trigger if exists trg_audit_quotes on public.quotes;
create trigger trg_audit_quotes after insert or update on public.quotes
  for each row execute function public.audit_quotes();

-- ---------------------------------------------------------------------
-- dados e configurações da loja (cobrança já tem audit_tenants_billing)
-- ---------------------------------------------------------------------
create or replace function public.audit_tenants_config() returns trigger
language plpgsql security definer set search_path = 'public' as $$
declare bits text[];
begin
  bits := array_remove(array[
    public.audit_diff('nome', old.nome, new.nome),
    public.audit_diff('CNPJ', old.cnpj, new.cnpj),
    public.audit_diff('endereço', old.endereco, new.endereco),
    public.audit_diff('telefone', old.telefone, new.telefone),
    public.audit_diff('segmento', old.segmento, new.segmento),
    public.audit_diff('desconto máx. do caixa (%)', old.config->>'descontoCaixaPct', new.config->>'descontoCaixaPct'),
    public.audit_diff('estoque negativo', old.config->>'permiteEstoqueNegativo', new.config->>'permiteEstoqueNegativo'),
    public.audit_diff('mensagem do recibo', old.config->>'reciboMsg', new.config->>'reciboMsg')
  ], null);
  if cardinality(bits) > 0 then
    perform public.audit_put(new.id, 'config.atualizada', 'tenant', new.id::text, array_to_string(bits, ' · '));
  end if;
  return new;
end $$;
drop trigger if exists trg_audit_tenants_config on public.tenants;
create trigger trg_audit_tenants_config after update on public.tenants
  for each row execute function public.audit_tenants_config();

-- ---------------------------------------------------------------------
-- convites de usuário (feitos pela Edge com service role)
-- ---------------------------------------------------------------------
create or replace function public.audit_user_invites() returns trigger
language plpgsql security definer set search_path = 'public' as $$
begin
  if tg_op = 'INSERT' then
    perform public.audit_put(new.tenant_id, 'usuario.convidado', 'invite', new.id::text,
      new.nome || ' <' || new.email || '> · papel ' || new.papel, new.invited_by);
  elsif new.revoked_at is not null and old.revoked_at is null then
    perform public.audit_put(new.tenant_id, 'usuario.convite_revogado', 'invite', new.id::text,
      new.nome || ' <' || new.email || '>');
  end if;
  return new;
end $$;
drop trigger if exists trg_audit_user_invites on public.user_invites;
create trigger trg_audit_user_invites after insert or update on public.user_invites
  for each row execute function public.audit_user_invites();

revoke all on function public.audit_products(), public.audit_categories(), public.audit_customers(),
  public.audit_receivables(), public.audit_payables(), public.audit_quotes(), public.audit_tenants_config(),
  public.audit_user_invites() from public, anon, authenticated;
