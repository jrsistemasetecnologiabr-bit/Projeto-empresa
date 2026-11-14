/* ==========================================================================
   LojaCerta · EmailService — templates + fila + adapter de envio
   --------------------------------------------------------------------------
   EmailService.send(kind, to, ctx) monta o template, registra no outbox
   (estado 'queued' → adapter entrega) e retorna {id,status}.
   · MockOutboxAdapter (demo/dev): entrega na "Caixa de saída local"
     (Configurações → Emails dev), com links de token clicáveis — substituído
     em produção pelo provider real, sem mudar nenhuma chamada.
   · ResendEmailAdapter / BrevoEmailAdapter / SesEmailAdapter: implementar
     POST server-side (Edge Function) — esqueleto em INTEGRATIONS.md.
   ========================================================================== */
;(function () {
  'use strict';

  function wrap(title, bodyHtml, preheader) {
    return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>' + U.esc(title) + '</title></head>' +
      '<body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0B1220">' +
      '<div style="display:none;max-height:0;overflow:hidden">' + U.esc(preheader || '') + '</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px">' +
      '<tr><td align="center"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0">' +
      '<tr><td style="background:#0B1220;padding:18px 26px"><span style="color:#fff;font-weight:800;font-size:16px">Loja<span style="color:#FB923C">Certa</span></span></td></tr>' +
      '<tr><td style="padding:28px 26px">' + bodyHtml + '</td></tr>' +
      '<tr><td style="padding:16px 26px;border-top:1px solid #e2e8f0;color:#64748B;font-size:11px;line-height:1.6">Você recebe este e-mail por ter uma conta LojaCerta. ' +
      'Se não foi você, ignore ou fale com o suporte dentro do sistema.<br>LojaCerta · JR Sistemas e Tecnologia · <a href="' + U.esc(appUrl('#/')) + '" style="color:#64748B">preferências</a></td></tr>' +
      '</table></td></tr></table></body></html>';
  }
  function btn(href, label) {
    return '<p style="margin:22px 0"><a href="' + U.esc(href) + '" style="background:#C2410C;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;font-size:14px;display:inline-block">' + U.esc(label) + '</a></p>';
  }
  function p(html) { return '<p style="margin:0 0 12px;font-size:14px;line-height:1.65;color:#334155">' + html + '</p>'; }
  /* URL pública do site: injetada pelo build ({{SITE_URL}}) e usada em todos os links */
  function appUrl(hash) {
    var base = (window.Config && Config.siteUrl) || 'https://jrsistemasetecnologiabr-bit.github.io/Projeto-empresa';
    return base.replace(/\/+$/, '') + '/' + String(hash || '').replace(/^\/+/, '');
  }

  var TEMPLATES = {
    confirm_email: function (ctx) {
      return { subject: 'Confirme seu e-mail para ativar sua conta', html: wrap('Confirme seu e-mail',
        p('Olá' + (ctx.nome ? ', <b>' + U.esc(ctx.nome) + '</b>' : '') + '! Falta um passo: confirme que este e-mail é seu.') +
        btn(appUrl('#/confirmar-email?token=' + ctx.token), 'Confirmar meu e-mail') +
        (ctx.code ? '<p style="margin:18px 0 6px;font-size:13px;color:#334155">Ou informe este código de 6 dígitos no aplicativo:</p><p style="margin:0 0 18px;text-align:center;font-size:30px;font-weight:800;letter-spacing:8px;color:#0B1220;background:#F1F5F9;border:1px dashed #CBD5E1;border-radius:12px;padding:12px">' + U.esc(ctx.code) + '</p>' : '') +
        p('O código e o link expiram em <b>10 minutos</b> e só podem ser usados uma vez. Após 5 tentativas erradas, solicite um novo código. O teste grátis de 14 dias começa somente após a confirmação.'),
        'Confirme seu e-mail para ativar a conta.') };
    },
    welcome: function () {
      return { subject: 'Bem-vindo(a) ao LojaCerta 🎉', html: wrap('Boas-vindas',
        p('Sua conta está confirmada! Aproveite o teste grátis de 14 dias com todos os recursos liberados.') +
        btn(appUrl('#/entrar'), 'Entrar no sistema') +
        p('Dúvidas? Responda este e-mail ou chame no WhatsApp do suporte.'), 'Sua conta está ativa.') };
    },
    password_reset: function (ctx) {
      return { subject: 'Redefina sua senha do LojaCerta', html: wrap('Redefinição de senha',
        p('Recebemos um pedido de redefinição de senha para sua conta. Se foi você, clique abaixo:') +
        btn(appUrl('#/redefinir?token=' + ctx.token), 'Criar nova senha') +
        p('Link de uso único, válido por <b>1 hora</b>. Se não foi você, nenhum ação é necessária — sua senha atual continua valendo.'),
        'Redefina sua senha com segurança.') };
    },
    password_changed: function () {
      return { subject: '[Segurança] Sua senha foi alterada', html: wrap('Senha alterada',
        p('A senha da sua conta foi alterada com sucesso. Se você não reconhece esta ação, <b>redefina a senha imediatamente</b> e fale com o suporte.'),
        'Aviso de segurança: senha alterada.') };
    },
    email_change_confirm: function (ctx) {
      return { subject: 'Confirme seu novo e-mail', html: wrap('Confirmação de novo e-mail',
        p('Este e-mail será o novo acesso da sua conta LojaCerta. Confirme para concluir a troca:') +
        btn(appUrl('#/confirmar-email?tipo=mudanca&token=' + ctx.token), 'Confirmar novo e-mail') +
        p('Link de uso único, válido por 1 hora.'), 'Confirme a troca de e-mail.') };
    },
    security_alert: function (ctx) {
      return { subject: '[Segurança] ' + (ctx.motivo || 'Atividade na sua conta'), html: wrap('Aviso de segurança',
        p('Detectamos: <b>' + U.esc(ctx.motivo || 'atividade') + '</b>. Se não foi você, proteja sua conta agora.'),
        'Aviso de segurança da sua conta.') };
    },
    security_login: function (ctx) {
      return { subject: '[Segurança] Novo acesso à sua conta', html: wrap('Novo acesso',
        p('Olá, ' + U.esc(ctx.nome || '') + '. Um acesso foi realizado em <b>' + U.esc(ctx.quando || '') + '</b>. Se não foi você, altere sua senha.'),
        'Aviso de novo acesso.') };
    },
    payment_received: function (ctx) {
      return { subject: 'Pagamento confirmado — plano ' + (ctx.plano || ''), html: wrap('Pagamento confirmado',
        p('Recebemos o pagamento da sua assinatura <b>' + U.esc(ctx.plano || '') + '</b> (' + U.esc(ctx.valor || '') + '). Obrigado!') +
        btn(appUrl('#/app/assinatura'), 'Ver minha assinatura'), 'Recibo da sua assinatura.') };
    },
    payment_failed: function (ctx) {
      return { subject: 'Pagamento pendente — regularize para não perder acesso', html: wrap('Pagamento pendente',
        p('Não conseguimos confirmar o pagamento da sua assinatura. Você tem <b>3 dias</b> de carência; depois o PDV entra em modo leitura.') +
        btn(appUrl('#/app/assinatura'), 'Regularizar pagamento'), 'Ação necessária: pagamento pendente.') };
    },
    subscription_canceled: function (ctx) {
      return { subject: 'Assinatura cancelada — seus dados ficam disponíveis', html: wrap('Assinatura cancelada',
        p('Sua assinatura foi cancelada. Conforme a LGPD, você pode exportar todos os seus dados por <b>30 dias</b> em Configurações → Dados.'),
        'Confirmação de cancelamento.') };
    },
    trial_ending: function (ctx) {
      return { subject: 'Seu teste grátis termina em ' + (ctx.dias || '') + ' dia(s)', html: wrap('Trial terminando',
        p('Escolha um plano para continuar vendendo sem interrupção — leva 1 minuto.') +
        btn(appUrl('#/app/assinatura'), 'Escolher meu plano'), 'Seu teste grátis está terminando.') };
    }
  };

  var MockOutboxAdapter = {
    deliver: function (msg) { msg.status = 'sent'; msg.sentAt = Date.now(); return msg; }
  };

  var EmailService = {
    adapter: MockOutboxAdapter,
    templates: TEMPLATES,
    send: function (kind, to, ctx) {
      var t = TEMPLATES[kind];
      if (!t) throw ApiError('EMAIL_TEMPLATE', 'Template desconhecido: ' + kind);
      var built = t(ctx || {});
      var s = Store.state;
      if (!s.auth) s.auth = { accounts: [], tokens: [], throttle: {}, webhookEvents: [], subEvents: [] };
      if (!s.auth.outbox) s.auth.outbox = [];
      var msg = { id: 'mail_' + Date.now() + '_' + Math.floor(Math.random() * 999), kind: kind, to: to, subject: built.subject, html: built.html, ctx: ctx || {}, at: Date.now(), status: 'queued' };
      s.auth.outbox.unshift(msg);
      if (s.auth.outbox.length > 60) s.auth.outbox.length = 60;
      try { this.adapter.deliver(msg); } catch (e) { msg.status = 'failed'; msg.error = String(e.message || e); }
      Store.persist();
      Bus.emit('email:sent', msg);
      return msg;
    },
    outbox: function () { return (Store.state.auth && Store.state.auth.outbox) || []; }
  };

  window.EmailService = EmailService;
  window.EmailTemplates = TEMPLATES;
})();
