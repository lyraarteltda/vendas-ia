/**
 * Vendas IA — Main Application Logic
 *
 * Sales analysis from the REAL export of the member's sales platform (Hotmart,
 * Kiwify, Eduzz, Monetizze, Ticto, Stripe or any sales sheet, .csv/.xlsx).
 * Everything that is a number is computed HERE, row by row: column mapping,
 * status normalization, gross/net revenue, refunds, chargebacks, Pix/boleto
 * conversion, product/payment/origin/affiliate mix, daily series, weekday×hour
 * map, multi-product buyers, money left on the table and period comparison.
 * The model (BYOK, OpenRouter — Hard Rules #1/#19) is used only for language:
 * (1) optionally help read unknown column headers (headers + masked samples),
 * (2) write the diagnosis from the computed aggregates. No buyer data (name,
 * e-mail, phone) ever leaves the browser. Percentages and R$ values the model
 * writes are checked against the computed ones and flagged when they do not match.
 * The only backend is the shared n8n gate/webhooks. No Supabase in the browser.
 */
const App = (function () {
  'use strict';

  // ── slot names (COR-025: never `*KEY = '<hyphenated literal>'`) ──
  var LIST_SLOT = 'vendas_periodos';
  var CURRENT_SLOT = 'vendas_atual';

  var MAX_ROWS = 20000;
  var MAX_COLS = 80;
  var MAX_CELL = 400;
  var MAX_PERIODS = 12;

  var FIELDS = [
    { id: 'data', label: 'Data da venda', req: true, note: 'quando o pedido foi feito' },
    { id: 'status', label: 'Status da venda', req: true, note: 'aprovada, reembolsada, expirada…' },
    { id: 'produto', label: 'Produto', note: 'nome do produto ou oferta' },
    { id: 'bruto', label: 'Valor pago (bruto)', req: true, note: 'quanto o cliente pagou' },
    { id: 'liquido', label: 'Valor líquido', note: 'o que caiu para você (comissão do produtor)' },
    { id: 'pagamento', label: 'Meio de pagamento', note: 'cartão, Pix, boleto' },
    { id: 'parcelas', label: 'Parcelas', note: 'nº de parcelas no cartão' },
    { id: 'origem', label: 'Origem (UTM source / SCK / src)', note: 'de onde veio a venda' },
    { id: 'campanha', label: 'Campanha (UTM campaign)', note: '' },
    { id: 'afiliado', label: 'Afiliado', note: 'vazio = venda direta' },
    { id: 'cupom', label: 'Cupom', note: '' },
    { id: 'comprador', label: 'Comprador (e-mail)', note: 'só para contar quem comprou mais de um produto' },
    { id: 'transacao', label: 'Código da transação', note: 'para tirar linhas duplicadas' }
  ];
  var BUCKETS = [
    { id: 'aprovada', label: 'Aprovada (dinheiro entrou)' },
    { id: 'reembolso', label: 'Reembolsada' },
    { id: 'chargeback', label: 'Chargeback / disputa' },
    { id: 'nao_paga', label: 'Não paga (expirada, recusada, cancelada)' },
    { id: 'pendente', label: 'Pendente (aguardando pagamento)' },
    { id: 'ignorar', label: 'Ignorar esta linha' }
  ];
  var BUCKET_SHORT = { aprovada: 'Aprovada', reembolso: 'Reembolso', chargeback: 'Chargeback', nao_paga: 'Não paga', pendente: 'Pendente', ignorar: 'Ignorada', desconhecido: 'A definir' };
  var METHOD_LABEL = { cartao: 'Cartão de crédito', pix: 'Pix', boleto: 'Boleto', paypal: 'PayPal', debito: 'Cartão de débito', carteira: 'Carteira digital', '': 'Não informado' };
  var WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  var WEEKDAYS_LONG = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  var MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  var NO_ORIGIN = '(sem origem / direto)';
  var NO_AFF = 'Venda direta (sem afiliado)';
  var NO_PRODUCT = '(produto não informado)';

  var C = { ink: '#1d1914', ink2: '#4a4038', claret: '#8f1d3a', blue: '#12508c', up: '#17703f', down: '#b32a1e', rule: '#d9bfa8', paper: '#fcefe2', paper2: '#f6e1cd', grid: '#e3c9b2' };

  var state = { per: null, raw: null, wired: false, running: false, wiping: false, m: null, cmp: null };

  // ───────────────────────── utils ─────────────────────────
  function $(id) { return document.getElementById(id); }
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2800);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function clean(v) {
    var s = String(v == null ? '' : v).trim();
    return /^(null|undefined|n\/a|none|-)$/i.test(s) ? '' : s; // COR-015
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function fold(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function slug(s) { return fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'vendas'; }
  function plural(n, one, many) { return fmtInt(n) + ' ' + (n === 1 ? one : many); }
  function shortTxt(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); n = n || 60; return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; }
  function colLetter(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  var NF0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
  var NF1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var NF2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function fmtInt(n) { return NF0.format(Math.round(n || 0)); }
  function brl(v) { return 'R$ ' + NF0.format(Math.round(v || 0)); }
  function brl2(v) { return 'R$ ' + NF2.format(v || 0); }
  function brlShort(v) { v = v || 0; if (Math.abs(v) >= 1e6) return 'R$ ' + NF1.format(v / 1e6) + ' mi'; if (Math.abs(v) >= 1e4) return 'R$ ' + NF0.format(v / 1e3) + ' mil'; if (Math.abs(v) >= 1e3) return 'R$ ' + NF1.format(v / 1e3) + ' mil'; return 'R$ ' + NF0.format(v); }
  function pct1(a, b) { return b ? a * 100 / b : 0; }
  function fmtPct(x) { return NF1.format(x || 0) + '%'; }
  function pad2(n) { return ('0' + n).slice(-2); }
  function dmy(t) { var d = new Date(t); return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear(); }
  function dm(t) { var d = new Date(t); return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1); }
  function today() { return dmy(Date.now()); }
  function dayKey(t) { var d = new Date(t); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
  function hash(s) { var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
  function dateline() { var d = new Date(); return d.getDate() + ' de ' + MONTHS[d.getMonth()] + ' de ' + d.getFullYear(); }

  // ───────────────────────── storage ─────────────────────────
  function loadList() { try { return JSON.parse(localStorage.getItem(LIST_SLOT) || '[]'); } catch (e) { return []; } }
  var saveTimer = null;
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300); }
  function saveNow() {
    clearTimeout(saveTimer);
    var p = state.per; if (!p || !p.recs || !p.recs.length) return;
    p.updatedAt = Date.now();
    var list = loadList().filter(function (x) { return x.id !== p.id; });
    list.unshift(p);
    list = list.slice(0, MAX_PERIODS);
    for (var keep = list.length; keep >= 1; keep--) {
      try {
        localStorage.setItem(LIST_SLOT, JSON.stringify(list.slice(0, keep)));
        localStorage.setItem(CURRENT_SLOT, p.id);
        if (keep < list.length) toast('Espaço do navegador cheio: guardei só os ' + keep + ' períodos mais recentes.');
        return;
      } catch (e) { /* try with fewer periods */ }
    }
    toast('Este período é grande demais para salvar no navegador — exporte o CSV normalizado ao terminar.');
  }
  function getPeriod(id) { return loadList().filter(function (x) { return x.id === id; })[0] || null; }
  function newPeriod() {
    return { id: uid(), nome: '', file: '', platform: '', createdAt: Date.now(), updatedAt: Date.now(), headers: [], map: {}, statusMap: {}, dicts: null, recs: [], stats: null, report: null, compareId: '' };
  }

  // ───────────────────────── file reading ─────────────────────────
  function detectDelim(text) {
    var line = text.split('\n')[0] || '';
    var c = { ',': 0, ';': 0, '\t': 0 }, q = false;
    for (var i = 0; i < line.length; i++) { var ch = line[i]; if (ch === '"') q = !q; else if (!q && c[ch] !== undefined) c[ch]++; }
    if (c['\t'] >= c[','] && c['\t'] >= c[';'] && c['\t'] > 0) return '\t';
    return c[';'] > c[','] ? ';' : ',';
  }
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    var d = detectDelim(text), rows = [], row = [], f = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += ch;
      } else if (ch === '"' && f === '') q = true;
      else if (ch === d) { row.push(f); f = ''; }
      else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; if (rows.length > MAX_ROWS + 1) break; }
      else if (ch !== '\r') f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim(); }); });
  }
  function ensureXLSX() {
    if (window.XLSX) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'vendor/xlsx.js';
      s.onload = function () { window.XLSX ? res() : rej(new Error('xlsx')); };
      s.onerror = function () { rej(new Error('xlsx')); };
      document.head.appendChild(s);
    });
  }
  function rowsFromWorkbook(buf) {
    var wb = XLSX.read(buf, { type: 'array', cellDates: true });
    var best = null, bestN = -1;
    wb.SheetNames.forEach(function (n) {
      var rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '', dateNF: 'dd/mm/yyyy hh:mm:ss' });
      rows = rows.filter(function (r) { return r.some(function (c) { return String(c).trim(); }); });
      if (rows.length > bestN) { best = rows; bestN = rows.length; }
    });
    return best || [];
  }
  // Some exports carry a title block above the real header row — find the row that looks like headers.
  function findHeaderRow(rows) {
    var lim = Math.min(rows.length, 15), best = 0, bestScore = -1;
    for (var i = 0; i < lim; i++) {
      var r = rows[i], filled = r.filter(function (c) { return String(c).trim(); }).length;
      var hits = r.filter(function (c) { return /status|produto|product|data|date|valor|pre[cç]o|price|transa|pedido|order|pagamento|payment/i.test(String(c)); }).length;
      var score = hits * 3 + filled;
      if (filled >= 3 && score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  // ───────────────────────── value parsing ─────────────────────────
  function parseMoney(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return NaN;
    var neg = /^\(.*\)$/.test(s) || /^-|-\s*R?\$|-$/.test(s);
    s = s.replace(/[^\d.,]/g, '');
    if (!s || !/\d/.test(s)) return NaN;
    var lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
    if (lc > -1 && ld > -1) {
      if (lc > ld) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, '');
    } else if (lc > -1) {
      if ((s.match(/,/g) || []).length > 1) s = s.replace(/,/g, ''); else s = s.replace(',', '.');
    } else if (ld > -1) {
      var parts = s.split('.');
      if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) s = s.replace(/\./g, '');
    }
    var n = parseFloat(s);
    if (isNaN(n)) return NaN;
    return neg ? -n : n;
  }
  function parseIntSafe(v) { var m = String(v || '').match(/\d+/); return m ? parseInt(m[0], 10) : 0; }
  // Date order (dd/mm vs mm/dd) is decided once per column.
  function dateOrderOf(values) {
    var dmyHit = 0, mdyHit = 0;
    values.forEach(function (v) {
      var m = String(v).match(/^\s*(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
      if (!m) return;
      if (+m[1] > 12) dmyHit++;
      if (+m[2] > 12) mdyHit++;
    });
    return mdyHit > dmyHit ? 'mdy' : 'dmy';
  }
  function parseDate(v, order) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return null;
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+\-]\d{2}:?\d{2})?)?/);
    if (m) {
      if (m[7]) { var dz = new Date(s.replace(' ', 'T')); if (!isNaN(dz)) return { t: dz.getTime(), h: true }; }
      var d1 = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
      return isNaN(d1) ? null : { t: d1.getTime(), h: m[4] != null };
    }
    m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(?:[\sT,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
    if (m) {
      var a = +m[1], b = +m[2], y = +m[3]; if (y < 100) y += 2000;
      var day = order === 'mdy' ? b : a, mon = order === 'mdy' ? a : b;
      var hh = m[4] ? +m[4] : 0;
      if (m[7]) { if (/pm/i.test(m[7]) && hh < 12) hh += 12; if (/am/i.test(m[7]) && hh === 12) hh = 0; }
      if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
      var d2 = new Date(y, mon - 1, day, hh, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
      return isNaN(d2) ? null : { t: d2.getTime(), h: m[4] != null };
    }
    if (/^\d{5}(\.\d+)?$/.test(s)) { // Excel serial date
      var serial = parseFloat(s), ms = Math.round((serial - 25569) * 86400000);
      var du = new Date(ms); var dl = new Date(du.getUTCFullYear(), du.getUTCMonth(), du.getUTCDate(), du.getUTCHours(), du.getUTCMinutes());
      return { t: dl.getTime(), h: serial % 1 !== 0 };
    }
    return null;
  }
  function autoBucket(raw) {
    var s = fold(raw);
    if (!s) return '';
    if (/charge ?back|chargedback|contestad|disputa|dispute|protestad/.test(s)) return 'chargeback';
    if (/reembols|refund|estornad|estorno|devolvid|devolucao/.test(s)) return 'reembolso';
    if (/nao pag|unpaid|incomplet|inativ|inactive|cancel|recusad|refused|declined|negad|failed|falh|expirad|expired|abandon|vencid|bloquead|rejeitad|rejected|void/.test(s)) return 'nao_paga';
    if (/aguard|waiting|pending|pendente|em analise|analysis|processing|processand|impresso|gerad|em aberto|^open|atrasad|billet printed|printed/.test(s)) return 'pendente';
    if (/aprovad|approved|^paid|pago|paga\b|^paga$|complet|concluid|succeeded|success|(^| )ativ|^active|faturad|liberad|finalizad|confirmad|autorizad|captured|capturad|settled/.test(s)) return 'aprovada';
    return '';
  }
  function methodKey(raw) {
    var s = fold(raw);
    if (!s) return '';
    if (/pix/.test(s)) return 'pix';
    if (/boleto|billet|bank ?slip|ticket/.test(s)) return 'boleto';
    if (/paypal/.test(s)) return 'paypal';
    if (/debit/.test(s)) return 'debito';
    if (/credit|cartao|card|credito|visa|master|elo|amex/.test(s)) return 'cartao';
    if (/google|apple|wallet|carteira|samsung|picpay|mercado ?pago/.test(s)) return 'carteira';
    return 'outro:' + String(raw).trim().slice(0, 40);
  }
  function methodLabel(k) { return k.indexOf('outro:') === 0 ? k.slice(6) : (METHOD_LABEL[k] || k); }

  // ───────────────────────── column mapping ─────────────────────────
  var SYN = {
    data: { re: /^(data|date)$|data (da |de |do )?(transacao|venda|compra|pedido|criacao|cadastro|inicio)|created|order date|sale date|purchase date|criado em|data_venda|data_pedido|data e hora|timestamp/, not: /confirma|aprova|atualiza|updated|reembols|refund|cancel|vencimento|expira|pagamento|garantia|nascimento|liberac|due/ },
    status: { re: /status|situacao|estado/, not: /assinatura|subscription|pagamento do afiliado|recorrencia/ },
    transacao: { re: /transacao|transaction|order id|^pedido$|n(º|o|umero)? (do )?pedido|id da venda|id do pedido|codigo da venda|sale id|^id$|fatura|invoice|^order$|charge id|referencia/, not: /produto|product|afiliad|sck|cupom/ },
    produto: { re: /^produto$|nome do produto|^product( name)?$|^produto |^oferta|offer name|^item$|descricao do produto|^plano$|^curso$/, not: /codigo|id|code|preco|price|valor|tipo|categoria/ },
    liquido: { re: /comissao (do )?produtor|valor liquido|liquido|net amount|^net|valor recebido|voce recebeu|recebido|earnings|repasse|minha comissao|sua comissao|comissao$/, not: /afiliad|affiliate|coprodut|taxa|fee/ },
    bruto: { re: /preco total|valor (total|da compra|pago|bruto|da venda|do pedido)|^total|gross|amount paid|valor de compra|preco (do produto|da oferta|base)|product base price|^price$|^valor$|^preco$|^amount$|faturamento|preco com|valor cobrado|charged/, not: /liquido|comissao|net|taxa|fee|frete|desconto|discount|imposto|tax|afiliad|parcela/ },
    pagamento: { re: /metodo|meio de pagamento|forma de pagamento|payment ?(method|type)?$|^pagamento$|tipo de pagamento|payment_method/, not: /data|status|parcela|id/ },
    parcelas: { re: /parcela|installment|n(º|o)? de vezes|^vezes$/, not: /valor|data/ },
    campanha: { re: /utm.?campaign|campanha|campaign/, not: /id$/ },
    origem: { re: /utm.?source|^src$|sck|origem|^source$|canal|traffic source|lead source|tracking/, not: /afiliad/ },
    afiliado: { re: /afiliad|affiliate|parceiro|coprodutor nome/, not: /comissao|commission|codigo|email|e-mail|id|cpf|documento|telefone/ },
    cupom: { re: /cupom|coupon|cupon|codigo de desconto|discount code|voucher/, not: /valor|desconto$/ },
    comprador: { re: /e-?mail (do )?(comprador|cliente|aluno)|(buyer|customer|client) ?e-?mail|^e-?mail$|email_comprador/, not: /afiliad|affiliate|produtor/ }
  };
  var ASSIGN_ORDER = ['data', 'status', 'transacao', 'produto', 'liquido', 'bruto', 'pagamento', 'parcelas', 'campanha', 'origem', 'afiliado', 'cupom', 'comprador'];
  function colSample(raw, ci, n) {
    var out = [];
    for (var i = 0; i < raw.rows.length && out.length < (n || 3); i++) { var v = String(raw.rows[i][ci] || '').trim(); if (v && out.indexOf(v) === -1) out.push(v); }
    return out;
  }
  function contentOK(field, raw, ci) {
    var vals = [], lim = Math.min(raw.rows.length, 200);
    for (var i = 0; i < lim; i++) { var v = String(raw.rows[i][ci] || '').trim(); if (v) vals.push(v); }
    if (!vals.length) return field === 'cupom' || field === 'afiliado' || field === 'campanha' || field === 'origem';
    if (field === 'data') { var ord = dateOrderOf(vals); return vals.filter(function (v) { return parseDate(v, ord); }).length >= vals.length * 0.6; }
    if (field === 'bruto' || field === 'liquido') return vals.filter(function (v) { return !isNaN(parseMoney(v)); }).length >= vals.length * 0.6;
    if (field === 'parcelas') return vals.filter(function (v) { return /^\s*\d{1,2}\s*(x|vezes)?\s*$/i.test(v); }).length >= vals.length * 0.6;
    if (field === 'comprador') return vals.filter(function (v) { return /@/.test(v); }).length >= vals.length * 0.5;
    return true;
  }
  function autoMap(raw) {
    var map = {}, used = {}, H = raw.headers.map(fold);
    ASSIGN_ORDER.forEach(function (f) {
      var syn = SYN[f];
      for (var ci = 0; ci < H.length; ci++) {
        if (used[ci]) continue;
        if (syn.re.test(H[ci]) && !(syn.not && syn.not.test(H[ci])) && contentOK(f, raw, ci)) { map[f] = ci; used[ci] = true; break; }
      }
    });
    if (map.comprador == null) { // any column full of e-mails
      for (var c2 = 0; c2 < H.length; c2++) { if (!used[c2] && /mail/.test(H[c2]) && !/afiliad|produtor/.test(H[c2]) && contentOK('comprador', raw, c2)) { map.comprador = c2; break; } }
    }
    if (map.bruto == null && map.liquido != null) { /* only net available — bruto stays empty, metrics fall back */ }
    return map;
  }
  function detectPlatform(headers) {
    var h = fold(headers.join(' | '));
    if (/hotmart|codigo sck|comissao do produtor|sck/.test(h)) return 'Hotmart';
    if (/kiwify|net amount.*product base price|product base price/.test(h)) return 'Kiwify';
    if (/eduzz|fatura.*(cliente|produto)|id da fatura/.test(h)) return 'Eduzz';
    if (/monetizze|codigo da venda.*(plano|produto)/.test(h)) return 'Monetizze';
    if (/ticto/.test(h)) return 'Ticto';
    if (/amount refunded|stripe|payment intent|customer email.*amount/.test(h)) return 'Stripe';
    if (/greenn|braip|perfectpay|lastlink/.test(h)) return (h.match(/greenn|braip|perfectpay|lastlink/) || [''])[0].replace(/^./, function (c) { return c.toUpperCase(); });
    return '';
  }

  // ───────────────────────── normalization (raw → compact records) ─────────────────────────
  // rec = [t, bucketCode, productIdx, bruto, liquido|null, methodIdx, parcelas, originIdx, campaignIdx, affiliateIdx, couponIdx, buyerHash, hasHour]
  var BCODE = { aprovada: 'A', reembolso: 'R', chargeback: 'C', nao_paga: 'N', pendente: 'P' };
  var BNAME = { A: 'aprovada', R: 'reembolso', C: 'chargeback', N: 'nao_paga', P: 'pendente' };
  function statusValues(raw, map, statusMap) {
    if (map.status == null) return [];
    var cnt = {}, label = {};
    raw.rows.forEach(function (r) { var v = String(r[map.status] || '').trim(); var k = fold(v); if (!k) k = '(vazio)'; cnt[k] = (cnt[k] || 0) + 1; if (!label[k]) label[k] = v || '(vazio)'; });
    return Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; }).map(function (k) {
      var auto = autoBucket(k === '(vazio)' ? '' : k);
      return { key: k, label: label[k], count: cnt[k], bucket: statusMap[k] || auto || 'desconhecido', auto: !statusMap[k] && !!auto };
    });
  }
  function normalize(raw, map, statusMap) {
    var dicts = { p: [], m: [], o: [], c: [], a: [], k: [''] }, idx = { p: {}, m: {}, o: {}, c: {}, a: {}, k: { '': 0 } };
    function intern(d, v) { var key = fold(v); if (idx[d][key] == null) { idx[d][key] = dicts[d].length; dicts[d].push(v); } return idx[d][key]; }
    var order = map.data != null ? dateOrderOf(raw.rows.slice(0, 500).map(function (r) { return r[map.data]; })) : 'dmy';
    var sv = {}; statusValues(raw, map, statusMap).forEach(function (s) { sv[s.key] = s.bucket; });
    var recs = [], skipped = { semData: 0, semValor: 0, statusAberto: 0, ignoradas: 0 }, dupes = 0, seen = {}, hasHour = false, negatives = 0;
    raw.rows.forEach(function (r) {
      var d = map.data != null ? parseDate(r[map.data], order) : null;
      if (!d) { skipped.semData++; return; }
      var bucket = 'aprovada';
      if (map.status != null) { var k = fold(String(r[map.status] || '').trim()) || '(vazio)'; bucket = sv[k] || 'desconhecido'; }
      if (bucket === 'ignorar') { skipped.ignoradas++; return; }
      if (bucket === 'desconhecido') { skipped.statusAberto++; return; }
      var b = map.bruto != null ? parseMoney(r[map.bruto]) : NaN;
      var l = map.liquido != null ? parseMoney(r[map.liquido]) : NaN;
      if (b < 0 || l < 0) negatives++;
      b = Math.abs(b); l = Math.abs(l);
      if (isNaN(b) && !isNaN(l)) b = l; // only net available
      if (isNaN(b)) { skipped.semValor++; return; }
      if (map.transacao != null) {
        var tk = fold(r[map.transacao]) + '|' + (map.produto != null ? fold(r[map.produto]) : '') + '|' + bucket;
        if (fold(r[map.transacao])) { if (seen[tk]) { dupes++; return; } seen[tk] = 1; }
      }
      if (d.h) hasHour = true;
      var prod = map.produto != null ? (String(r[map.produto] || '').trim() || NO_PRODUCT) : NO_PRODUCT;
      var mk = map.pagamento != null ? methodKey(r[map.pagamento]) : '';
      var org = map.origem != null ? (String(r[map.origem] || '').trim() || NO_ORIGIN) : NO_ORIGIN;
      var cmp = map.campanha != null ? (String(r[map.campanha] || '').trim() || '(sem campanha)') : '(sem campanha)';
      var aff = map.afiliado != null ? (String(r[map.afiliado] || '').trim() || NO_AFF) : NO_AFF;
      if (/^(0|nao|não|no|false|-)$/i.test(aff)) aff = NO_AFF;
      var cup = map.cupom != null ? String(r[map.cupom] || '').trim() : '';
      if (/^(0|nao|não|no|false|-|nenhum)$/i.test(cup)) cup = '';
      var buyer = map.comprador != null ? fold(r[map.comprador]) : '';
      recs.push([d.t, BCODE[bucket], intern('p', prod.slice(0, 120)), Math.round(b * 100) / 100, isNaN(l) ? null : Math.round(l * 100) / 100, intern('m', mk), map.parcelas != null ? Math.min(24, parseIntSafe(r[map.parcelas]) || 1) : 1, intern('o', org.slice(0, 80)), intern('c', cmp.slice(0, 80)), intern('a', aff.slice(0, 80)), cup ? intern('k', cup.slice(0, 40)) : 0, buyer ? hash(buyer) : '', d.h ? 1 : 0]);
    });
    recs.sort(function (a, b) { return a[0] - b[0]; });
    return { recs: recs, dicts: dicts, stats: { linhas: raw.rows.length, vendas: recs.length, skipped: skipped, dupes: dupes, negatives: negatives, hasHour: hasHour, dateOrder: order, hasNet: map.liquido != null, hasBruto: map.bruto != null } };
  }

  // ───────────────────────── metrics (deterministic) ─────────────────────────
  function sumBy(list, key) { return list.reduce(function (a, x) { return a + (x[key] || 0); }, 0); }
  function compute(p) {
    var R = p.recs || [], D = p.dicts || { p: [], m: [], o: [], c: [], a: [], k: [''] };
    var m = { n: R.length, start: R.length ? R[0][0] : 0, end: R.length ? R[R.length - 1][0] : 0 };
    var by = { A: { n: 0, b: 0, l: 0, ln: 0 }, R: { n: 0, b: 0 }, C: { n: 0, b: 0 }, N: { n: 0, b: 0 }, P: { n: 0, b: 0 } };
    var prod = {}, meth = {}, orig = {}, camp = {}, aff = {}, parc = {}, cup = { n: 0, b: 0 }, daily = {}, heat = [], buyers = {}, hasHour = false;
    for (var w = 0; w < 7; w++) { heat.push([]); for (var h = 0; h < 24; h++) heat[w].push(0); }
    function grp(o, key, label) { return o[key] || (o[key] = { label: label, n: 0, b: 0, l: 0, ln: 0, refunds: 0, cb: 0, paidish: 0, gerados: 0, naoPagos: 0, pend: 0 }); }
    R.forEach(function (r) {
      var t = r[0], s = r[1], b = r[3], l = r[4];
      by[s].n++; by[s].b += b;
      var g = [grp(prod, r[2], D.p[r[2]]), grp(meth, r[5], methodLabel(D.m[r[5]] || '')), grp(orig, r[7], D.o[r[7]]), grp(camp, r[8], D.c[r[8]]), grp(aff, r[9], D.a[r[9]])];
      g.forEach(function (x) {
        x.gerados++;
        if (s === 'A') { x.n++; x.b += b; if (l != null) { x.l += l; x.ln++; } }
        if (s === 'R') x.refunds++;
        if (s === 'C') x.cb++;
        if (s === 'A' || s === 'R' || s === 'C') x.paidish++;
        if (s === 'N') x.naoPagos++;
        if (s === 'P') x.pend++;
      });
      if (s === 'A') {
        if (l != null) { by.A.l += l; by.A.ln++; }
        var dk = dayKey(t); daily[dk] = daily[dk] || { n: 0, b: 0 }; daily[dk].n++; daily[dk].b += b;
        if (r[12]) { hasHour = true; var dd = new Date(t); heat[dd.getDay()][dd.getHours()]++; }
        if ((D.m[r[5]] || '') === 'cartao') parc[r[6]] = (parc[r[6]] || 0) + 1;
        if (r[10]) { cup.n++; cup.b += b; }
        if (r[11]) { var bu = buyers[r[11]] || (buyers[r[11]] = { n: 0, b: 0, prods: {} }); bu.n++; bu.b += b; bu.prods[r[2]] = 1; }
      }
    });
    m.by = by;
    m.aprovadas = by.A.n; m.bruto = by.A.b;
    m.hasNet = by.A.ln > 0 && by.A.ln >= by.A.n * 0.9;
    m.liquido = m.hasNet ? by.A.l : null;
    m.taxas = m.hasNet ? Math.max(0, m.bruto - m.liquido) : null;
    m.ticket = by.A.n ? by.A.b / by.A.n : 0;
    var paidish = by.A.n + by.R.n + by.C.n;
    m.reembolsoPct = pct1(by.R.n, paidish); m.reembolsoValor = by.R.b; m.reembolsoValorPct = pct1(by.R.b, by.A.b + by.R.b + by.C.b);
    m.chargebackPct = pct1(by.C.n, paidish); m.chargebackValor = by.C.b;
    m.naMesa = by.N.b + by.P.b; m.naMesaN = by.N.n + by.P.n;
    m.conversaoGeral = pct1(paidish, R.length);
    function finish(o, total) {
      return Object.keys(o).map(function (k) {
        var x = o[k];
        x.share = pct1(x.b, total); x.ticket = x.n ? x.b / x.n : 0;
        x.refundPct = pct1(x.refunds, x.paidish); x.conv = pct1(x.paidish, x.gerados);
        x.liq = x.ln ? x.l : null;
        return x;
      }).sort(function (a, b) { return b.b - a.b || b.gerados - a.gerados; });
    }
    m.produtos = finish(prod, m.bruto); m.metodos = finish(meth, m.bruto); m.origens = finish(orig, m.bruto); m.campanhas = finish(camp, m.bruto); m.afiliados = finish(aff, m.bruto);
    m.temOrigem = m.origens.some(function (x) { return x.label !== NO_ORIGIN; });
    m.temCampanha = m.campanhas.some(function (x) { return x.label !== '(sem campanha)'; });
    m.temAfiliado = m.afiliados.some(function (x) { return x.label !== NO_AFF; });
    m.temProduto = m.produtos.some(function (x) { return x.label !== NO_PRODUCT; });
    m.temMetodo = m.metodos.some(function (x) { return x.label !== METHOD_LABEL['']; });
    var parcN = Object.keys(parc).reduce(function (a, k) { return a + parc[k]; }, 0);
    m.parcelas = Object.keys(parc).map(function (k) { return { label: k + 'x', k: +k, n: parc[k], share: pct1(parc[k], parcN) }; }).sort(function (a, b) { return a.k - b.k; });
    m.parcelaMedia = parcN ? Object.keys(parc).reduce(function (a, k) { return a + (+k) * parc[k]; }, 0) / parcN : 0;
    m.cupom = { n: cup.n, b: cup.b, share: pct1(cup.n, by.A.n) };
    // daily series over the whole period (empty days included)
    var series = [];
    if (R.length) {
      var d0 = new Date(m.start); d0 = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate());
      var d1 = new Date(m.end); d1 = new Date(d1.getFullYear(), d1.getMonth(), d1.getDate());
      for (var dcur = new Date(d0); dcur <= d1 && series.length < 400; dcur.setDate(dcur.getDate() + 1)) {
        var key = dayKey(dcur.getTime()); var v = daily[key] || { n: 0, b: 0 };
        series.push({ t: dcur.getTime(), n: v.n, b: v.b });
      }
    }
    m.series = series; m.dias = series.length;
    m.mediaDia = series.length ? m.bruto / series.length : 0;
    var best = series.slice().sort(function (a, b) { return b.b - a.b; })[0];
    m.melhorDia = best && best.b ? best : null;
    var top5 = series.slice().sort(function (a, b) { return b.b - a.b; }).slice(0, Math.max(1, Math.round(series.length * 0.15)));
    m.concentracao = pct1(sumBy(top5, 'b'), m.bruto); m.concentracaoDias = top5.length;
    var wd = [0, 0, 0, 0, 0, 0, 0], wdb = [0, 0, 0, 0, 0, 0, 0];
    series.forEach(function (x) { var d = new Date(x.t).getDay(); wd[d] += x.n; wdb[d] += x.b; });
    var bw = 0; for (var i = 1; i < 7; i++) if (wdb[i] > wdb[bw]) bw = i;
    m.melhorDiaSemana = m.bruto ? { d: bw, b: wdb[bw], share: pct1(wdb[bw], m.bruto) } : null;
    m.hasHour = hasHour; m.heat = heat;
    if (hasHour) {
      var hours = []; for (var hh = 0; hh < 24; hh++) { var s2 = 0; for (var w2 = 0; w2 < 7; w2++) s2 += heat[w2][hh]; hours.push(s2); }
      var bh = 0; for (var h2 = 1; h2 < 24; h2++) if (hours[h2] > hours[bh]) bh = h2;
      m.melhorHora = { h: bh, n: hours[bh], share: pct1(hours[bh], by.A.n) };
      var ev = 0; for (var h3 = 18; h3 < 24; h3++) ev += hours[h3]; m.noite = pct1(ev, by.A.n);
    }
    // buyers
    var bk = Object.keys(buyers);
    m.temComprador = bk.length > 0;
    m.compradores = bk.length;
    var multi = bk.filter(function (k) { return Object.keys(buyers[k].prods).length >= 2; });
    m.multi = { n: multi.length, share: pct1(multi.length, bk.length), b: multi.reduce(function (a, k) { return a + buyers[k].b; }, 0) };
    m.multi.bShare = pct1(m.multi.b, m.bruto);
    var pairs = {};
    multi.forEach(function (k) {
      var ps = Object.keys(buyers[k].prods).map(Number).sort(function (a, b) { return a - b; });
      for (var x = 0; x < ps.length; x++) for (var y = x + 1; y < ps.length; y++) { var pk = ps[x] + '|' + ps[y]; pairs[pk] = (pairs[pk] || 0) + 1; }
    });
    m.combos = Object.keys(pairs).map(function (k) { var a = k.split('|'); return { a: D.p[+a[0]], b: D.p[+a[1]], n: pairs[k] }; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 5);
    return m;
  }

  // ───────────────────────── comparison ─────────────────────────
  function delta(cur, prev) { if (prev == null || cur == null) return null; if (!prev) return cur ? { pct: null, abs: cur - prev } : { pct: 0, abs: 0 }; return { pct: (cur - prev) * 100 / Math.abs(prev), abs: cur - prev }; }
  function deltaHTML(d, opts) {
    opts = opts || {};
    if (!d) return '<span class="dl dl-none">—</span>';
    var v = opts.pp ? d.abs : d.pct;
    if (v == null) return '<span class="dl dl-none">novo</span>';
    var good = opts.invert ? v < 0 : v > 0, flat = Math.abs(v) < 0.05;
    var txt = (v > 0 ? '+' : (v < 0 ? '−' : '')) + NF1.format(Math.abs(v)) + (opts.pp ? ' p.p.' : '%');
    return '<span class="dl ' + (flat ? 'dl-flat' : (good ? 'dl-up' : 'dl-down')) + '"><span class="dl-arrow" aria-hidden="true">' + (flat ? '■' : (v > 0 ? '▲' : '▼')) + '</span>' + txt + '</span>';
  }

  // ───────────────────────── SVG charts (attributes only — CSP style-src 'self') ─────────────────────────
  function barSVG(p, color) {
    var w = Math.max(0, Math.min(100, p));
    return '<svg class="bar-svg" viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden="true">' +
      '<rect x="0" y="1" width="100" height="12" fill="' + C.paper2 + '"/>' +
      (w > 0 ? '<rect x="0" y="1" width="' + w.toFixed(2) + '" height="12" fill="' + color + '"/>' : '') + '</svg>';
  }
  function dailySVG(m) {
    var S = m.series; if (!S.length) return '';
    var W = 760, H = 250, L = 64, Rm = 12, T = 18, B = 34, iw = W - L - Rm, ih = H - T - B;
    var max = Math.max.apply(null, S.map(function (x) { return x.b; }).concat([1]));
    var step = niceStep(max / 4), top = Math.ceil(max / step) * step || 1;
    var bw = iw / S.length, out = '';
    for (var g = 0; g <= top + 0.001; g += step) {
      var y = T + ih - g / top * ih;
      out += '<line x1="' + L + '" x2="' + (W - Rm) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="' + C.grid + '" stroke-width="1"/>' +
        '<text x="' + (L - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" font-family="IBM Plex Sans Condensed, sans-serif" font-size="12" fill="' + C.ink2 + '">' + esc(brlShort(g)) + '</text>';
    }
    var labelEvery = Math.max(1, Math.ceil(S.length / 10));
    var bestT = m.melhorDia ? m.melhorDia.t : -1;
    S.forEach(function (x, i) {
      var h = x.b / top * ih, xx = L + i * bw + bw * 0.14, ww = Math.max(1, bw * 0.72);
      out += '<rect x="' + xx.toFixed(1) + '" y="' + (T + ih - h).toFixed(1) + '" width="' + ww.toFixed(1) + '" height="' + Math.max(0, h).toFixed(1) + '" fill="' + (x.t === bestT ? C.claret : C.blue) + '"><title>' + esc(dm(x.t) + ' · ' + brl(x.b) + ' · ' + x.n + ' vendas') + '</title></rect>';
      if (i % labelEvery === 0) out += '<text x="' + (L + i * bw + bw / 2).toFixed(1) + '" y="' + (H - 12) + '" text-anchor="middle" font-family="IBM Plex Sans Condensed, sans-serif" font-size="12" fill="' + C.ink2 + '">' + esc(dm(x.t)) + '</text>';
    });
    if (m.melhorDia) {
      var bi = S.indexOf(S.filter(function (x) { return x.t === bestT; })[0]);
      var bx = L + bi * bw + bw / 2, by = T + ih - m.melhorDia.b / top * ih;
      var anchor = bx > W - 170 ? 'end' : (bx < L + 120 ? 'start' : 'middle');
      out += '<text x="' + bx.toFixed(1) + '" y="' + Math.max(12, by - 6).toFixed(1) + '" text-anchor="' + anchor + '" font-family="IBM Plex Sans Condensed, sans-serif" font-size="12" font-weight="700" fill="' + C.claret + '">' + esc('Melhor dia: ' + dm(bestT) + ' · ' + brlShort(m.melhorDia.b)) + '</text>';
    }
    out += '<line x1="' + L + '" x2="' + (W - Rm) + '" y1="' + (T + ih) + '" y2="' + (T + ih) + '" stroke="' + C.ink + '" stroke-width="1.2"/>';
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Faturamento aprovado por dia; melhor dia ' + esc(m.melhorDia ? dm(bestT) : '—') + '">' + out + '</svg>';
  }
  function niceStep(x) { if (x <= 0) return 1; var e = Math.pow(10, Math.floor(Math.log10(x))), f = x / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e; }
  function heatSVG(m) {
    var cw = 26, ch = 24, L = 44, T = 22, W = L + 24 * cw + 4, H = T + 7 * ch + 8, out = '';
    var max = 1; m.heat.forEach(function (row) { row.forEach(function (v) { if (v > max) max = v; }); });
    for (var h = 0; h < 24; h += 3) out += '<text x="' + (L + h * cw + cw / 2) + '" y="14" text-anchor="middle" font-family="IBM Plex Sans Condensed, sans-serif" font-size="12" fill="' + C.ink2 + '">' + h + 'h</text>';
    var orderW = [1, 2, 3, 4, 5, 6, 0];
    orderW.forEach(function (d, r) {
      out += '<text x="' + (L - 8) + '" y="' + (T + r * ch + ch / 2 + 4) + '" text-anchor="end" font-family="IBM Plex Sans Condensed, sans-serif" font-size="12" fill="' + C.ink2 + '">' + WEEKDAYS[d] + '</text>';
      for (var hh = 0; hh < 24; hh++) {
        var v = m.heat[d][hh], op = v ? (0.12 + 0.88 * v / max) : 0;
        out += '<rect x="' + (L + hh * cw + 1) + '" y="' + (T + r * ch + 1) + '" width="' + (cw - 2) + '" height="' + (ch - 2) + '" fill="' + (v ? C.claret : C.paper2) + '" fill-opacity="' + (v ? op.toFixed(2) : '1') + '"><title>' + esc(WEEKDAYS_LONG[d] + ', ' + hh + 'h: ' + v + ' vendas aprovadas') + '</title></rect>';
      }
    });
    return '<svg class="chart heat" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Vendas aprovadas por dia da semana e hora">' + out + '</svg>';
  }

  // ───────────────────────── dashboard pieces ─────────────────────────
  function tickerItems(m, c) {
    var items = [
      { k: 'Faturamento bruto', v: brl(m.bruto), d: c ? delta(m.bruto, c.bruto) : null },
      m.liquido != null ? { k: 'Líquido', v: brl(m.liquido), d: c ? delta(m.liquido, c.liquido) : null } : null,
      { k: 'Vendas aprovadas', v: fmtInt(m.aprovadas), d: c ? delta(m.aprovadas, c.aprovadas) : null },
      { k: 'Ticket médio', v: brl2(m.ticket), d: c ? delta(m.ticket, c.ticket) : null },
      { k: 'Reembolso', v: fmtPct(m.reembolsoPct), d: c ? delta(m.reembolsoPct, c.reembolsoPct) : null, pp: true, invert: true },
      { k: 'Na mesa', v: brl(m.naMesa), d: c ? delta(m.naMesa, c.naMesa) : null, invert: true }
    ];
    return items.filter(Boolean);
  }
  function tickerHTML(m, c) {
    return tickerItems(m, c).map(function (x) {
      return '<div class="tk"><span class="tk-k">' + esc(x.k) + '</span><span class="tk-v">' + esc(x.v) + '</span>' + (c ? deltaHTML(x.d, { pp: x.pp, invert: x.invert }) : '') + '</div>';
    }).join('');
  }
  function moneyTableHTML(list, opts) {
    opts = opts || {};
    var cap = opts.cap || 8, rows = list.filter(function (x) { return x.gerados > 0; }).slice(0, cap);
    if (!rows.length) return '<p class="muted">Sem dados.</p>';
    var head = '<tr><th scope="col">' + esc(opts.title || 'Item') + '</th><th scope="col" class="num">Vendas</th><th scope="col" class="num">Faturamento</th><th scope="col" class="num">Fatia</th>' + (opts.ticket ? '<th scope="col" class="num">Ticket</th>' : '') + (opts.refund ? '<th scope="col" class="num">Reembolso</th>' : '') + (opts.conv ? '<th scope="col" class="num">Pagos / gerados</th>' : '') + '</tr>';
    var body = rows.map(function (x) {
      var hiR = opts.refund && x.paidish >= 10 && x.refundPct >= 8;
      var loC = opts.conv && x.gerados >= 10 && x.conv < 60;
      return '<tr><th scope="row">' + esc(shortTxt(x.label, 46)) + '</th><td class="num">' + fmtInt(x.n) + '</td><td class="num"><b>' + esc(brl(x.b)) + '</b></td><td class="num share">' + barSVG(x.share, C.blue) + '<span>' + fmtPct(x.share) + '</span></td>' +
        (opts.ticket ? '<td class="num">' + esc(brl2(x.ticket)) + '</td>' : '') +
        (opts.refund ? '<td class="num' + (hiR ? ' warn' : '') + '">' + (x.paidish ? fmtPct(x.refundPct) : '—') + '</td>' : '') +
        (opts.conv ? '<td class="num' + (loC ? ' warn' : '') + '">' + fmtPct(x.conv) + ' <span class="muted">(' + fmtInt(x.paidish) + '/' + fmtInt(x.gerados) + ')</span></td>' : '') + '</tr>';
    }).join('');
    var more = list.length > cap ? '<p class="small-n">+ ' + (list.length - cap) + ' outros com menos vendas (estão no CSV normalizado)</p>' : '';
    return '<div class="tbl-wrap"><table class="mkt"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' + more;
  }
  function kpiBoardHTML(m, c) {
    function k(label, value, sub, d, o) { return '<div class="kp"><p class="kp-k">' + esc(label) + '</p><p class="kp-v">' + esc(value) + '</p>' + (c ? '<p class="kp-d">' + deltaHTML(d, o) + ' <span class="muted">vs. ' + esc(c.__nome) + '</span></p>' : '') + '<p class="kp-s">' + esc(sub) + '</p></div>'; }
    var out = '';
    out += k('Faturamento bruto', brl(m.bruto), plural(m.aprovadas, 'venda aprovada', 'vendas aprovadas') + ' · média de ' + brl(m.mediaDia) + '/dia', c && delta(m.bruto, c.bruto));
    out += m.liquido != null ? k('Líquido (o que é seu)', brl(m.liquido), 'taxas e comissões: ' + brl(m.taxas) + ' (' + fmtPct(pct1(m.taxas, m.bruto)) + ')', c && delta(m.liquido, c.liquido)) : k('Líquido', '—', 'mapeie a coluna de valor líquido para ver o que é seu', null);
    out += k('Ticket médio', brl2(m.ticket), 'por venda aprovada', c && delta(m.ticket, c.ticket));
    out += k('Reembolsos', fmtPct(m.reembolsoPct), plural(m.by.R.n, 'reembolso', 'reembolsos') + ' · ' + brl(m.reembolsoValor) + ' devolvidos', c && delta(m.reembolsoPct, c.reembolsoPct), { pp: true, invert: true });
    out += k('Chargebacks', fmtPct(m.chargebackPct), plural(m.by.C.n, 'contestação', 'contestações') + ' · ' + brl(m.chargebackValor), c && delta(m.chargebackPct, c.chargebackPct), { pp: true, invert: true });
    out += k('Dinheiro na mesa', brl(m.naMesa), plural(m.naMesaN, 'pedido gerado e não pago', 'pedidos gerados e não pagos') + ' (Pix/boleto vencidos, cartões recusados, pendentes)', c && delta(m.naMesa, c.naMesa), { invert: true });
    return out;
  }
  function paymentsHTML(m) {
    if (!m.temMetodo) return '<p class="muted">Mapeie a coluna de meio de pagamento para ver cartão × Pix × boleto.</p>';
    var out = moneyTableHTML(m.metodos, { title: 'Meio', conv: true, ticket: true });
    var pix = m.metodos.filter(function (x) { return /pix/i.test(x.label); })[0], bol = m.metodos.filter(function (x) { return /boleto/i.test(x.label); })[0];
    var notes = [];
    if (pix && pix.gerados >= 5) notes.push('De cada 100 Pix gerados, <b>' + fmtInt(pix.conv) + '</b> foram pagos.');
    if (bol && bol.gerados >= 5) notes.push('De cada 100 boletos gerados, <b>' + fmtInt(bol.conv) + '</b> foram pagos.');
    if (m.parcelas.length) notes.push('No cartão, a média foi de <b>' + NF1.format(m.parcelaMedia) + ' parcelas</b>; ' + fmtPct((m.parcelas.filter(function (x) { return x.k >= 10; }).reduce(function (a, x) { return a + x.share; }, 0))) + ' parcelaram em 10x ou mais.');
    return out + (notes.length ? '<p class="note-line">' + notes.join(' ') + '</p>' : '') + (m.parcelas.length > 1 ? '<div class="parc">' + m.parcelas.map(function (x) { return '<div class="parc-row"><span class="parc-k">' + esc(x.label) + '</span>' + barSVG(x.share, C.claret) + '<span class="parc-v">' + fmtPct(x.share) + '</span></div>'; }).join('') + '</div>' : '');
  }
  function buyersHTML(m) {
    if (!m.temComprador) return '<p class="muted">Mapeie a coluna de e-mail do comprador para ver quem comprou mais de um produto. O e-mail nunca sai do seu navegador.</p>';
    var out = '<div class="mini-kp"><div><b>' + fmtInt(m.compradores) + '</b><span>compradores únicos</span></div><div><b>' + fmtInt(m.multi.n) + '</b><span>compraram 2+ produtos (' + fmtPct(m.multi.share) + ')</span></div><div><b>' + esc(brl(m.multi.b)) + '</b><span>vieram deles (' + fmtPct(m.multi.bShare) + ' do faturamento)</span></div></div>';
    if (m.combos.length) out += '<p class="sub-h">Combinações mais compradas pela mesma pessoa</p><ol class="combos">' + m.combos.map(function (x) { return '<li><span>' + esc(shortTxt(x.a, 40)) + ' <i>+</i> ' + esc(shortTxt(x.b, 40)) + '</span><b>' + plural(x.n, 'cliente', 'clientes') + '</b></li>'; }).join('') + '</ol>';
    return out;
  }
  function timingHTML(m) {
    var out = '';
    if (m.melhorDiaSemana) out += '<p class="note-line">O dia da semana que mais vende é <b>' + WEEKDAYS_LONG[m.melhorDiaSemana.d] + '</b> (' + fmtPct(m.melhorDiaSemana.share) + ' do faturamento).' + (m.hasHour ? ' O horário campeão é <b>' + m.melhorHora.h + 'h</b>, e ' + fmtPct(m.noite) + ' das vendas acontecem entre 18h e meia-noite.' : '') + ' Os ' + plural(m.concentracaoDias, 'melhor dia concentrou', 'melhores dias concentraram') + ' ' + fmtPct(m.concentracao) + ' do faturamento.</p>';
    out += m.hasHour ? heatSVG(m) : '<p class="muted">A planilha não traz o horário das vendas — o mapa de dia × hora aparece quando a data tem hora.</p>';
    return out;
  }
  function section(id, kicker, title, body, wide) { return { id: id, kicker: kicker, title: title, body: body, wide: !!wide }; }
  // Two newspaper columns: blocks pair up left/right; a half block left alone before a wide one (or at the end) becomes wide.
  function layoutBlocks(list) {
    var col = 0;
    return list.map(function (b, i) {
      var cls = 'wide';
      if (!b.wide) {
        var next = list[i + 1];
        if (col === 0 && (!next || next.wide)) cls = 'wide';
        else { cls = col === 0 ? 'c-left' : 'c-right'; col = 1 - col; }
      } else col = 0;
      return '<section class="col-block ' + cls + '" id="' + b.id + '"><p class="kicker">' + esc(b.kicker) + '</p><h3 class="block-h">' + esc(b.title) + '</h3>' + b.body + '</section>';
    }).join('');
  }
  function dashboardHTML(m, c) {
    var out = [];
    out.push(section('b-dia', 'Série diária', 'Faturamento aprovado por dia', dailySVG(m) + '<p class="small-n">Período: ' + esc(dmy(m.start)) + ' a ' + esc(dmy(m.end)) + ' · ' + plural(m.dias, 'dia', 'dias') + '. Barra vermelha = melhor dia.</p>', true));
    out.push(section('b-prod', 'Mix de produtos', 'O que vende — e o que volta', m.temProduto ? moneyTableHTML(m.produtos, { title: 'Produto', ticket: true, refund: true }) : '<p class="muted">Mapeie a coluna de produto para ver o mix.</p>', true));
    out.push(section('b-pag', 'Pagamentos', 'Cartão, Pix e boleto: o que vira dinheiro', paymentsHTML(m), true));
    out.push(section('b-orig', 'Origem das vendas', m.temOrigem ? 'De onde vieram os compradores' : 'Origem não informada', m.temOrigem ? moneyTableHTML(m.origens, { title: 'Origem', refund: true }) : '<p class="muted">Mapeie a coluna de UTM source / SCK / src para ver de onde vêm as vendas.</p>'));
    if (m.temCampanha) out.push(section('b-camp', 'Campanhas', 'Por campanha (UTM campaign)', moneyTableHTML(m.campanhas, { title: 'Campanha' })));
    if (m.temAfiliado) out.push(section('b-aff', 'Afiliados', 'Venda direta × afiliados', moneyTableHTML(m.afiliados, { title: 'Afiliado', refund: true })));
    out.push(section('b-cli', 'Clientes', 'Quem compra mais de um produto', buyersHTML(m) + (m.cupom.n ? '<p class="note-line">Cupom em <b>' + fmtPct(m.cupom.share) + '</b> das vendas aprovadas (' + esc(brl(m.cupom.b)) + ').</p>' : '')));
    out.push(section('b-hora', 'Quando vende', 'Dia da semana × hora', timingHTML(m), true));
    return layoutBlocks(out);
  }

  // ───────────────────────── AI (OpenRouter BYOK) ─────────────────────────
  function activeKey() {
    var k = window.ApiKeyManager && ApiKeyManager.getActiveKey ? ApiKeyManager.getActiveKey() : null;
    return k && k.key ? k : null;
  }
  // One OpenRouter call → assistant content string. Throws {emptyContent} on empty answer (COR-035).
  function fetchContent(messages, temperature, signal) {
    var key = activeKey();
    if (!key) return Promise.reject(new Error('Conecte sua chave de IA (ícone de chave no topo) para continuar.'));
    var model = (window.ApiKeyManager && ApiKeyManager.getModel) ? ApiKeyManager.getModel() : 'google/gemini-3.8-flash';
    var isDeepSeek = model.indexOf('deepseek/') === 0;
    var body = { model: model, messages: messages, temperature: (temperature == null ? 0.3 : temperature), max_tokens: 16000 }; // COR-053
    if (!isDeepSeek) body.reasoning = { effort: 'low' }; // COR-034; never for deepseek/* (COR-035)
    var doFetch = function () {
      return fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', signal: signal,
        headers: { 'Authorization': 'Bearer ' + key.key, 'Content-Type': 'application/json', 'HTTP-Referer': location.origin, 'X-Title': 'Vendas IA - Maestros da IA' },
        body: JSON.stringify(body)
      }).then(function (r) {
        return r.text().then(function (txt) {
          if (!r.ok) {
            var msg = 'Erro ' + r.status + ' do provedor de IA.';
            try { var j = JSON.parse(txt); msg = (j.error && (j.error.message || j.error)) || msg; } catch (e) {}
            if (r.status === 401) msg = 'Chave inválida ou sem permissão. Confira sua chave da OpenRouter.';
            else if (r.status === 402) msg = 'Créditos insuficientes na sua conta OpenRouter.';
            else if (r.status === 429) msg = 'Muitas requisições ao provedor. Aguarde alguns segundos e tente de novo.';
            var e = new Error(String(msg)); e.httpStatus = r.status; throw e;
          }
          var data; try { data = JSON.parse(txt); } catch (e2) { throw new Error('Resposta inválida do provedor de IA.'); }
          if (data && data.error) throw new Error(String(data.error.message || 'Erro do provedor de IA.'));
          var choice = (data.choices && data.choices[0]) || {};
          var content = (choice.message && choice.message.content) || '';
          if (!content || !String(content).trim()) { var em = new Error('Resposta vazia do modelo.'); em.emptyContent = true; throw em; }
          return String(content);
        });
      });
    };
    var run = function () {
      return doFetch().catch(function (e) {
        if (e && e.emptyContent && body.reasoning) { delete body.reasoning; return doFetch(); } // COR-035 net
        throw e;
      });
    };
    var limited = (window.RateLimiter && RateLimiter.executeWithLimit) ? RateLimiter.executeWithLimit('openrouter', run) : run();
    return Promise.resolve(limited).then(function (res) {
      if (res == null) throw new Error('Limite de uso por minuto atingido. Aguarde um pouco e tente de novo.');
      return res;
    });
  }
  // JSON repair ladder + one strict reroll (COR-032)
  function stripToObject(s) {
    s = String(s).replace(/```json/gi, '').replace(/```/g, '').trim();
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a !== -1 && b !== -1 && b > a) s = s.slice(a, b + 1);
    return s;
  }
  function tryParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
  function parseJSONLadder(raw) {
    var s = stripToObject(raw);
    var o = tryParse(s); if (o) return o;
    var s2 = s.replace(/,\s*([}\]])/g, '$1'); o = tryParse(s2); if (o) return o;
    var s3 = s2.replace(/[\x00-\x1f]+/g, ' '); o = tryParse(s3); if (o) return o;
    var s4 = s3.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"); o = tryParse(s4); if (o) return o;
    return null;
  }
  function callJSON(messages, temperature, signal) {
    return fetchContent(messages, temperature, signal).then(function (txt) {
      var obj = parseJSONLadder(txt);
      if (obj) return obj;
      var strict = messages.concat([{ role: 'user', content: 'Sua resposta anterior NÃO era um JSON válido. Responda novamente APENAS com o objeto JSON pedido, com aspas retas ("), sem markdown, sem comentários, sem texto antes ou depois.' }]);
      return fetchContent(strict, 0.2, signal).then(function (txt2) {
        var obj2 = parseJSONLadder(txt2);
        if (obj2) return obj2;
        throw new Error('O modelo não devolveu um JSON válido. Tente de novo (ou troque de modelo).');
      });
    });
  }

  // ── AI help for column mapping: headers + MASKED samples only ──
  function maskCell(v) {
    var s = String(v || '').trim();
    s = s.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, 'email@exemplo.com');
    s = s.replace(/\d[\d\s().\-]{7,}\d/g, function (x) { return /[\/:]/.test(x) ? x : '#########'; });
    return s.slice(0, 40);
  }
  function aiMap() {
    var raw = state.raw; if (!raw || state.running) return;
    var err = $('map-ai-error');
    if (!activeKey()) { err.textContent = 'Conecte sua chave de IA (ícone de chave no topo) para pedir ajuda à IA.'; err.hidden = false; return; }
    err.hidden = true;
    var cols = raw.headers.map(function (h, i) {
      var nameish = /nome|name|cliente|customer|comprador|buyer|cpf|documento|endere|telefone|phone|celular/i.test(h);
      return { indice: i, titulo: h, exemplos: nameish ? ['(dado pessoal oculto)'] : colSample(raw, i, 3).map(maskCell) };
    });
    var fields = FIELDS.map(function (f) { return f.id + ' = ' + f.label + (f.note ? ' (' + f.note + ')' : ''); }).join('\n');
    var msgs = [
      { role: 'system', content: 'Você mapeia colunas de relatórios de vendas exportados de plataformas brasileiras (Hotmart, Kiwify, Eduzz, Monetizze, Ticto, Stripe, planilhas próprias). Responda SOMENTE com JSON válido.' },
      { role: 'user', content: 'Colunas da planilha (índice, título e até 3 exemplos já anonimizados):\n' + JSON.stringify(cols) + '\n\nCampos que eu preciso:\n' + fields + '\n\nPara cada campo, diga o índice da coluna que melhor corresponde, ou null se não existir. Uma coluna só pode ir para um campo. "data" é a data em que o pedido foi feito (não a de confirmação/reembolso). "bruto" é o valor pago pelo cliente; "liquido" é o valor que fica para o produtor. Formato exato: {"data":0,"status":1,"produto":null,...}' }
    ];
    var btn = $('map-ai'); btn.disabled = true; btn.textContent = 'A IA está lendo os títulos…'; state.running = true;
    callJSON(msgs, 0.1).then(function (o) {
      var map = {}, used = {}, n = 0;
      FIELDS.forEach(function (f) {
        var v = o[f.id]; if (v == null || v === '') return; v = parseInt(v, 10);
        if (isNaN(v) || v < 0 || v >= raw.headers.length || used[v]) return;
        map[f.id] = v; used[v] = true; n++;
      });
      if (!n) throw new Error('A IA não reconheceu nenhuma coluna. Ajuste à mão nas listas abaixo.');
      state.per.map = map; renormalize(); toast('Mapeamento sugerido pela IA — confira as amostras.');
    }).catch(function (e) { err.textContent = e.message; err.hidden = false; })
      .then(function () { state.running = false; btn.disabled = false; btn.textContent = 'Pedir ajuda da IA para ler as colunas'; });
  }

  // ── report ──
  function round1(x) { return Math.round(x * 10) / 10; }
  function topList(list, n, withRefund) { return list.filter(function (x) { return x.gerados > 0; }).slice(0, n).map(function (x) { var o = { nome: shortTxt(x.label, 60), vendas: x.n, faturamento: Math.round(x.b), fatia_pct: round1(x.share) }; if (withRefund && x.paidish) o.reembolso_pct = round1(x.refundPct); return o; }); }
  function buildFacts(m, c) {
    var p = state.per;
    var f = {
      periodo: p.nome || periodName(m), de: dmy(m.start), ate: dmy(m.end), dias: m.dias, plataforma: p.platform || 'planilha de vendas',
      faturamento_bruto: Math.round(m.bruto), faturamento_liquido: m.liquido != null ? Math.round(m.liquido) : null, taxas_e_comissoes: m.taxas != null ? Math.round(m.taxas) : null,
      vendas_aprovadas: m.aprovadas, ticket_medio: Math.round(m.ticket), media_por_dia: Math.round(m.mediaDia),
      reembolsos: m.by.R.n, reembolso_pct: round1(m.reembolsoPct), valor_reembolsado: Math.round(m.reembolsoValor),
      chargebacks: m.by.C.n, chargeback_pct: round1(m.chargebackPct),
      pedidos_nao_pagos_ou_pendentes: m.naMesaN, dinheiro_na_mesa: Math.round(m.naMesa),
      melhor_dia: m.melhorDia ? { data: dm(m.melhorDia.t), faturamento: Math.round(m.melhorDia.b), vendas: m.melhorDia.n } : null,
      concentracao: { dias: m.concentracaoDias, pct_do_faturamento: round1(m.concentracao) },
      melhor_dia_da_semana: m.melhorDiaSemana ? { dia: WEEKDAYS_LONG[m.melhorDiaSemana.d], pct: round1(m.melhorDiaSemana.share) } : null
    };
    if (m.hasHour) { f.melhor_horario = m.melhorHora.h + 'h'; f.vendas_entre_18h_e_24h_pct = round1(m.noite); }
    if (m.temProduto) f.produtos = topList(m.produtos, 8, true);
    if (m.temMetodo) f.meios_de_pagamento = m.metodos.slice(0, 6).map(function (x) { return { meio: x.label, vendas: x.n, faturamento: Math.round(x.b), pagos_de_cada_100_gerados: Math.round(x.conv), pedidos_gerados: x.gerados }; });
    if (m.parcelas.length) f.parcelas_media_cartao = round1(m.parcelaMedia);
    if (m.temOrigem) f.origens = topList(m.origens, 8, true);
    if (m.temCampanha) f.campanhas = topList(m.campanhas, 6);
    if (m.temAfiliado) f.afiliados = topList(m.afiliados, 6, true);
    if (m.cupom.n) f.cupom = { vendas: m.cupom.n, pct_das_vendas: round1(m.cupom.share) };
    if (m.temComprador) f.clientes = { compradores_unicos: m.compradores, compraram_2_ou_mais_produtos: m.multi.n, pct_compradores: round1(m.multi.share), faturamento_deles: Math.round(m.multi.b), combos: m.combos.slice(0, 3).map(function (x) { return x.a + ' + ' + x.b + ' (' + x.n + ')'; }) };
    if (c) {
      f.comparacao = { periodo_anterior: c.__nome, faturamento_bruto_anterior: Math.round(c.bruto), variacao_faturamento_pct: c.bruto ? round1((m.bruto - c.bruto) * 100 / c.bruto) : null, vendas_anterior: c.aprovadas, variacao_vendas_pct: c.aprovadas ? round1((m.aprovadas - c.aprovadas) * 100 / c.aprovadas) : null, ticket_anterior: Math.round(c.ticket), reembolso_pct_anterior: round1(c.reembolsoPct), diferenca_reembolso_pp: round1(m.reembolsoPct - c.reembolsoPct) };
      if (c.liquido != null && m.liquido != null) { f.comparacao.liquido_anterior = Math.round(c.liquido); f.comparacao.variacao_liquido_pct = c.liquido ? round1((m.liquido - c.liquido) * 100 / c.liquido) : null; }
    }
    return f;
  }
  function numbersOf(facts) {
    var nums = [];
    (function walk(o) { if (o == null) return; if (typeof o === 'number') { nums.push(o); return; } if (Array.isArray(o)) { o.forEach(walk); return; } if (typeof o === 'object') Object.keys(o).forEach(function (k) { walk(o[k]); }); })(facts);
    return nums;
  }
  function checkNumbers(rep, facts) {
    var nums = numbersOf(facts), flags = [], seen = {};
    var text = [rep.manchete, rep.linha_fina].concat(rep.resumo || []).concat((rep.destaques || []).map(function (d) { return d.titulo + ' ' + d.texto; })).concat((rep.alertas || []).map(function (d) { return d.titulo + ' ' + d.texto; })).concat((rep.recomendacoes || []).map(function (r) { return r.acao + ' ' + r.porque; })).join(' \n ');
    function near(v, tolAbs, tolRel) { return nums.some(function (n) { return Math.abs(n - v) <= Math.max(tolAbs, Math.abs(n) * tolRel); }); }
    var re = /(-?\d{1,3}(?:[.,]\d+)?)\s?%/g, m;
    while ((m = re.exec(text))) {
      var v = parseFloat(m[1].replace(',', '.'));
      if (near(v, 0.6, 0) || near(Math.abs(v), 0.6, 0) || seen[m[0]]) continue;
      seen[m[0]] = true; flags.push(m[0].trim());
    }
    var re2 = /R\$\s?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)(\s?(mil|mi|milh[õo]es|k)\b)?/gi;
    while ((m = re2.exec(text))) {
      var val = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
      var mult = m[3] ? (/^(mi|milh)/i.test(m[3]) ? 1e6 : 1e3) : 1;
      val *= mult;
      if (near(val, 1.5, mult > 1 ? 0.06 : 0.01) || seen[m[0]]) continue;
      seen[m[0]] = true; flags.push(m[0].trim());
    }
    return flags;
  }
  function summaryMessages(facts) {
    return [
      { role: 'system', content: 'Você é um analista sênior de vendas de infoprodutos e negócios digitais no Brasil (Hotmart, Kiwify, Eduzz, lançamentos, perpétuo, afiliados, tráfego pago). Escreve análises diretas e acionáveis para o dono do negócio, SEMPRE 100% em português do Brasil, sem nenhuma palavra em inglês (exceto termos de mercado comuns como lead, UTM, ticket, upsell, order bump, checkout). Usa SOMENTE os números fornecidos — nunca inventa, soma, arredonda diferente nem calcula percentuais novos. Valores em reais escreva como no dado (ex.: R$ 212.430). Responda SOMENTE com JSON válido.' },
      { role: 'user', content: 'Números calculados a partir do relatório de vendas (fonte única dos números):\n' + JSON.stringify(facts) +
        '\n\nEscreva a análise do período:\n- "manchete": a conclusão principal, estilo manchete de caderno de economia (máx. 90 caracteres).\n- "linha_fina": uma frase de apoio com o número mais importante (máx. 160 caracteres).\n- "resumo": 2 ou 3 parágrafos: como foi o período, o que puxou o resultado, o que preocupa. Cite números exatamente como estão acima.\n- "destaques": 3 ou 4 achados, cada um com "titulo" curto e "texto" de 1–2 frases com o número que o sustenta.\n- "alertas": 0 a 3 riscos concretos (reembolso alto num produto, conversão baixa de boleto/Pix, concentração em poucos dias ou numa única origem/afiliado, dinheiro na mesa), cada um com "titulo" e "texto". Lista vazia se não houver.\n- "recomendacoes": 4 a 6 ações concretas para o próximo período, cada uma com "acao" (verbo no imperativo), "porque" (o dado que justifica) e "prioridade" ("alta", "media" ou "baixa").\nSe houver comparação com o período anterior, comente as variações mais relevantes. Não use markdown.\nFormato exato: {"manchete":"...","linha_fina":"...","resumo":["..."],"destaques":[{"titulo":"...","texto":"..."}],"alertas":[{"titulo":"...","texto":"..."}],"recomendacoes":[{"acao":"...","porque":"...","prioridade":"alta"}]}' }
    ];
  }
  function generateSummary() {
    if (state.running) return;
    var err = $('summary-error');
    if (!activeKey()) { err.textContent = 'Conecte sua chave de IA (ícone de chave no topo) para escrever a análise.'; err.hidden = false; return; }
    if (!state.m || !state.m.aprovadas) { err.textContent = 'Não há vendas aprovadas neste período para analisar — confira o mapeamento de status na aba Planilha.'; err.hidden = false; return; }
    err.hidden = true;
    var facts = buildFacts(state.m, state.cmp);
    var btn = $('summary-btn'); btn.disabled = true; btn.textContent = 'Escrevendo…'; state.running = true;
    $('report-hint').textContent = 'A IA está lendo os números calculados (só agregados — nenhum dado de comprador)…';
    callJSON(summaryMessages(facts), 0.4).then(function (r) {
      function pr(x) { var p = fold(x); return p.indexOf('alt') === 0 ? 'alta' : (p.indexOf('baix') === 0 ? 'baixa' : 'media'); }
      function pair(arr, n) { return (Array.isArray(arr) ? arr : []).map(function (d) { return { titulo: clean(d && d.titulo), texto: clean(d && d.texto) }; }).filter(function (d) { return d.titulo || d.texto; }).slice(0, n); }
      var rep = {
        manchete: clean(r.manchete).slice(0, 140),
        linha_fina: clean(r.linha_fina).slice(0, 240),
        resumo: (Array.isArray(r.resumo) ? r.resumo : [r.resumo]).map(clean).filter(Boolean).slice(0, 4),
        destaques: pair(r.destaques, 5),
        alertas: pair(r.alertas, 3),
        recomendacoes: (Array.isArray(r.recomendacoes) ? r.recomendacoes : []).map(function (x) { return { acao: clean(x && x.acao), porque: clean(x && x.porque), prioridade: pr(x && x.prioridade) }; }).filter(function (x) { return x.acao; }).slice(0, 7),
        at: Date.now(), cmp: state.cmp ? state.cmp.__nome : ''
      };
      if (!rep.resumo.length || !rep.manchete) throw new Error('A IA devolveu uma análise vazia. Tente de novo.');
      rep.flags = checkNumbers(rep, facts);
      state.per.report = rep; save(); renderReport(); toast('Análise escrita');
    }).catch(function (e) { err.textContent = e.message; err.hidden = false; })
      .then(function () { state.running = false; btn.disabled = false; btn.textContent = state.per.report ? 'Reescrever a análise' : 'Escrever a análise'; renderReportHint(); });
  }
  var FLAG_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  function periodName(m) {
    if (!m || !m.start) return 'Período sem nome';
    var a = new Date(m.start), b = new Date(m.end);
    if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) return 'Vendas de ' + MONTHS[a.getMonth()] + ' de ' + a.getFullYear();
    return 'Vendas de ' + dm(m.start) + ' a ' + dmy(m.end);
  }
  function reportInnerHTML() {
    var p = state.per, m = state.m, c = state.cmp, r = p.report;
    var nome = p.nome || periodName(m);
    var head = '<header class="masthead"><p class="mh-top"><span>' + esc(dateline()) + '</span><span>Edição: ' + esc(nome) + '</span></p><p class="mh-title">Caderno de Vendas</p><p class="mh-sub"><span>' + esc((p.platform ? p.platform + ' · ' : '') + dmy(m.start) + ' a ' + dmy(m.end)) + '</span><span>' + plural(m.aprovadas, 'venda aprovada', 'vendas aprovadas') + '</span></p></header>' +
      '<div class="ticker r-ticker">' + tickerHTML(m, c) + '</div>';
    var body = '';
    if (r) {
      body += '<h2 class="r-headline">' + esc(r.manchete) + '</h2>' + (r.linha_fina ? '<p class="r-dek">' + esc(r.linha_fina) + '</p>' : '');
      if (r.cmp && (!c || c.__nome !== r.cmp)) body += '<p class="flag">' + FLAG_ICON + '<span>Esta análise foi escrita comparando com “' + esc(r.cmp) + '”. Você mudou a comparação — reescreva para atualizar o texto.</span></p>';
      body += '<div class="r-cols"><div class="r-lead">' + r.resumo.map(function (x) { return '<p>' + esc(x) + '</p>'; }).join('') +
        (r.flags && r.flags.length ? '<p class="flag">' + FLAG_ICON + '<span>Confira no painel: ' + esc(r.flags.join(', ')) + ' não aparece(m) nos números calculados — a IA pode ter arredondado ou somado por conta própria.</span></p>' : '') + '</div>' +
        '<aside class="r-side">' + (r.destaques.length ? '<p class="r-side-h">Destaques</p>' + r.destaques.map(function (d) { return '<div class="r-hl"><b>' + esc(d.titulo) + '</b><span>' + esc(d.texto) + '</span></div>'; }).join('') : '') +
        (r.alertas.length ? '<p class="r-side-h alert">Alertas</p>' + r.alertas.map(function (d) { return '<div class="r-hl r-alert"><b>' + esc(d.titulo) + '</b><span>' + esc(d.texto) + '</span></div>'; }).join('') : '') + '</aside></div>';
      if (r.recomendacoes.length) body += '<section class="r-section"><h3 class="r-h3">O que fazer no próximo período</h3><ol class="r-recs">' + r.recomendacoes.map(function (x) { return '<li><b>' + esc(x.acao) + '</b><span class="prio ' + x.prioridade + '">prioridade ' + (x.prioridade === 'media' ? 'média' : x.prioridade) + '</span><span class="why">' + esc(x.porque) + '</span></li>'; }).join('') + '</ol></section>';
    } else {
      body += '<h2 class="r-headline">' + esc(nome) + '</h2><p class="r-pending">Clique em <b>Escrever a análise</b> para a IA redigir a manchete, o resumo, os alertas e as recomendações a partir destes números. Os números abaixo já estão prontos.</p>';
    }
    body += '<section class="r-section"><h3 class="r-h3">Os números do período</h3><div class="kp-board">' + kpiBoardHTML(m, c) + '</div></section>';
    body += '<section class="r-section r-dash">' + dashboardHTML(m, c) + '</section>';
    body += '<p class="r-foot">Gerado com Vendas IA · Comunidade Maestros da IA · todos os números foram calculados a partir das ' + fmtInt(p.stats ? p.stats.linhas : m.n) + ' linhas do relatório de vendas' + (r ? '; o texto foi redigido por IA a partir desses números agregados, sem dados de compradores' : '') + '.</p>';
    return head + body;
  }

  // ───────────────────────── exports ─────────────────────────
  function downloadBlob(name, blob) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function csvCell(v) { var s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function num2(v) { return v == null ? '' : NF2.format(v).replace(/\./g, ''); }
  function exportCSV() {
    var p = state.per; if (!p || !p.recs.length) return;
    var D = p.dicts, lines = [['Data', 'Hora', 'Status (normalizado)', 'Produto', 'Valor bruto', 'Valor líquido', 'Meio de pagamento', 'Parcelas', 'Origem', 'Campanha', 'Afiliado', 'Cupom'].join(';')];
    p.recs.forEach(function (r) {
      var d = new Date(r[0]);
      lines.push([dmy(r[0]), r[12] ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) : '', BUCKET_SHORT[BNAME[r[1]]], D.p[r[2]], num2(r[3]), num2(r[4]), methodLabel(D.m[r[5]] || ''), r[6], D.o[r[7]], D.c[r[8]], D.a[r[9]], D.k[r[10]] || ''].map(csvCell).join(';'));
    });
    downloadBlob(slug(p.nome || periodName(state.m)) + '-normalizado.csv', new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    toast('CSV normalizado baixado');
  }
  function exportBuyers() {
    var raw = state.raw, p = state.per;
    if (!raw || p.map.comprador == null) { toast('Importe a planilha de novo para baixar a lista (o e-mail dos compradores não fica salvo).'); return; }
    var map = p.map, sv = {}; statusValues(raw, map, p.statusMap).forEach(function (s) { sv[s.key] = s.bucket; });
    var order = map.data != null ? dateOrderOf(raw.rows.slice(0, 500).map(function (r) { return r[map.data]; })) : 'dmy';
    var nameCol = -1; raw.headers.forEach(function (h, i) { if (nameCol < 0 && /nome (do )?(comprador|cliente)|customer name|buyer name|^cliente$|^nome$/.test(fold(h))) nameCol = i; });
    var B = {};
    raw.rows.forEach(function (r) {
      var k = map.status != null ? (sv[fold(String(r[map.status] || '').trim()) || '(vazio)'] || 'desconhecido') : 'aprovada';
      if (k !== 'aprovada') return;
      var e = String(r[map.comprador] || '').trim(); if (!e) return;
      var key = fold(e), b = B[key] || (B[key] = { email: e, nome: nameCol >= 0 ? String(r[nameCol] || '').trim() : '', prods: {}, n: 0, v: 0, last: 0 });
      var v = map.bruto != null ? Math.abs(parseMoney(r[map.bruto])) : NaN; if (!isNaN(v)) b.v += v;
      b.n++; b.prods[map.produto != null ? String(r[map.produto] || '').trim() : '—'] = 1;
      var d = map.data != null ? parseDate(r[map.data], order) : null; if (d && d.t > b.last) b.last = d.t;
    });
    var list = Object.keys(B).map(function (k) { return B[k]; }).sort(function (a, b) { return Object.keys(b.prods).length - Object.keys(a.prods).length || b.v - a.v; });
    var lines = [['E-mail', 'Nome', 'Produtos comprados', 'Nº de produtos', 'Compras aprovadas', 'Total pago', 'Última compra'].join(';')];
    list.forEach(function (b) { lines.push([b.email, b.nome, Object.keys(b.prods).join(' | '), Object.keys(b.prods).length, b.n, num2(b.v), b.last ? dmy(b.last) : ''].map(csvCell).join(';')); });
    downloadBlob(slug(p.nome || periodName(state.m)) + '-clientes.csv', new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    toast('Lista de clientes baixada (' + plural(list.length, 'comprador', 'compradores') + ')');
  }
  function b64(buf) { var bin = '', u = new Uint8Array(buf); for (var i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(bin); }
  function exportHTML() {
    var p = state.per; if (!p || !state.m) return;
    var btn = $('dl-html'); btn.disabled = true;
    var fonts = ['source-serif-4-var-latin', 'ibm-plex-sans-condensed-400-latin', 'ibm-plex-sans-condensed-500-latin', 'ibm-plex-sans-condensed-700-latin', 'ibm-plex-mono-500-latin'];
    Promise.all([fetch('styles.css').then(function (r) { return r.text(); })].concat(fonts.map(function (f) { return fetch('fonts/' + f + '.woff2').then(function (r) { return r.arrayBuffer(); }).then(function (b) { return [f, b64(b)]; }).catch(function () { return [f, null]; }); })))
      .then(function (res) {
        var css = res[0];
        res.slice(1).forEach(function (x) { if (x[1]) css = css.split("url('fonts/" + x[0] + ".woff2')").join("url(data:font/woff2;base64," + x[1] + ")"); });
        var title = (p.report && p.report.manchete) || p.nome || periodName(state.m);
        var html = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' + esc(title) + '</title><style>' + css + '\nbody{padding:24px 12px}.report{max-width:1040px;margin:0 auto}</style></head><body><article class="report">' + reportInnerHTML() + '</article></body></html>';
        downloadBlob(slug(p.nome || periodName(state.m)) + '-relatorio.html', new Blob([html], { type: 'text/html;charset=utf-8' }));
        toast('Relatório .html baixado');
      }).catch(function () { toast('Não consegui montar o arquivo. Tente de novo.'); })
      .then(function () { btn.disabled = false; });
  }
  function wrapLines(ctx, text, maxW, maxLines) {
    var words = String(text).split(/\s+/), lines = [], line = '';
    words.forEach(function (w) { var t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; });
    if (line) lines.push(line);
    if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…'; }
    return lines;
  }
  function exportPNG() {
    var p = state.per, m = state.m, c = state.cmp; if (!p || !m) return;
    var go = function () {
      var W = 1080, H = 1350, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      var x = cv.getContext('2d');
      x.fillStyle = C.paper; x.fillRect(0, 0, W, H);
      var serif = '"Source Serif 4", Georgia, serif', cond = '"IBM Plex Sans Condensed", "Arial Narrow", sans-serif';
      // masthead
      x.fillStyle = C.ink; x.font = '500 22px ' + cond; x.fillText(dateline().toUpperCase(), 64, 70);
      x.textAlign = 'right'; x.fillText(shortTxt(p.nome || periodName(m), 40).toUpperCase(), W - 64, 70); x.textAlign = 'left';
      x.fillRect(64, 88, W - 128, 3); x.fillRect(64, 96, W - 128, 1);
      x.font = '700 96px ' + serif; x.textAlign = 'center'; x.fillText('Caderno de Vendas', W / 2, 192); x.textAlign = 'left';
      x.fillRect(64, 216, W - 128, 1); x.fillRect(64, 222, W - 128, 3);
      var y = 300;
      x.fillStyle = C.ink; x.font = '700 54px ' + serif;
      wrapLines(x, (p.report && p.report.manchete) || (p.nome || periodName(m)), W - 128, 3).forEach(function (l) { x.fillText(l, 64, y); y += 64; });
      if (p.report && p.report.linha_fina) { x.fillStyle = C.ink2; x.font = '400 28px ' + serif; wrapLines(x, p.report.linha_fina, W - 128, 3).forEach(function (l) { y += 4; x.fillText(l, 64, y + 18); y += 38; }); }
      y += 40;
      // KPI market table
      var items = tickerItems(m, c).slice(0, 6);
      var colW = (W - 128) / 2;
      items.forEach(function (it, i) {
        var cx = 64 + (i % 2) * colW, cy = y + Math.floor(i / 2) * 128;
        x.fillStyle = C.rule; x.fillRect(cx, cy, colW - 24, 1);
        x.fillStyle = C.ink2; x.font = '500 22px ' + cond; x.fillText(it.k.toUpperCase(), cx, cy + 34);
        x.fillStyle = C.ink; x.font = '700 50px ' + cond; x.fillText(it.v, cx, cy + 92);
        if (c && it.d) {
          var v = it.pp ? it.d.abs : it.d.pct;
          if (v != null) {
            var good = it.invert ? v < 0 : v > 0;
            x.fillStyle = Math.abs(v) < 0.05 ? C.ink2 : (good ? C.up : C.down); x.font = '700 24px ' + cond; x.textAlign = 'right';
            x.fillText((v > 0 ? '▲ +' : (v < 0 ? '▼ −' : '■ ')) + NF1.format(Math.abs(v)) + (it.pp ? ' p.p.' : '%'), cx + colW - 30, cy + 34); x.textAlign = 'left';
          }
        }
      });
      y += Math.ceil(items.length / 2) * 128 + 20;
      // daily mini chart
      var S = m.series, ch = 190, cw = W - 128;
      if (S.length && y + ch + 150 < H) {
        x.fillStyle = C.claret; x.font = '700 22px ' + cond; x.fillText('FATURAMENTO APROVADO POR DIA', 64, y + 4);
        var max = Math.max.apply(null, S.map(function (s) { return s.b; }).concat([1])), bw = cw / S.length, base = y + 24 + ch;
        x.fillStyle = C.grid; for (var g = 0; g <= 3; g++) x.fillRect(64, base - g * ch / 3, cw, 1);
        S.forEach(function (s, i) { var h = s.b / max * ch; x.fillStyle = (m.melhorDia && s.t === m.melhorDia.t) ? C.claret : C.blue; x.fillRect(64 + i * bw + bw * 0.15, base - h, Math.max(1, bw * 0.7), h); });
        x.fillStyle = C.ink; x.fillRect(64, base, cw, 2);
        x.fillStyle = C.ink2; x.font = '400 20px ' + cond; x.fillText(dm(m.start), 64, base + 28); x.textAlign = 'right'; x.fillText(dm(m.end), W - 64, base + 28); x.textAlign = 'left';
        y = base + 60;
      }
      // top product
      if (m.temProduto && m.produtos[0] && y < H - 170) {
        x.fillStyle = C.ink2; x.font = '500 22px ' + cond; x.fillText('PRODUTO QUE MAIS FATUROU', 64, y + 10);
        x.fillStyle = C.ink; x.font = '700 32px ' + serif; x.fillText(shortTxt(m.produtos[0].label, 44), 64, y + 52);
        x.font = '700 30px ' + cond; x.textAlign = 'right'; x.fillText(brl(m.produtos[0].b) + ' · ' + fmtPct(m.produtos[0].share), W - 64, y + 52); x.textAlign = 'left';
      }
      x.fillStyle = C.ink; x.fillRect(0, H - 80, W, 80);
      x.fillStyle = C.paper; x.font = '500 22px ' + cond; x.fillText('Vendas IA · Comunidade Maestros da IA', 64, H - 32);
      x.textAlign = 'right'; x.fillText('números calculados linha a linha', W - 64, H - 32); x.textAlign = 'left';
      try {
        var url = cv.toDataURL('image/png'), bin = atob(url.split(',')[1]), arr = new Uint8Array(bin.length); // COR-064: sync encode
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        downloadBlob(slug(p.nome || periodName(m)) + '-capa.png', new Blob([arr], { type: 'image/png' }));
        toast('Capa do período baixada');
      } catch (e) { toast('Não consegui gerar a imagem.'); }
    };
    if (document.fonts && document.fonts.load) Promise.all(['700 54px "Source Serif 4"', '500 22px "IBM Plex Sans Condensed"', '700 50px "IBM Plex Sans Condensed"'].map(function (f) { return document.fonts.load(f); })).then(go, go); else go();
  }

  // ───────────────────────── import ─────────────────────────
  function showImportError(msg) { var e = $('import-error'); e.textContent = msg || ''; e.hidden = !msg; }
  function loadTable(rows, fileName) {
    if (!rows || rows.length < 2) { showImportError('Não encontrei vendas: a planilha precisa da linha de títulos e de pelo menos uma venda.'); return false; }
    var hr = findHeaderRow(rows);
    rows = rows.slice(hr);
    var headers = rows[0].slice(0, MAX_COLS).map(function (h, i) { return clean(h) || ('Coluna ' + colLetter(i)); });
    var body = rows.slice(1, MAX_ROWS + 1).map(function (r) {
      var o = []; for (var i = 0; i < headers.length; i++) o.push(String(r[i] == null ? '' : r[i]).slice(0, MAX_CELL));
      return o;
    });
    var truncated = rows.length - 1 > MAX_ROWS;
    saveNow();
    var p = newPeriod();
    p.file = fileName || 'planilha colada';
    p.headers = headers;
    state.raw = { headers: headers, rows: body };
    p.platform = detectPlatform(headers);
    p.map = autoMap(state.raw);
    state.per = p;
    var res = normalize(state.raw, p.map, p.statusMap);
    p.recs = res.recs; p.dicts = res.dicts; p.stats = res.stats;
    var mm = compute(p);
    p.nome = periodName(mm);
    showImportError(truncated ? 'A planilha tinha mais de ' + fmtInt(MAX_ROWS) + ' linhas — usei as primeiras ' + fmtInt(MAX_ROWS) + '. Exporte um período menor para analisar tudo.' : '');
    refreshMetrics(); saveNow(); paintAll();
    toast(plural(body.length, 'linha lida', 'linhas lidas') + (p.platform ? ' · formato ' + p.platform : ''));
    return true;
  }
  function handleFile(file) {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { showImportError('Arquivo grande demais (máx. 25 MB). Exporte um período menor.'); return; }
    var isX = /\.(xlsx|xls|xlsm|ods)$/i.test(file.name);
    var isT = /\.(csv|tsv|txt)$/i.test(file.name) || /text|csv/.test(file.type || '');
    if (!isX && !isT) { showImportError('Envie o relatório em .csv ou .xlsx (na plataforma: Relatórios/Vendas → Exportar).'); return; }
    showImportError('');
    if (isX) {
      var frx = new FileReader();
      frx.onload = function () {
        ensureXLSX().then(function () {
          var rows;
          try { rows = rowsFromWorkbook(new Uint8Array(frx.result)); } catch (e) { showImportError('Não consegui ler esta planilha do Excel. Tente salvá-la como .csv.'); return; }
          loadTable(rows, file.name);
        }).catch(function () { showImportError('Não consegui carregar o leitor de Excel. Tente de novo ou envie em .csv.'); });
      };
      frx.onerror = function () { showImportError('Não consegui ler o arquivo.'); };
      frx.readAsArrayBuffer(file);
    } else {
      var fr = new FileReader();
      fr.onload = function () {
        var txt = String(fr.result || '');
        if (/�/.test(txt.slice(0, 4000))) { // not UTF-8 → retry as Windows-1252 (Excel BR)
          var fr2 = new FileReader();
          fr2.onload = function () { loadTable(parseCSV(String(fr2.result || '')), file.name); };
          fr2.readAsText(file, 'windows-1252');
          return;
        }
        loadTable(parseCSV(txt), file.name);
      };
      fr.onerror = function () { showImportError('Não consegui ler o arquivo.'); };
      fr.readAsText(file, 'utf-8');
    }
    $('file-input').value = '';
  }
  function loadPasted() {
    var t = $('in-paste').value;
    if (!t.trim()) { toast('Cole as células da planilha primeiro.'); return; }
    if (loadTable(parseCSV(t), 'planilha colada')) $('in-paste').value = '';
  }
  function loadExample() {
    if (state.running) return;
    fetch('samples/exemplo-vendas.csv').then(function (r) { if (!r.ok) throw new Error(); return r.text(); }).then(function (t) {
      if (loadTable(parseCSV(t), 'exemplo-vendas.csv')) { state.per.nome = 'Exemplo — Lançamento de setembro (Hotmart)'; saveNow(); paintAll(); }
    }).catch(function () { showImportError('Não consegui carregar o exemplo. Tente de novo.'); });
  }
  function renormalize() {
    var p = state.per, raw = state.raw; if (!p || !raw) return;
    var res = normalize(raw, p.map, p.statusMap);
    p.recs = res.recs; p.dicts = res.dicts; p.stats = res.stats; p.report = null;
    refreshMetrics(); save(); paintAll();
  }
  function refreshMetrics() {
    var p = state.per;
    state.m = p && p.recs && p.recs.length ? compute(p) : null;
    state.cmp = null;
    if (p && p.compareId && p.compareId !== p.id) {
      var o = getPeriod(p.compareId);
      if (o && o.recs && o.recs.length) { state.cmp = compute(o); state.cmp.__nome = o.nome || periodName(state.cmp); }
      else p.compareId = '';
    }
  }

  // ───────────────────────── rendering ─────────────────────────
  function hasData() { return !!(state.per && state.per.recs && state.per.recs.length); }
  function gotoTab(name) {
    document.querySelectorAll('.tab').forEach(function (t) { var on = t.getAttribute('data-tab') === name; t.classList.toggle('on', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); });
    document.querySelectorAll('.pane').forEach(function (pn) { pn.classList.toggle('on', pn.id === 'pane-' + name); });
    if (name === 'painel') renderDash();
    if (name === 'relatorio') renderReport();
    if (name === 'arquivo') renderArchive();
    if (name === 'planilha') renderMapping();
    var main = document.querySelector('.app-main'); if (main && main.getBoundingClientRect().top < 0) main.scrollIntoView({ block: 'start' });
  }
  function renderHeader() {
    var pill = $('period-pill'), p = state.per;
    if (hasData()) { pill.textContent = shortTxt(p.nome || periodName(state.m), 48) + ' · ' + fmtInt(state.m.aprovadas) + ' aprovadas'; pill.hidden = false; } else pill.hidden = true;
  }
  function optCols(sel) {
    var raw = state.raw;
    return '<option value="-1">— não tem —</option>' + raw.headers.map(function (h, i) { return '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + colLetter(i) + ' · ' + esc(shortTxt(h, 44)) + '</option>'; }).join('');
  }
  function renderMapping() {
    var p = state.per, has = hasData() || !!state.raw;
    $('intake').hidden = has; $('mapping').hidden = !has;
    if (!has) return;
    if (document.activeElement !== $('in-nome')) $('in-nome').value = p.nome || '';
    var st = p.stats || {}, sk = st.skipped || {};
    var lost = (sk.semData || 0) + (sk.semValor || 0) + (sk.statusAberto || 0);
    var sum = plural(st.linhas || 0, 'linha', 'linhas') + ' lidas de <b>' + esc(p.file) + '</b>' + (p.platform ? ' · formato reconhecido: <b>' + esc(p.platform) + '</b>' : ' · formato genérico') + '. ' +
      '<b>' + fmtInt(st.vendas || 0) + '</b> entraram na conta' + (st.dupes ? ', ' + plural(st.dupes, 'duplicada removida', 'duplicadas removidas') : '') + (sk.ignoradas ? ', ' + plural(sk.ignoradas, 'ignorada', 'ignoradas') + ' por você' : '') + '.';
    var warns = [];
    if (sk.semData) warns.push(plural(sk.semData, 'linha sem data reconhecível ficou', 'linhas sem data reconhecível ficaram') + ' de fora.');
    if (sk.semValor) warns.push(plural(sk.semValor, 'linha sem valor ficou', 'linhas sem valor ficaram') + ' de fora.');
    if (sk.statusAberto) warns.push(plural(sk.statusAberto, 'linha tem', 'linhas têm') + ' status ainda sem classificação — defina abaixo.');
    if (st.negatives) warns.push(plural(st.negatives, 'valor negativo foi lido', 'valores negativos foram lidos') + ' como positivo (estornos costumam vir assim).');
    $('map-summary').innerHTML = sum + (warns.length ? '<span class="map-warn">' + esc(warns.join(' ')) + '</span>' : '');
    $('map-lost').hidden = !lost;
    if (!state.raw) {
      $('map-live').hidden = true; $('map-saved').hidden = false;
      $('map-saved-list').innerHTML = FIELDS.map(function (f) { var ci = p.map[f.id]; return '<li><b>' + esc(f.label) + ':</b> ' + (ci != null && p.headers[ci] ? esc(p.headers[ci]) : '<span class="muted">não mapeado</span>') + '</li>'; }).join('');
      return;
    }
    $('map-live').hidden = false; $('map-saved').hidden = true;
    var missing = FIELDS.filter(function (f) { return f.req && p.map[f.id] == null; });
    $('map-missing').hidden = !missing.length;
    $('map-missing').textContent = missing.length ? 'Faltam campos importantes: ' + missing.map(function (f) { return f.label; }).join(', ') + '. Escolha a coluna certa ou peça ajuda da IA.' : '';
    $('field-list').innerHTML = FIELDS.map(function (f) {
      var ci = p.map[f.id], smp = ci != null ? colSample(state.raw, ci, 3) : [];
      if (f.id === 'comprador') smp = smp.map(function (v) { return v.replace(/^(.).*?(@.*)$/, '$1•••$2'); });
      return '<div class="fld' + (f.req && ci == null ? ' fld-missing' : '') + '"><div class="fld-name"><label for="fld-' + f.id + '">' + esc(f.label) + (f.req ? ' <span class="req">*</span>' : '') + '</label>' + (f.note ? '<span class="fld-note">' + esc(f.note) + '</span>' : '') + '</div>' +
        '<select id="fld-' + f.id + '" data-field="' + f.id + '">' + optCols(ci) + '</select>' +
        '<p class="fld-sample">' + (smp.length ? '<b>ex.:</b> ' + esc(smp.map(function (v) { return shortTxt(v, 34); }).join(' · ')) : '<span class="muted">' + (ci != null ? '(coluna vazia)' : 'sem coluna') + '</span>') + '</p></div>';
    }).join('');
    $('field-list').querySelectorAll('select[data-field]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var f = sel.getAttribute('data-field'), v = parseInt(sel.value, 10);
        Object.keys(p.map).forEach(function (k) { if (k !== f && p.map[k] === v) delete p.map[k]; });
        if (v < 0) delete p.map[f]; else p.map[f] = v;
        if (f === 'status') p.statusMap = {};
        renormalize();
      });
    });
    var svs = statusValues(state.raw, p.map, p.statusMap);
    $('status-wrap').hidden = !svs.length;
    $('status-none').hidden = p.map.status != null;
    $('status-list').innerHTML = svs.map(function (s) {
      return '<div class="st-row' + (s.bucket === 'desconhecido' ? ' st-open' : '') + '"><span class="st-raw">' + esc(shortTxt(s.label, 40)) + '</span><span class="st-n">' + fmtInt(s.count) + '</span>' +
        '<select data-st="' + esc(s.key) + '" aria-label="Classificação do status ' + esc(s.label) + '">' + (s.bucket === 'desconhecido' ? '<option value="desconhecido" selected>— escolha —</option>' : '') + BUCKETS.map(function (b) { return '<option value="' + b.id + '"' + (b.id === s.bucket ? ' selected' : '') + '>' + esc(b.label) + '</option>'; }).join('') + '</select>' +
        '<span class="st-auto">' + (s.auto ? 'automático' : (s.bucket === 'desconhecido' ? 'defina' : 'definido por você')) + '</span></div>';
    }).join('');
    $('status-list').querySelectorAll('select[data-st]').forEach(function (sel) {
      sel.addEventListener('change', function () { p.statusMap[sel.getAttribute('data-st')] = sel.value; renormalize(); });
    });
  }
  function renderCompareSelect(sel) {
    var p = state.per, list = loadList().filter(function (x) { return x.id !== p.id && x.recs && x.recs.length; });
    sel.innerHTML = '<option value="">Não comparar</option>' + list.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === p.compareId ? ' selected' : '') + '>' + esc(shortTxt(x.nome || 'Período sem nome', 56)) + '</option>'; }).join('');
    sel.disabled = !list.length;
    return list.length;
  }
  function renderDash() {
    var has = hasData() && state.m;
    $('dash-empty').hidden = has; $('dash').hidden = !has;
    if (!has) return;
    var m = state.m, c = state.cmp;
    var n = renderCompareSelect($('cmp-select'));
    $('cmp-note').textContent = n ? (c ? 'Setas: variação em relação a “' + c.__nome + '”. Verde é bom, vermelho é ruim (num reembolso, subir é ruim).' : 'Escolha um período salvo para ver as setas de variação.') : 'Importe outro período (ex.: o mês anterior) para comparar. Cada importação fica salva em “Períodos salvos”.';
    $('ticker').innerHTML = tickerHTML(m, c);
    $('kp-board').innerHTML = kpiBoardHTML(m, c);
    $('dash-blocks').innerHTML = m.aprovadas ? dashboardHTML(m, c) : '<div class="empty"><p class="empty-title">Nenhuma venda aprovada neste período.</p><p>Confira a classificação dos status na aba Planilha.</p></div>';
  }
  function renderReportHint() {
    var r = state.per && state.per.report;
    if (state.running) return;
    $('report-hint').textContent = r ? 'Mudou o mapeamento ou a comparação? Reescreva para atualizar o texto.' : 'Leva de 15 a 60 segundos. Só os números agregados vão para a IA.';
  }
  function renderReport() {
    var has = hasData() && state.m;
    $('report-empty').hidden = has; $('report-wrap').hidden = !has;
    if (!has) return;
    if (window.ApiKeyManager) { var ms = $('model-select'); if (ms && !ms.options.length) ApiKeyManager.renderModelPicker('model-select'); }
    renderCompareSelect($('cmp-select-r'));
    $('report').innerHTML = reportInnerHTML();
    if (!state.running) $('summary-btn').textContent = state.per.report ? 'Reescrever a análise' : 'Escrever a análise';
    renderReportHint();
    $('dl-buyers').hidden = !(state.raw && state.per.map.comprador != null);
  }
  function renderArchive() {
    var list = loadList(), cur = state.per && state.per.id, box = $('archive');
    if (!list.length) { box.innerHTML = '<div class="empty"><p class="empty-title">Nenhum período salvo ainda.</p><p>Importe um relatório de vendas — ele é guardado aqui automaticamente (sem os dados dos compradores).</p></div>'; return; }
    box.innerHTML = list.map(function (x) {
      var mm = x.recs && x.recs.length ? compute(x) : null, d = new Date(x.updatedAt || x.createdAt);
      return '<article class="arch-card' + (x.id === cur ? ' current' : '') + '"><p class="arch-kicker">' + esc(x.platform || 'Planilha') + ' · atualizado em ' + pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear() + '</p><h3 class="arch-name">' + esc(x.nome || 'Período sem nome') + '</h3>' +
        (mm ? '<p class="arch-nums"><span><b>' + esc(brl(mm.bruto)) + '</b> bruto</span><span><b>' + fmtInt(mm.aprovadas) + '</b> vendas</span><span><b>' + fmtPct(mm.reembolsoPct) + '</b> reembolso</span></p><p class="arch-meta">' + esc(dmy(mm.start)) + ' a ' + esc(dmy(mm.end)) + (x.report ? ' · com análise' : '') + '</p>' : '') +
        '<div class="arch-actions">' + (x.id === cur ? '<span class="tag">Aberto agora</span>' : '<button type="button" class="btn-secondary btn-sm" data-open="' + esc(x.id) + '">Abrir</button>' + (cur && hasData() ? '<button type="button" class="btn-ghost btn-sm" data-cmp="' + esc(x.id) + '">Comparar com o aberto</button>' : '')) + '<button type="button" class="btn-ghost btn-sm" data-delete="' + esc(x.id) + '">Excluir</button></div></article>';
    }).join('');
    box.querySelectorAll('[data-open]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (state.running) return; saveNow();
        var x = getPeriod(b.getAttribute('data-open')); if (!x) return;
        state.per = x; state.raw = null; try { localStorage.setItem(CURRENT_SLOT, x.id); } catch (e) {}
        refreshMetrics(); paintAll(); gotoTab('painel'); toast('Período aberto');
      });
    });
    box.querySelectorAll('[data-cmp]').forEach(function (b) {
      b.addEventListener('click', function () { state.per.compareId = b.getAttribute('data-cmp'); refreshMetrics(); saveNow(); gotoTab('painel'); toast('Comparação ligada'); });
    });
    box.querySelectorAll('[data-delete]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (state.running) return;
        var id = b.getAttribute('data-delete'), x = getPeriod(id);
        if (!confirm('Excluir “' + ((x && x.nome) || 'período sem nome') + '” deste navegador?')) return;
        try { localStorage.setItem(LIST_SLOT, JSON.stringify(loadList().filter(function (y) { return y.id !== id; }))); } catch (e) {}
        if (state.per && state.per.compareId === id) state.per.compareId = '';
        if (state.per && state.per.id === id) { state.per = newPeriod(); state.raw = null; try { localStorage.removeItem(CURRENT_SLOT); } catch (e) {} }
        refreshMetrics(); paintAll(); renderArchive(); toast('Período excluído');
      });
    });
  }
  function paintAll() {
    renderHeader(); renderMapping();
    if ($('pane-painel').classList.contains('on')) renderDash();
    if ($('pane-relatorio').classList.contains('on')) renderReport();
    if ($('pane-arquivo').classList.contains('on')) renderArchive();
  }
  function startNew() {
    if (state.running) return;
    saveNow(); state.per = newPeriod(); state.raw = null; state.m = null; state.cmp = null;
    try { localStorage.removeItem(CURRENT_SLOT); } catch (e) {}
    showImportError(''); paintAll(); gotoTab('planilha');
  }
  function onCompareChange(sel) {
    state.per.compareId = sel.value; refreshMetrics(); saveNow();
    if ($('pane-painel').classList.contains('on')) renderDash(); else renderReport();
  }

  // ───────────────────────── init ─────────────────────────
  function init() {
    if (state.wired) { if (window.ApiKeyManager) { var s0 = $('model-select'); if (s0 && !s0.options.length) ApiKeyManager.renderModelPicker('model-select'); } return; }
    state.wired = true;
    var cur = null; try { cur = localStorage.getItem(CURRENT_SLOT); } catch (e) {}
    state.per = (cur && getPeriod(cur)) || newPeriod();
    refreshMetrics();

    if (window.ApiKeyManager) ApiKeyManager.renderModelPicker('model-select'); // COR-041/047

    document.querySelectorAll('.tab').forEach(function (b) { b.addEventListener('click', function () { gotoTab(b.getAttribute('data-tab')); }); });
    document.querySelectorAll('[data-goto]').forEach(function (b) { b.addEventListener('click', function () { gotoTab(b.getAttribute('data-goto')); }); });

    var dz = $('dropzone'), fi = $('file-input');
    fi.addEventListener('change', function () { handleFile(fi.files && fi.files[0]); });
    ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('drag'); }); });
    dz.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });
    $('paste-load').addEventListener('click', loadPasted);
    $('example-btn').addEventListener('click', loadExample);
    $('in-nome').addEventListener('input', function () { state.per.nome = this.value.slice(0, 100); save(); renderHeader(); });
    $('reset-period').addEventListener('click', startNew);
    $('reimport').addEventListener('click', startNew);
    $('map-ai').addEventListener('click', aiMap);
    $('to-painel').addEventListener('click', function () { saveNow(); gotoTab('painel'); });

    $('cmp-select').addEventListener('change', function () { onCompareChange(this); });
    $('cmp-select-r').addEventListener('change', function () { onCompareChange(this); });
    $('summary-btn').addEventListener('click', generateSummary);
    $('dl-pdf').addEventListener('click', function () { window.print(); });
    $('dl-html').addEventListener('click', exportHTML);
    $('dl-png').addEventListener('click', exportPNG);
    $('dl-csv').addEventListener('click', exportCSV);
    $('dl-buyers').addEventListener('click', exportBuyers);
    $('new-period').addEventListener('click', startNew);

    // COR-062: logout must leave the login form empty for the next person
    var lo = $('logout-btn');
    if (lo) lo.addEventListener('click', function () {
      var em = $('gate-email'), ph = $('gate-phone'), er = $('gate-error');
      if (em) em.value = ''; if (ph) ph.value = ''; if (er) { er.textContent = ''; er.style.display = 'none'; }
    });
    $('wipe-local').addEventListener('click', function () {
      if (state.running) { toast('Aguarde a IA terminar.'); return; }
      if (!confirm('Apagar deste navegador todos os períodos, análises, a sua chave de IA e a sua sessão? Isso não pode ser desfeito.')) return;
      state.wiping = true;
      try {
        var drop = [];
        for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (/^(vendas|maestria_)/.test(k)) drop.push(k); }
        drop.forEach(function (k) { localStorage.removeItem(k); });
      } catch (e) {}
      location.reload();
    });
    window.addEventListener('beforeunload', function () { if (!state.wiping) saveNow(); });

    paintAll();
    if (hasData()) gotoTab(state.per.report ? 'relatorio' : 'painel');
  }

  return { init: init, _t: { parseCSV: parseCSV, autoMap: autoMap, detectPlatform: detectPlatform, normalize: normalize, compute: compute, parseMoney: parseMoney, parseDate: parseDate, autoBucket: autoBucket, statusValues: statusValues, buildFacts: function (m, c) { return buildFacts(m, c); }, checkNumbers: checkNumbers, setPer: function (p) { state.per = p; } } };
})();

// ── App init triggers: event + DOMContentLoaded + MutationObserver (COR-044) ──
(function () {
  var started = false;
  function go() { if (started) { App.init(); return; } started = true; App.init(); }
  document.addEventListener('maestria:app-ready', go);
  document.addEventListener('DOMContentLoaded', function () {
    var app = document.getElementById('app-screen');
    if (app && app.classList.contains('active')) { setTimeout(go, 100); }
    if (app) {
      var mo = new MutationObserver(function () { if (app.classList.contains('active')) go(); });
      mo.observe(app, { attributes: true, attributeFilter: ['class'] });
    }
  });
})();

// Key inputs live in <form>s (no "password field outside a form" note); Enter must not reload the page.
document.addEventListener('submit', function (e) {
  var id = e.target && e.target.id;
  if (id === 'key-inputs' || id === 'modal-key-inputs') e.preventDefault();
}, true);
