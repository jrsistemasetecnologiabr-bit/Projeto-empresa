-- LojaCerta · migração v20 — conta criada já confirmada quebrava o cadastro (aplicada)
-- Bug: em handle_new_user, `if v_pending and aud.id is not null` lia o record
-- "aud" mesmo quando v_pending = false (PL/pgSQL não garante curto-circuito) →
-- ERRO 55000 "record aud is not assigned yet". Efeito: criar usuário pelo painel
-- do Supabase (Add user → Auto confirm) falhava. Achado no teste E2E do go-live.
do $$
declare def text; novo text;
begin
  def := pg_get_functiondef('public.handle_new_user'::regproc);
  novo := replace(def,
    'if v_pending and aud.id is not null then',
    'if v_pending then if aud.id is not null then');
  novo := replace(novo,
    E'     where id = aud.id;\n  end if;',
    E'     where id = aud.id;\n  end if; end if;');
  if novo = def then raise exception 'v20: âncora não encontrada'; end if;
  execute novo;
end $$;
