/* ==========================================================================
   LojaCerta · Landing
   Interações da página de marketing: header, menu mobile, planos, FAQ,
   legal, reveal-on-scroll e estado dos CTAs conforme sessão.
   ========================================================================== */
;(function () {
  'use strict';

  var wired = false;
  var io = null;

  var LEGAL = {
    termos: {
      title: 'Termos de uso',
      body: '<p><b>1. Objeto.</b> O LojaCerta, desenvolvido e operado pela <b>JR Sistemas e Tecnologia</b>, é um serviço de software (SaaS) para gestão de estoque, vendas e equipe para comércios. A criação de conta implica aceitação integral destes termos.</p>' +
        '<p><b>2. Conta e cadastro.</b> O contratante declara ser responsável pela veracidade dos dados informados. Cada empresa (CNPJ/CPF) deve manter sua própria conta; o compartilhamento de credenciais entre usuários distintos é de responsabilidade do titular da conta.</p>' +
        '<p><b>3. Planos, cobrança e renovação.</b> O período de teste tem 14 dias e não exige cartão. Após o teste, o uso contínuo depende da contratação de um plano, com cobrança recorrente (mensal ou anual) e renovação automática, podendo ser cancelada a qualquer momento pela própria interface. Durante o período de teste e até a integração de pagamentos, nenhuma cobrança é efetuada.</p>' +
        '<p><b>4. Uso aceitável.</b> É vedado usar o sistema para atividades ilícitas, tentar burlar limites do plano ou os mecanismos de segurança (incluindo acesso a dados de outras empresas), ou revender o serviço sem autorização por escrito.</p>' +
        '<p><b>5. Responsabilidades.</b> O LojaCerta se compromete a manter os dados com os cuidados técnicos de segurança praticados pelo mercado (criptografia em trânsito, isolamento por empresa via RLS e backups). O usuário é responsável pelo conteúdo que cadastra (produtos, preços, vendas) e por manter suas credenciais em sigilo. O serviço é fornecido "no estado em que se encontra", com esforço comercialmente razoável de disponibilidade, sem garantia de uptime absoluto.</p>' +
        '<p><b>6. Suporte.</b> O suporte é prestado pela central de tickets dentro do sistema, em horário comercial. Problemas críticos (loja impedida de vender) recebem prioridade máxima.</p>' +
        '<p><b>7. Suspensão e rescisão.</b> O acesso pode ser suspenso em caso de inadimplência (com aviso prévio e período de carência para exportação dos dados) ou uso indevido. A qualquer momento o usuário pode cancelar e exportar seus dados.</p>' +
        '<p><b>8. LGPD e dados.</b> Ver a Política de Privacidade. Os dados pertencem ao usuário; a JR Sistemas atua como operadora.</p>' +
        '<p><b>9. Foro.</b> Aplica-se a legislação brasileira, inclusive o Marco Civil da Internet e o Código de Defesa do Consumidor, com foro no domicílio do contratante consumidor.</p>' +
        '<p class="muted" style="font-size:.75rem">Documento-base gerado em 2026. Recomenda-se revisão por advogado antes de contratações empresariais de grande porte.</p>'
    },
    privacidade: {
      title: 'Privacidade e LGPD',
      body: '<p><b>Quem trata seus dados.</b> A JR Sistemas e Tecnologia (responsável pelo produto LojaCerta) trata os dados descritos abaixo como <b>operadora</b>, seguindo a Lei 13.709/2018 (LGPD).</p>' +
        '<p><b>O que coletamos:</b> (i) dados de cadastro — nome, e-mail, nome da empresa, CNPJ opcional; (ii) dados de uso do sistema — produtos, preços, estoque, vendas e equipe que VOCÊ cadastra; (iii) registros técnicos e de auditoria (ações realizadas, endereço IP nas requisições) para segurança e cumprimento de obrigações legais.</p>' +
        '<p><b>Para quê:</b> execução do contrato (prestação do serviço de gestão), segurança da informação, prevenção a fraudes, suporte ao usuário e comunicação sobre a própria conta. Não vendemos dados a terceiros.</p>' +
        '<p><b>Onde ficam:</b> os dados são armazenados em infraestrutura em nuvem (Supabase, região São Paulo — sa-east-1), com isolamento lógico por empresa (Row Level Security) e criptografia em trânsito (TLS).</p>' +
        '<p><b>Compartilhamento:</b> somente com fornecedores de infraestrutura necessários à operação (hospedagem, banco de dados, e-mail transacional) e por obrigação legal.</p>' +
        '<p><b>Seus direitos:</b> acesso, correção, portabilidade e exclusão dos dados — disponíveis de forma automatizada no sistema (Configurações → Dados), incluindo exportação completa em JSON/CSV e solicitação de exclusão com carência de 30 dias.</p>' +
        '<p><b>Retenção:</b> os dados permanecem enquanto a conta estiver ativa e, após exclusão, pelo período mínimo necessário a obrigações legais.</p>' +
        '<p><b>Contato do encarregado (DPO):</b> jrsistemasetecnologia.br@gmail.com</p>'
    }
  };

  function closeNav() {
    document.body.classList.remove('nav-open');
    var t = document.querySelector('[data-act="menu-toggle"]');
    if (t) { t.setAttribute('aria-expanded', 'false'); t.setAttribute('aria-label', 'Abrir menu de navegação'); }
  }

  function setCycle(cycle) {
    document.querySelectorAll('.seg-btn[data-cycle]').forEach(function (b) {
      var on = b.dataset.cycle === cycle;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    document.querySelectorAll('.plan-card').forEach(function (card) {
      var price = card.querySelector('.plan-price b');
      var note = card.querySelector('.plan-annual-note');
      if (!price) return;
      price.textContent = cycle === 'anual' ? price.dataset.anual : price.dataset.mensal;
      if (note) note.hidden = cycle !== 'anual';
    });
  }

  function openLegal(doc) {
    var d = LEGAL[doc];
    if (!d) return;
    UI.modal({ title: d.title, size: 'lg', body: raw('<div style="font-size:.875rem;line-height:1.7;color:var(--ink-2)">' + d.body + '</div>'), foot: raw('<button type="button" class="btn btn-primary" data-modal-close>Entendi</button>') });
  }

  function observeReveals(scope) {
    var els = (scope || document).querySelectorAll('.reveal:not(.in)');
    if (!('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('in'); });
      return;
    }
    if (!io) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
        });
      }, { threshold: 0.1, rootMargin: '0px 0px -4% 0px' });
    }
    els.forEach(function (el, i) {
      el.style.transitionDelay = Math.min(i * 55, 330) + 'ms';
      io.observe(el);
    });
  }

  function updateHeaderCta() {
    var loggedIn = !!(window.Auth && Auth.me && Auth.me());
    /* v1.9.1 · seletor estável (data-cta) — antes o href mudava e o 2º render
       não achava mais o link; inclui os botões do menu mobile */
    document.querySelectorAll('.nav-cta a[href="#/entrar"], .nav-cta a[href="#/app"], [data-cta]').forEach(function (a) {
      var isEntrar = a.getAttribute('data-cta') === 'entrar' || (!a.hasAttribute('data-cta') && a.classList.contains('btn-ghost'));
      if (!a.hasAttribute('data-cta')) a.setAttribute('data-cta', isEntrar ? 'entrar' : 'comecar');
    });
    document.querySelectorAll('.nav-cta a.btn-primary').forEach(function (a) { if (!a.hasAttribute('data-cta')) a.setAttribute('data-cta', 'comecar'); });
    document.querySelectorAll('[data-cta="entrar"]').forEach(function (a) { a.textContent = loggedIn ? 'Abrir sistema' : 'Entrar'; a.setAttribute('href', loggedIn ? '#/app' : '#/entrar'); });
    document.querySelectorAll('[data-cta="comecar"]').forEach(function (a) { a.textContent = loggedIn ? 'Meu painel' : 'Começar grátis'; a.setAttribute('href', loggedIn ? '#/app' : '#/cadastro'); });
  }

  function wire() {
    if (wired) return;
    wired = true;

    /* header com sombra ao rolar */
    var header = document.getElementById('site-header');
    var onScroll = function () { header.classList.toggle('scrolled', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    /* menu mobile */
    var backdrop = document.createElement('div');
    backdrop.className = 'nav-backdrop';
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', closeNav);
    /* Esc fecha; girar/aumentar a tela para desktop também fecha (menu não fica "preso") */
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && document.body.classList.contains('nav-open')) closeNav(); });
    window.addEventListener('resize', function () { if (window.innerWidth > 920 && document.body.classList.contains('nav-open')) closeNav(); });
    window.addEventListener('hashchange', closeNav);
    document.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-act="menu-toggle"]') : null;
      if (t) {
        var open = document.body.classList.toggle('nav-open');
        t.setAttribute('aria-expanded', open ? 'true' : 'false');
        t.setAttribute('aria-label', open ? 'Fechar menu de navegação' : 'Abrir menu de navegação');
        return;
      }
      if (e.target.closest && e.target.closest('#main-nav a')) closeNav();
      if (e.target.closest && e.target.closest('[data-act="chip-close"]')) {
        var chip = document.getElementById('demo-chip');
        if (chip) chip.classList.add('off');
        SafeStorage.set('obracerta:chip', 'off');
      }
      var legal = e.target.closest ? e.target.closest('[data-act="legal"]') : null;
      if (legal) { e.preventDefault(); openLegal(legal.dataset.doc); }
      var scrollA = e.target.closest ? e.target.closest('[data-scroll]') : null;
      if (scrollA) {
        e.preventDefault(); closeNav();
        var el = document.getElementById(scrollA.getAttribute('href').replace('#', ''));
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });

    /* ciclo de cobrança dos planos */
    document.querySelectorAll('.seg-btn[data-cycle]').forEach(function (b) {
      b.addEventListener('click', function () { setCycle(b.dataset.cycle); });
    });

    /* FAQ: apenas um aberto por vez */
    document.querySelectorAll('.faq-item').forEach(function (d) {
      d.addEventListener('toggle', function () {
        if (d.open) document.querySelectorAll('.faq-item[open]').forEach(function (o) { if (o !== d) o.open = false; });
      });
    });

    /* ano corrente + chip */
    var y = document.getElementById('year'); if (y) y.textContent = String(new Date().getFullYear());
    if (SafeStorage.get('obracerta:chip') === 'off') { var c = document.getElementById('demo-chip'); if (c) c.classList.add('off'); }

    Bus.on('store:changed', updateHeaderCta);
    updateHeaderCta();
    observeReveals(document);
  }

  function show() {
    document.body.classList.remove('is-app', 'no-scroll');
    document.body.classList.remove('drawer-open');
    var landing = document.getElementById('landing');
    var footer = document.getElementById('site-footer');
    var root = document.getElementById('view-root');
    if (landing) landing.classList.remove('hidden');
    if (footer) footer.classList.remove('hidden');
    if (root) { root.classList.add('hidden'); root.innerHTML = ''; }
    updateHeaderCta();
    observeReveals(document);
  }

  window.Landing = { wire: wire, show: show, setCycle: setCycle };
})();
