#!/usr/bin/env python3
"""Configura Supabase Auth: URLs, política de senha, notificações e templates de e-mail tematizados (pt-BR)."""
import json, urllib.request, urllib.error

TOKEN = open('/home/z/my-project/scripts/.sb_token').read().strip()
REF = 'qmqllssextbxwwphawod'
SITE = 'https://jrsistemasetecnologiabr-bit.github.io/Projeto-empresa'

def patch(payload):
    req = urllib.request.Request(
        f'https://api.supabase.com/v1/projects/{REF}/config/auth',
        data=json.dumps(payload).encode(),
        headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'},
        method='PATCH')
    try:
        with urllib.request.urlopen(req) as r:
            body = r.read().decode()
            print(f'HTTP {r.status} — {body[:150]}')
            return True
    except urllib.error.HTTPError as e:
        print(f'HTTP {e.code} — {e.read().decode()[:500]}')
        return False

# ---------- wrap HTML (mesma identidade visual do app) ----------
def wrap(title, body_html, preheader=''):
    return f'''<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{title}</title></head>
<body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0B1220">
<div style="display:none;max-height:0;overflow:hidden">{preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0">
<tr><td style="background:#0B1220;padding:20px 26px">
  <span style="color:#fff;font-weight:800;font-size:17px">Loja<span style="color:#FB923C">Certa</span></span>
  <span style="color:#64748B;font-size:11px;float:right;padding-top:5px">por JR Sistemas e Tecnologia</span>
</td></tr>
<tr><td style="padding:30px 26px">{body_html}</td></tr>
<tr><td style="padding:16px 26px;border-top:1px solid #e2e8f0;color:#64748B;font-size:11px;line-height:1.6">
Você recebe este e-mail por ter uma conta LojaCerta. Se não foi você, ignore ou fale com o suporte dentro do sistema.<br>
LojaCerta · JR Sistemas e Tecnologia · <a href="{SITE}/#/" style="color:#64748B">{SITE}</a>
</td></tr></table></td></tr></table></body></html>'''

def p(html): return f'<p style="margin:0 0 14px;font-size:14px;line-height:1.65;color:#334155">{html}</p>'
def btn(href, label): return f'<p style="margin:24px 0"><a href="{href}" style="background:#C2410C;color:#ffffff;text-decoration:none;padding:13px 24px;border-radius:10px;font-weight:700;font-size:14px;display:inline-block">{label}</a></p>'
def code_box(code): return f'<p style="margin:18px 0;text-align:center;font-size:30px;font-weight:800;letter-spacing:8px;color:#0B1220;background:#F1F5F9;border:1px dashed #CBD5E1;border-radius:12px;padding:14px">{code}</p>'

T = {}

# 1. Confirmação de e-mail (código de 6 dígitos + link — v5)
T['mailer_subjects_confirmation'] = 'LojaCerta — confirme seu e-mail (código válido por 10 minutos)'
T['mailer_templates_confirmation_content'] = wrap('Confirme seu e-mail',
    p('<b style="color:#0B1220">Falta um passo!</b> Confirme que este e-mail é seu para ativar sua conta LojaCerta e iniciar o teste grátis de 14 dias.') +
    p('Digite este código de 6 dígitos no aplicativo, na tela de confirmação:') +
    code_box('{{ .Token }}') +
    p('Prefere clicar? Confirme direto pelo botão abaixo:') +
    btn('{{ .ConfirmationURL }}', 'Confirmar meu e-mail') +
    p('O código e o link expiram em <b>10 minutos</b> e são de uso único. Após 5 tentativas erradas, solicite um novo código. Se não foi você quem criou a conta, apenas ignore este e-mail.'),
    'Confirme seu e-mail para ativar sua conta LojaCerta.')

# 2. Recuperação de senha
T['mailer_subjects_recovery'] = 'LojaCerta — redefinição de senha'
T['mailer_templates_recovery_content'] = wrap('Redefinição de senha',
    p('Recebemos um pedido de redefinição de senha para a sua conta.') +
    p('Se foi você, clique no botão abaixo para criar uma nova senha:') +
    btn('{{ .ConfirmationURL }}', 'Criar nova senha') +
    p('Link de uso único, válido por <b>1 hora</b>. Se não foi você, nenhuma ação é necessária — sua senha atual continua valendo.'),
    'Redefina sua senha do LojaCerta com segurança.')

# 3. Magic link
T['mailer_subjects_magic_link'] = 'LojaCerta — seu link de acesso'
T['mailer_templates_magic_link_content'] = wrap('Seu link de acesso',
    p('Use o botão abaixo para entrar no LojaCerta sem digitar senha. O link expira em <b>1 hora</b>.') +
    btn('{{ .ConfirmationURL }}', 'Entrar no LojaCerta') +
    p('Se não foi você, ignore este e-mail.'),
    'Entre no LojaCerta com um clique.')

# 4. Troca de e-mail (confirmação no novo endereço)
T['mailer_subjects_email_change'] = 'LojaCerta — confirme seu novo e-mail'
T['mailer_templates_email_change_content'] = wrap('Confirmar novo e-mail',
    p('Este endereço será o novo acesso da sua conta LojaCerta. Confirme para concluir a troca:') +
    btn('{{ .ConfirmationURL }}', 'Confirmar novo e-mail') +
    p('Link de uso único, válido por 1 hora.'),
    'Confirme a troca de e-mail da sua conta.')

# 5. Notificação: e-mail alterado
T['mailer_subjects_email_changed_notification'] = '[Segurança] LojaCerta — e-mail da conta alterado'
T['mailer_templates_email_changed_notification_content'] = wrap('Seu e-mail foi alterado',
    p('O e-mail de acesso da sua conta LojaCerta foi alterado com sucesso.') +
    p('Se não reconhece esta ação, <b>redefina sua senha imediatamente</b> e abra um ticket de suporte no sistema (menu <b>Suporte</b>).'),
    'Aviso de segurança: e-mail alterado.')

# 6. Notificação: senha alterada
T['mailer_subjects_password_changed_notification'] = '[Segurança] LojaCerta — sua senha foi alterada'
T['mailer_templates_password_changed_notification_content'] = wrap('Sua senha foi alterada',
    p('A senha da sua conta LojaCerta foi alterada com sucesso em <b>{{ .Timestamp }}</b>.') +
    p('Se não foi você, <b>redefina a senha imediatamente</b> pelo link "Esqueci minha senha" na tela de login e abra um ticket de suporte.'),
    'Aviso de segurança: senha alterada.')

# 7. Convite de equipe
T['mailer_subjects_invite'] = 'Você foi convidado para o LojaCerta 🎉'
T['mailer_templates_invite_content'] = wrap('Convite para o LojaCerta',
    p('Olá! Você foi convidado(a) para fazer parte da equipe de uma loja no LojaCerta — o sistema de gestão de estoque e vendas da JR Sistemas e Tecnologia.') +
    btn('{{ .InvitationUrl }}', 'Aceitar convite e definir senha') +
    p('Ao aceitar, você define sua senha e entra direto no painel da loja. O convite expira em <b>7 dias</b>.'),
    'Você foi convidado para o LojaCerta.')

# 8. Reautenticação (código)
T['mailer_subjects_reauthentication'] = 'LojaCerta — código de verificação'
T['mailer_templates_reauthentication_content'] = wrap('Código de verificação',
    p('Use o código abaixo para confirmar sua identidade. Ele expira em alguns minutos e pode ser usado uma única vez.') +
    code_box('{{ .Token }}'),
    'Seu código de verificação LojaCerta.')

# 9. Notificações de segurança diversas
T['mailer_subjects_identity_linked_notification'] = '[Segurança] LojaCerta — novo método de acesso vinculado'
T['mailer_templates_identity_linked_notification_content'] = wrap('Novo método de acesso',
    p('Uma conta <b>{{ .Provider }}</b> foi vinculada à sua conta LojaCerta. Se não foi você, remova o vínculo nas configurações e altere sua senha.'),
    'Aviso de segurança.')
T['mailer_subjects_identity_unlinked_notification'] = '[Segurança] LojaCerta — método de acesso removido'
T['mailer_templates_identity_unlinked_notification_content'] = wrap('Método de acesso removido',
    p('Uma conta <b>{{ .Provider }}</b> foi desvinculada da sua conta LojaCerta. Se não foi você, altere sua senha e contate o suporte.'),
    'Aviso de segurança.')
T['mailer_subjects_mfa_factor_enrolled_notification'] = '[Segurança] LojaCerta — novo fator de autenticação'
T['mailer_templates_mfa_factor_enrolled_notification_content'] = wrap('Novo fator de autenticação',
    p('Um novo fator de verificação ({{ .FactorName }}) foi adicionado à sua conta. Se não foi você, remova-o nas configurações de segurança.'),
    'Aviso de segurança.')
T['mailer_subjects_mfa_factor_unenrolled_notification'] = '[Segurança] LojaCerta — fator de autenticação removido'
T['mailer_templates_mfa_factor_unenrolled_notification_content'] = wrap('Fator removido',
    p('O fator de verificação ({{ .FactorName }}) foi removido da sua conta. Se não foi você, contate o suporte imediatamente.'),
    'Aviso de segurança.')
T['mailer_subjects_phone_changed_notification'] = '[Segurança] LojaCerta — telefone alterado'
T['mailer_templates_phone_changed_notification_content'] = wrap('Telefone alterado',
    p('O telefone da sua conta LojaCerta foi alterado. Se não foi você, altere sua senha e contate o suporte.'),
    'Aviso de segurança.')

# ---------- 1ª PATCH: configurações básicas ----------
basic = {
    'site_url': SITE,
    'uri_allow_list': ','.join([
        SITE,
        SITE + '/#/entrar',
        SITE + '/#/redefinir',
        SITE + '/#/confirmar-email',
        SITE + '/#/confirmar-codigo',
        SITE + '/#/definir-senha',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
    ]),
    'password_min_length': 8,
    # v5: confirmação de e-mail obrigatória + código de 6 dígitos com validade
    # de 10 minutos (uso único; limite de tentativas controlado pelo GoTrue)
    'mailer_otp_exp': 600,
    'mailer_notifications_password_changed_enabled': True,
    'mailer_notifications_email_changed_enabled': True,
    # v5: SEM autoconfirm — a conta (e o teste grátis) só ativa após confirmar o
    # e-mail. O envio usa o e-mail interno do Supabase até ligarem SMTP próprio.
    'mailer_autoconfirm': False,
}
print('— Config básica —')
ok1 = patch(basic)

# ---------- 2ª PATCH: templates ----------
if ok1:
    print('— Templates de e-mail —')
    patch(T)
