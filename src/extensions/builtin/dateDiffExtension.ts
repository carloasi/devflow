import { ExtensionRecord } from '../useExtensionHost';

// ─────────────────────────────────────────────────────────────────────────
// Extensão embutida: relógio do rodapé + calculadora de diferença de datas.
//
// Isto era o componente nativo `DateDiffPopover` (React, dentro do
// AppLayout). Foi portado pra extensão de propósito: é a prova de que a
// API pública do host dá conta de um widget real de verdade — se algo que o
// próprio app usa não puder ser escrito como extensão, a API está incompleta.
//
// "Built-in" quer dizer que ela vem junto do binário (o HTML é esta string,
// não uma pasta no disco), então nunca some por falta de instalação. Fora
// isso ela é uma extensão igual às outras: roda em iframe sandbox, sem
// acesso ao DOM nem ao storage do app, e pode ser desativada em
// Settings → Extensions.
//
// Não pede nenhuma permissão: só usa `devflow.ui.*`, que é o namespace do
// próprio host (redimensionar/expandir/colapsar o widget).
// ─────────────────────────────────────────────────────────────────────────

const DATE_DIFF_HTML = `
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; background: transparent; overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    color: var(--color-pm-text-secondary);
  }
  body { display: flex; flex-direction: column; height: 100vh; }

  /* Painel em cima, relógio embaixo: expandido, o iframe vira um overlay
     ancorado no rodapé, então o relógio precisa ficar na última linha pra
     continuar exatamente onde estava na barra de status. */
  #panel { display: none; flex: 1; min-height: 0; overflow: auto; padding: 12px; }
  body.open #panel { display: block; }

  #bar { height: 22px; display: flex; align-items: center; justify-content: flex-end; }
  #trigger {
    display: inline-flex; align-items: center; gap: 4px;
    height: 22px; padding: 0 8px; border: 0; background: transparent;
    font: inherit; font-size: 11px; line-height: 1; cursor: pointer;
    color: var(--color-pm-text-muted); white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  #trigger:hover { background: var(--color-pm-hover); color: var(--color-pm-text-secondary); }
  body.open #trigger { background: var(--color-pm-row-active); color: var(--color-pm-text); }

  .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .title {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 10px; text-transform: uppercase; font-weight: 600;
    letter-spacing: .06em; color: var(--color-pm-text-muted);
  }
  .head-actions { display: flex; align-items: center; gap: 4px; }
  .icon-btn {
    border: 0; background: transparent; cursor: pointer; padding: 2px;
    border-radius: 4px; color: var(--color-pm-text-muted); line-height: 0;
  }
  .icon-btn:hover { color: var(--color-pm-text); }
  .icon-btn.on { color: #fbbf24; }

  input {
    width: 100%; height: 30px; padding: 0 9px;
    background: var(--color-pm-hover);
    border: 1px solid var(--color-pm-border); border-radius: 6px;
    color: var(--color-pm-text); font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    outline: none;
  }
  input:focus { border-color: #007acc; }
  input + input { margin-top: 6px; }

  #result { margin-top: 10px; min-height: 76px; }
  .hint { font-size: 11px; line-height: 1.5; color: var(--color-pm-text-muted); margin: 0; }
  .error { font-size: 11.5px; color: #fb7185; margin: 0; }
  .rows { display: flex; flex-direction: column; gap: 6px; }
  .tagline { display: flex; align-items: center; gap: 6px; }
  .tag {
    padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; flex-shrink: 0;
    background: var(--color-pm-hover); color: var(--color-pm-text-secondary);
  }
  .tag.utc { background: rgba(60,137,224,.15); color: #3c89e0; }
  .reason { font-size: 10px; color: var(--color-pm-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .big { font-size: 14px; font-weight: 600; color: var(--color-pm-text); }
  .stamps {
    display: flex; flex-direction: column; gap: 2px;
    font-size: 10.5px; color: var(--color-pm-text-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .stamps .gap { margin-top: 4px; }
</style>

<div id="panel">
  <div class="head">
    <span class="title">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M12 14v3l2 1"/></svg>
      Date difference
    </span>
    <span class="head-actions">
      <button type="button" id="pin" class="icon-btn" title="Pin (keep open while you work)">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 10.76V7a3 3 0 0 1 6 0v3.76a2 2 0 0 0 .59 1.42L17 13.5V17H7v-3.5l1.41-1.32A2 2 0 0 0 9 10.76Z"/></svg>
      </button>
      <button type="button" id="close" class="icon-btn" title="Close">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </span>
  </div>

  <input id="input" placeholder="Paste or type a date..." spellcheck="false" />
  <input id="compare" placeholder="Compare to... (leave empty for now)" spellcheck="false" />

  <div id="result"></div>
</div>

<div id="bar">
  <button type="button" id="trigger" title="Date difference calculator (Ctrl+Shift+D)">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
    <span id="clock"></span>
  </button>
</div>

<script>
(function () {
  var PANEL_H = 236;   // altura do painel aberto
  var PANEL_W = 320;
  var BAR_H = 22;

  var body = document.body;
  var clockEl = document.getElementById('clock');
  var triggerEl = document.getElementById('trigger');
  var inputEl = document.getElementById('input');
  var compareEl = document.getElementById('compare');
  var resultEl = document.getElementById('result');
  var pinEl = document.getElementById('pin');
  var closeEl = document.getElementById('close');

  var open = false;
  var pinned = false;
  var now = new Date();
  var collapsedWidth = 150;

  // ── Parser (portado de src/lib/dateDiff.ts) ────────────────────────────
  // Regra: texto com marcador de UTC ("Z", "UTC", "GMT", offset zero) ou
  // epoch puro conta como UTC; sem marcador nenhum, assume horário local
  // (mesmo padrão do Date do JS), e isso fica explícito no resultado.
  var EPOCH_ONLY = /^[+-]?\\d+(\\.\\d+)?$/;
  var UTC_MARKER = /(Z|UTC|GMT)\\s*$/i;
  var ZERO_OFFSET = /[+-]00:?00$/;
  var EXPLICIT_OFFSET = /[+-]\\d{2}:?\\d{2}$/;
  var DATE_ONLY = /^\\d{4}-\\d{2}-\\d{2}$/;

  function parseFlexibleDate(raw) {
    var input = String(raw || '').trim();
    if (!input) return null;

    if (EPOCH_ONLY.test(input)) {
      var num = Number(input);
      if (!isFinite(num)) return null;
      var digits = Math.trunc(Math.abs(num)).toString().length;
      var d = new Date(digits <= 10 ? num * 1000 : num);
      if (isNaN(d.getTime())) return null;
      return {
        date: d,
        isUTC: true,
        reason: 'Epoch Unix (' + (digits <= 10 ? 'seconds' : 'milliseconds') + ') — always UTC.'
      };
    }

    if (DATE_ONLY.test(input)) {
      var only = new Date(input);
      if (isNaN(only.getTime())) return null;
      return { date: only, isUTC: true, reason: 'Date-only ISO string — interpreted as UTC midnight.' };
    }

    var date = new Date(input);
    if (isNaN(date.getTime())) return null;

    if (UTC_MARKER.test(input) || ZERO_OFFSET.test(input)) {
      var m = input.match(UTC_MARKER);
      var marker = m ? m[0].toUpperCase().trim() : '+00:00';
      return { date: date, isUTC: true, reason: 'Explicit UTC marker ("' + marker + '") found.' };
    }

    if (EXPLICIT_OFFSET.test(input)) {
      return { date: date, isUTC: false, reason: 'Explicit timezone offset found (not UTC, but still an absolute instant).' };
    }

    return { date: date, isUTC: false, reason: 'No timezone info found — assumed local time.' };
  }

  function plural(n, unit) { return n + ' ' + unit + (n !== 1 ? 's' : ''); }

  function formatDuration(ms) {
    var abs = Math.abs(ms);
    var seconds = Math.floor(abs / 1000) % 60;
    var minutes = Math.floor(abs / 60000) % 60;
    var hours = Math.floor(abs / 3600000) % 24;
    var days = Math.floor(abs / 86400000);

    var parts = [];
    if (days > 0) parts.push(plural(days, 'day'));
    if (hours > 0) parts.push(plural(hours, 'hour'));
    if (days === 0 && minutes > 0) parts.push(plural(minutes, 'minute'));
    if (days === 0 && hours === 0 && seconds > 0) parts.push(plural(seconds, 'second'));

    if (parts.length === 0) return '0 seconds';
    return parts.slice(0, 2).join(', ');
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function utcStamp(date) {
    return date.toISOString().replace('T', ' ').replace('Z', ' UTC');
  }

  // ── Render ─────────────────────────────────────────────────────────────
  function renderClock() {
    clockEl.textContent =
      now.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: '2-digit' }) +
      ' ' +
      now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    if (!open) {
      var width = Math.ceil(triggerEl.getBoundingClientRect().width) + 2;
      if (width > 24 && Math.abs(width - collapsedWidth) > 1) {
        collapsedWidth = width;
        devflow.ui.resize({ width: width, height: BAR_H });
      }
    }
  }

  function tagFor(parsed) {
    return '<span class="tagline">' +
      '<span class="tag' + (parsed.isUTC ? ' utc' : '') + '">' + (parsed.isUTC ? 'UTC' : 'LOCAL') + '</span>' +
      '<span class="reason" title="' + escapeHtml(parsed.reason) + '">' + escapeHtml(parsed.reason) + '</span>' +
      '</span>';
  }

  function renderResult() {
    var raw = inputEl.value.trim();
    var rawCompare = compareEl.value.trim();

    if (!raw) {
      resultEl.innerHTML = '<p class="hint">Accepts ISO 8601, Unix epoch (seconds or ms), RFC 2822, or most date/time formats. ' +
        'By default compares against the current moment — fill the second field to compare two specific dates instead. ' +
        'Dates with an explicit UTC marker ("Z", "UTC", "GMT") are compared in UTC, otherwise local time is assumed.</p>';
      return;
    }

    var parsed = parseFlexibleDate(raw);
    if (!parsed) {
      resultEl.innerHTML = '<p class="error">Could not parse the first date.</p>';
      return;
    }

    var parsedCompare = rawCompare ? parseFlexibleDate(rawCompare) : null;
    if (rawCompare && !parsedCompare) {
      resultEl.innerHTML = '<p class="error">Could not parse the comparison date.</p>';
      return;
    }

    var usingCompare = !!parsedCompare;
    var reference = usingCompare ? parsedCompare.date : now;
    var diffMs = reference.getTime() - parsed.date.getTime();
    var isPast = diffMs >= 0;

    var html = '<div class="rows">';
    html += tagFor(parsed);
    if (usingCompare) html += tagFor(parsedCompare);

    html += '<div class="big">' + formatDuration(diffMs) + ' ' +
      (usingCompare
        ? (isPast ? 'before the compared date' : 'after the compared date')
        : (isPast ? 'ago' : 'from now')) +
      '</div>';

    html += '<div class="stamps">' +
      '<span>UTC: ' + escapeHtml(utcStamp(parsed.date)) + '</span>' +
      '<span>Local: ' + escapeHtml(parsed.date.toLocaleString()) + '</span>';
    if (usingCompare) {
      html += '<span class="gap">Compared to (UTC): ' + escapeHtml(utcStamp(parsedCompare.date)) + '</span>' +
        '<span>Compared to (Local): ' + escapeHtml(parsedCompare.date.toLocaleString()) + '</span>';
    }
    html += '</div></div>';

    resultEl.innerHTML = html;
  }

  // ── Abrir / fechar ─────────────────────────────────────────────────────
  function setOpen(next) {
    if (next === open) return;
    open = next;
    body.classList.toggle('open', open);

    if (open) {
      devflow.ui.expand({ width: PANEL_W, height: PANEL_H + BAR_H });
      renderResult();
      setTimeout(function () { inputEl.focus(); }, 0);
    } else {
      inputEl.value = '';
      compareEl.value = '';
      setPinned(false);
      devflow.ui.collapse();
      devflow.ui.resize({ width: collapsedWidth, height: BAR_H });
    }
  }

  function setPinned(next) {
    pinned = next;
    pinEl.classList.toggle('on', pinned);
    pinEl.title = pinned ? 'Unpin (close when it loses focus)' : 'Pin (keep open while you work)';
  }

  triggerEl.addEventListener('click', function () { setOpen(!open); });
  closeEl.addEventListener('click', function () { setOpen(false); });
  pinEl.addEventListener('click', function () { setPinned(!pinned); });
  inputEl.addEventListener('input', renderResult);
  compareEl.addEventListener('input', renderResult);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') setOpen(false);
  });

  // Clicar fora do widget tira o foco do iframe — é assim que o painel
  // fecha sozinho, já que uma extensão sandbox não enxerga cliques no resto
  // do app. Com o pin ligado, ignora.
  window.addEventListener('blur', function () {
    if (open && !pinned) setOpen(false);
  });

  // Atalho global declarado no manifesto: o host captura Ctrl+Shift+D em
  // qualquer lugar do app e repassa pra cá.
  devflow.ui.onShortcut(function () {
    setOpen(!open);
    if (open) window.focus();
  });

  setInterval(function () {
    now = new Date();
    renderClock();
    if (open && !compareEl.value.trim() && inputEl.value.trim()) renderResult();
  }, 1000);

  renderClock();
  devflow.ui.resize({ width: collapsedWidth, height: BAR_H });
})();
</script>
`;

export const BUILTIN_EXTENSIONS: ExtensionRecord[] = [
  {
    id: 'devflow.date-diff',
    name: 'Date Difference',
    version: '1.0.0',
    description: 'Footer clock plus a calculator for the distance between two dates (or between a date and now).',
    contributes: {
      statusBarItems: [{ id: 'clock' }],
      shortcuts: ['Ctrl+Shift+D'],
    },
    permissions: [],
    path: 'built-in',
    source: 'builtin',
    html: DATE_DIFF_HTML,
    error: null,
  },
];
