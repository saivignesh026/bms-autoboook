(() => {
  'use strict';
  const api = globalThis.browser || chrome;
  const send = async m => {
    const r = await api.runtime.sendMessage(m);
    if (!r?.ok) throw Error(r?.error || 'Extension unavailable. Reload this tab.');
    return r.data;
  };
  const CHECK_MS = 500;
  let profile, config, state = { running: false }, busy = false, editing = null, lastPoll = 0, notice = 'Select a theatre profile using the extension button.', lastDraw = '', localCheck = 0, quantityStep = 0, quantityAt = 0;

  // Seat images copy the live selected map; QR capture runs in the page realm.
  const BMSCapture = {
    seat: async () => captureSelectedSeats(),
    qr: () => send({ type: 'capturePage', runId: state.runId, kind: 'qr' })
  };

  const host = document.createElement('div');
  host.id = 'bms-companion';
  document.documentElement.append(host);
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
  :host{all:initial}*{box-sizing:border-box}#panel{position:fixed;right:16px;bottom:16px;width:300px;max-height:75vh;overflow:auto;z-index:2147483645;font:13px/1.5 system-ui,sans-serif;color:#f2f6ff;background:#14203a;border:1px solid #405477;border-radius:14px;padding:14px;box-shadow:0 12px 40px #0005}header{display:flex;justify-content:space-between;align-items:center;font-weight:700}button{font:inherit;cursor:pointer;border:1px solid #52698e;border-radius:7px;padding:6px 9px;background:#2b4165;color:#fff;margin:5px 3px 0 0}button:hover{background:#405e8f}#stop{background:#a23c57}#timer{font-size:22px;font-weight:750;color:#a8d5ff;line-height:1.3;margin:10px 0}#status{margin:8px 0;color:#dae6fb;overflow-wrap:anywhere}#hint,#schedule{font-size:11px;color:#a4b8d9}#delivery{color:#a6e3be;font-size:12px;margin:6px 0}#delivery.error{color:#ffb3b3}#logs{font-size:11px;white-space:pre-wrap}#zones{position:fixed;inset:0;pointer-events:none;z-index:2147483643}.zone{position:fixed;border:3px solid red;background:transparent;pointer-events:none}.zone span{position:absolute;top:-18px;left:-3px;background:red;color:white;padding:1px 4px;font:10px system-ui;white-space:nowrap}#draw{position:fixed;border:2px dashed #76a7ff;background:#76a7ff12;cursor:crosshair;touch-action:none;z-index:2147483644}#draft{position:absolute;border:3px dashed blue;background:rgba(0,0,255,0.2);pointer-events:none}.hidden{display:none!important}details{margin-top:8px}summary{cursor:pointer;color:#b9cbea;font-size:11px}
  </style><div id="zones"></div><section id="panel"><header><span>bms-autobook 1.7</span><button id="minimize" title="Collapse">_</button></header><div id="body"><label>Profile for this tab <select id="tabProfile"></select></label><div id="hint"></div><div id="timer" role="timer">Not running</div><div id="schedule"></div><div id="status" role="status"></div><div id="delivery"></div><div id="controls"><button id="watch">Start</button><button id="choose">Adjust seats</button><button id="stop">Stop</button><button id="profiles">Profiles</button></div><div id="tools" class="hidden"><button id="undo">Undo</button><button id="clear">Clear</button><button id="save">Save seats</button><button id="saveStart">Save &amp; start</button><button id="cancel">Cancel</button></div><details><summary>What happened?</summary><div id="logs"></div></details></div></section>`;

  const $ = id => root.getElementById(id);

  function text(el) {
    const value = [el?.innerText, el?.textContent, el?.value].find(v => typeof v === 'string' && v.length);
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function visible(el) {
    return !!el && el.offsetHeight > 0 && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  function findButton(pattern, scope = document) {
    const elements = [...scope.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')];
    return elements.find(el => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && pattern.test(text(el)));
  }

  function payButton() {
    return [...document.querySelectorAll('button, a')]
      .find(el => visible(el) && /Pay\s*₹/i.test(text(el)));
  }

  // v67 scans all seat-sized canvases in DOM order, then zones in saved order.
  function seatCanvases() {
    return [...document.querySelectorAll('canvas')]
      .filter(c => c.width >= 500 && c.height >= 400);
  }

  function map() {
    return seatCanvases()[0];
  }

  function tell(message) {
    notice = message;
    render();
  }

  async function refresh() {
    config = await send({ type: 'config' });
    const next = await send({ type: 'state' });
    if (next.runId !== state.runId) {
      localCheck = 0;
      quantityAt = 0;
      quantityStep = 0;
    }
    state = next;
    profile = state.running && state.profileSnapshot
      ? state.profileSnapshot
      : config.profiles.find(p => p.id === (state.profileId || config.activeProfile)) || config.profiles[0];
    $('tabProfile').replaceChildren();
    for (const p of config.profiles) {
      const option = document.createElement('option');
      option.value = p.id;
      option.textContent = `${p.name} • ${p.theatre || 'Theatre not set'}`;
      $('tabProfile').append(option);
    }
    $('tabProfile').value = profile.id;
    render();
    draw();
  }

  async function update(patch, message) {
    await send({ type: 'update', runId: state.runId, patch, text: message });
    Object.assign(state, patch);
    if (message) notice = message;
    render();
  }

  async function announce(event, message) {
    await send({ type: 'event', runId: state.runId, event, text: message });
  }

  function render() {
    $('tabProfile').disabled = !!state.running || !!editing;
    $('hint').textContent = profile ? `${profile.name} • ${profile.theatre || 'Theatre not set'}` : 'Choose a theatre profile';
    $('status').textContent = editing ? `${editing.zones.length} seat area(s). Drag a box around each seat, then save.` : notice;
    $('schedule').textContent = profile ? `Checks every ${CHECK_MS / 1000}s • Reloads every ${profile.minInterval}-${profile.maxInterval}s • ${state.reloads || 0} reload(s)` : '';
    $('stop').classList.toggle('hidden', !state.running);
    $('watch').classList.toggle('hidden', !!state.running || !!editing);
    $('controls').classList.toggle('hidden', !!editing);
    $('tools').classList.toggle('hidden', !editing);
    const entries = Object.entries(state.events || {}), last = entries.reverse().find(([, e]) => e.status === 'failed' || e.status === 'retry') || entries[0];
    $('delivery').textContent = last ? `Discord ${last[0] === 'error' ? 'error report' : last[0]}: ${last[1].status === 'sent' ? 'delivered' : last[1].status}${last[1].error ? ' — ' + last[1].error : ''}` : '';
    $('delivery').className = last && (last[0] === 'error' || ['failed', 'retry'].includes(last[1].status)) ? 'error' : '';
    $('logs').textContent = (state.logs || []).slice(-8).map(l => `${new Date(l.time).toLocaleTimeString()} ${l.text}`).join('\n');
    paintTimer();
  }

  function paintTimer() {
    if (editing) { $('timer').textContent = 'Choose your seats'; return; }
    if (!state.running) { $('timer').textContent = 'Not running'; return; }
    if (state.phase === 'cooldown') {
      const seconds = BMS.countdown(state.resumeAt, Date.now());
      $('timer').textContent = `Monitoring resumes in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      $('schedule').textContent = 'Returning to the saved seat map automatically. Stop cancels this.';
      return;
    }
    const deadline = state.nextCheck || localCheck || Date.now();
    if (state.phase === 'watching') {
      const check = `Next check in ${BMS.shortCountdown(deadline, Date.now())}s`;
      $('timer').textContent = check;
      $('schedule').textContent = `Next reload in ${state.nextReload ? BMS.countdown(state.nextReload, Date.now()) + 's' : '—'} • Reload interval ${profile.minInterval}-${profile.maxInterval}s • ${state.reloads || 0} reload(s)`;
    } else {
      const labels = {
        'seat-wait': 'Seat clicked — waiting for UI to turn green',
        'pay-wait': 'Seat map captured — waiting to Pay',
        'checkout': 'Opening checkout / F&B',
        'contact': 'Filling contact details',
        'qr': 'Waiting for QR to render',
        'payment': 'Sending QR & Seat Map to Discord',
        'done': 'QR sent to Discord!'
      };
      $('timer').textContent = state.phase === 'seat-wait'
        ? `Seat image in ${BMS.countdown(state.seatCaptureAt || Date.now(), Date.now())}s`
        : state.phase === 'pay-wait'
          ? `Pay in ${BMS.countdown(state.payAt || Date.now(), Date.now())}s`
          : labels[state.phase] || 'Working...';
      $('schedule').textContent = state.phase === 'done' ? 'Check Discord to scan QR.' : `Next check in ${BMS.shortCountdown(deadline, Date.now())}s`;
    }
  }

  $('minimize').onclick = () => { $('body').classList.toggle('hidden'); };
  $('tabProfile').onchange = async () => {
    try {
      await send({ type: 'bindProfile', profileId: $('tabProfile').value });
      await refresh();
      tell('Profile selected for this tab.');
    } catch (e) {
      await refresh().catch(() => {});
      tell(e.message);
    }
  };
  $('profiles').onclick = () => send({ type: 'openSettings' }).catch(e => tell(e.message));
  $('stop').onclick = async () => {
    state.running = false;
    render();
    await send({ type: 'stop' }).catch(e => tell(e.message));
    tell('Stopped.');
  };

  async function start() {
    try {
      // Auto-sync layout to current tab if zones already exist so you don't get locked out on a new URL
      const c = map();
      if (c && profile?.zones?.length && location.pathname.includes('/seat-layout/')) {
        await send({
          type: 'zones',
          profileId: profile.id,
          zones: profile.zones,
          layout: { path: location.pathname, width: c.width, height: c.height, url: location.href }
        }).catch(() => {});
      }
      await send({ type: 'startHere', profileId: profile.id });
      await refresh();
      tell('Started. Watching the seats saved in this profile.');
    } catch (e) {
      tell(e.message);
    }
  }

  $('watch').onclick = start;
  $('choose').onclick = () => editSeats().catch(e => tell(e.message));
  $('undo').onclick = () => { editing.zones.pop(); draw(true); render(); };
  $('clear').onclick = () => { editing.zones = []; draw(true); render(); };
  $('cancel').onclick = () => { editing.overlay.remove(); editing = null; draw(true); render(); };
  $('save').onclick = () => saveSeats(false);
  $('saveStart').onclick = () => saveSeats(true);

  async function saveSeats(andStart) {
    try {
      if (!editing?.zones.length) throw Error('Draw a box around at least one seat.');
      const c = editing.canvas;
      await send({
        type: 'zones',
        profileId: editing.profileId,
        zones: editing.zones,
        layout: { path: location.pathname, width: c.width, height: c.height, url: location.href }
      });
      editing.overlay.remove();
      editing = null;
      await refresh();
      tell('Seats saved for this profile.');
      if (andStart) await start();
    } catch (e) {
      tell(e.message);
    }
  }

  function draw(force = false) {
    if (!profile) return;
    const c = editing?.canvas || map();
    if (!c || !location.pathname.includes('/seat-layout/')) {
      $('zones').replaceChildren();
      return;
    }
    const zones = editing?.zones || profile.zones, r = c.getBoundingClientRect();
    const canvases = editing ? [c] : seatCanvases();
    const mark = JSON.stringify([canvases.map(canvas => {
      const box = canvas.getBoundingClientRect();
      return [box.left, box.top, box.width, box.height];
    }), zones, !!editing, profile.showZones]);
    if (mark === lastDraw && !force) return;
    lastDraw = mark;
    $('zones').replaceChildren();
    for (const canvas of canvases) {
      if (!editing && profile.showZones === false) continue;
      const r = canvas.getBoundingClientRect();
      for (const z of zones) {
        const box = document.createElement('div');
        box.className = 'zone bms-target-box';
        Object.assign(box.style, {
          left: `${r.left + r.width * z.left}px`,
          top: `${r.top + r.height * z.top}px`,
          width: `${r.width * (z.right - z.left)}px`,
          height: `${r.height * (z.bottom - z.top)}px`
        });
        const label = document.createElement('span');
        label.textContent = z.name;
        box.append(label);
        $('zones').append(box);
      }
    }
    if (editing) {
      Object.assign(editing.overlay.style, {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`
      });
    }
  }

  async function editSeats() {
    if (editing) return;
    if (!location.pathname.includes('/seat-layout/')) throw Error('Open the BookMyShow seat-selection screen first.');
    if (state.running) {
      await send({ type: 'stop' });
      await refresh();
    }
    const c = map();
    if (!c) throw Error('Seat map canvas not found. Dismiss any popup covering the seat map first.');
    const overlay = document.createElement('div');
    overlay.id = 'draw';
    const draft = document.createElement('div');
    draft.id = 'draft';
    draft.className = 'hidden';
    overlay.append(draft);
    root.append(overlay);

    editing = {
      profileId: profile.id,
      canvas: c,
      overlay,
      zones: structuredClone(profile.zones || [])
    };
    let begin;
    const point = e => {
      const r = overlay.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
        y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))
      };
    };

    overlay.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      begin = point(e);
      overlay.setPointerCapture(e.pointerId);
      draft.classList.remove('hidden');
      Object.assign(draft.style, { left: `${begin.x * 100}%`, top: `${begin.y * 100}%`, width: '0', height: '0' });
    });

    overlay.addEventListener('pointermove', e => {
      if (!begin) return;
      const end = point(e);
      Object.assign(draft.style, {
        left: `${Math.min(begin.x, end.x) * 100}%`,
        top: `${Math.min(begin.y, end.y) * 100}%`,
        width: `${Math.abs(begin.x - end.x) * 100}%`,
        height: `${Math.abs(begin.y - end.y) * 100}%`
      });
    });

    overlay.addEventListener('pointercancel', () => {
      begin = null;
      draft.classList.add('hidden');
    });

    overlay.addEventListener('pointerup', e => {
      if (!begin) return;
      const end = point(e), start = begin;
      begin = null;
      draft.classList.add('hidden');
      if (Math.abs(start.x - end.x) < 0.003 || Math.abs(start.y - end.y) < 0.003) return;
      let seatName = prompt('Enter a name for this seat/zone (e.g., D29 D28, Row B):', `Seat ${editing.zones.length + 1}`);
      if (!seatName || !seatName.trim()) seatName = `Seat ${editing.zones.length + 1}`;
      editing.zones.push({
        name: seatName.trim(),
        left: Number(Math.min(start.x, end.x).toFixed(3)),
        right: Number(Math.max(start.x, end.x).toFixed(3)),
        top: Number(Math.min(start.y, end.y).toFixed(3)),
        bottom: Number(Math.max(start.y, end.y).toFixed(3))
      });
      draw(true);
      render();
    });

    draw(true);
    render();
  }

  function captureSelectedSeats() {
    // BookMyShow draws the layout and selected seats on separate stacked canvases.
    const maps = seatCanvases();
    if (!maps.some(canvas => seatMarks(canvas).some(mark => mark.selected))) {
      throw Error('No selected seats are visible in the seat map.');
    }
    const layers = maps.map(canvas => ({ canvas, rect: canvas.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0);
    if (!layers.length) throw Error('Seat layout is not visible.');
    const left = Math.min(...layers.map(({ rect }) => rect.left));
    const top = Math.min(...layers.map(({ rect }) => rect.top));
    const right = Math.max(...layers.map(({ rect }) => rect.left + rect.width));
    const bottom = Math.max(...layers.map(({ rect }) => rect.top + rect.height));
    const scale = Math.max(...layers.map(({ canvas, rect }) => canvas.width / rect.width));
    const output = document.createElement('canvas');
    output.width = Math.ceil((right - left) * scale);
    output.height = Math.ceil((bottom - top) * scale);
    const ctx = output.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, output.width, output.height);
    for (const { canvas, rect } of layers) {
      ctx.drawImage(canvas, (rect.left - left) * scale, (rect.top - top) * scale,
        rect.width * scale, rect.height * scale);
    }
    return output.toDataURL('image/jpeg', 0.95);
  }

  // Read complete seat outlines so a small crop cannot move the click onto a border.
  function seatMarks(canvas) {
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0);
    const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
    const marks = BMS.components(pixels, copy.width, copy.height)
      .filter(mark => mark.w >= 6 && mark.h >= 6)
      .sort((a, b) => b.w * b.h - a.w * a.h);
    // Green seat numbers are inside the outline, not additional selectable seats.
    const seats = [];
    for (const mark of marks) {
      if (seats.some(outer => Math.abs(mark.x - outer.x) + mark.w / 2 <= outer.w / 2 &&
        Math.abs(mark.y - outer.y) + mark.h / 2 <= outer.h / 2)) continue;
      seats.push({ ...mark, selected: mark.pixels / (mark.w * mark.h) > 0.55 });
    }
    return seats.sort((a, b) => a.y - b.y || a.x - b.x);
  }

  function selectedSeatCount() {
    let count = 0;
    for (const canvas of seatCanvases()) count += seatMarks(canvas).filter(mark => mark.selected).length;
    return count;
  }

  function scanFirstAvailableSeat() {
    const zones = profile.zones;
    const offset = (state.seatZoneOffset || 0) % zones.length;
    for (const canvas of seatCanvases()) {
      try {
        const seats = seatMarks(canvas);
        for (let index = 0; index < zones.length; index++) {
          const zoneIndex = (offset + index) % zones.length;
          const z = zones[zoneIndex];
          const seat = seats.find(mark => !mark.selected &&
            mark.x >= canvas.width * z.left && mark.x <= canvas.width * z.right &&
            mark.y >= canvas.height * z.top && mark.y <= canvas.height * z.bottom);
          if (seat) return { x: seat.x, y: seat.y, name: z.name, zoneIndex, canvas };
        }
      } catch (e) {
        console.warn('[Auto-Booker] Seat scan failed:', e);
      }
    }
    return null;
  }

  function simulateNaturalClick(element) {
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + (rect.width / 2);
    const clientY = rect.top + (rect.height / 2);
    const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    events.forEach(eventType => {
      element.dispatchEvent(new MouseEvent(eventType, {
        bubbles: true, cancelable: true, clientX, clientY
      }));
    });
  }

  function simulateCanvasClick(canvas, internalX, internalY) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / canvas.width;
    const scaleY = rect.height / canvas.height;
    const clientX = rect.left + (internalX * scaleX);
    const clientY = rect.top + (internalY * scaleY);

    host.style.pointerEvents = 'none';
    try {
      ['mousedown', 'mouseup', 'click'].forEach(eventType => {
        canvas.dispatchEvent(new MouseEvent(eventType, {
          bubbles: true, cancelable: true, clientX, clientY
        }));
      });
    } finally {
      host.style.pointerEvents = '';
    }
  }

  function setNativeValue(element, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function waitAfter(base = 3000) {
    await update({ nextAction: Date.now() + BMS.actionDelay(base) });
  }

  // v67 quantity timing, with a retry while animated options are absent.
  async function handleQuantityModal() {
    const selectBtn = Array.from(document.querySelectorAll('button, div[role="button"], a'))
      .find(btn => btn.innerText && (btn.innerText.trim().toLowerCase() === 'select seats' || btn.innerText.trim().toLowerCase() === 'accept') && btn.offsetHeight > 0);

    if (!selectBtn) {
      quantityStep = 0;
      quantityAt = 0;
      return false;
    }

    if (!quantityAt) {
      const qtyDelay = BMS.actionDelay(3000);
      quantityAt = Date.now() + qtyDelay;
      tell(`Quantity modal detected. Waiting ${(qtyDelay / 1000).toFixed(1)}s...`);
      return true;
    }

    if (Date.now() < quantityAt) return true;

    if (selectBtn.innerText.trim().toLowerCase() === 'accept') {
      selectBtn.click();
      quantityAt = 0;
      await waitAfter(3000);
      return true;
    }

    if (quantityStep === 0) {
      const option = [...document.querySelectorAll('li, div, span')]
        .find(el => text(el) === String(profile.ticketCount) && el.children.length === 0 && visible(el));
      if (!option) {
        tell('Waiting for ticket quantities to render...');
        return true;
      }
      option.click();
      quantityStep = 1;
      quantityAt = Date.now() + BMS.actionDelay(3000);
      tell(`Selected Ticket Quantity: ${profile.ticketCount}`);
    } else {
      selectBtn.click();
      quantityStep = 0;
      quantityAt = 0;
      await waitAfter(3000);
      tell('Dismissed Quantity Modal');
    }
    return true;
  }

  async function captureAndSendQR() {
    if (Date.now() < (state.qrCaptureAt || 0)) return false;
    let result = null;
    try {
      result = await BMSCapture.qr();
    } catch (e) {
      console.warn('[Auto-Booker] QR capture error:', e);
      tell(`QR screenshot failed: ${e.message}`);
      return false;
    }
    if (!result) {
      tell('Waiting for QR code to finish rendering...');
      return false;
    }
    await send({ type: 'assets', runId: state.runId, qr: result.data, qrKind: result.kind });
    const bookedSeatName = (state.selectedNames || []).join(', ') || 'Target Zone';
    await announce('payment', `🎫 **SEAT SECURED:** ${bookedSeatName}\n🚨 **QR CODE & SEAT MAP ATTACHED DIRECTLY BELOW!**`);
    await update({ phase: 'payment', phaseStarted: Date.now() }, 'Attaching QR code & Seat Map directly to Discord...');
    return true;
  }

  function paymentCompleted() {
    const success = /^(?:congratulations[!,]?\s*)?(?:(?:your\s+)?(?:payment\s+(?:is\s+)?(?:successful|success|completed)|booking\s+(?:is\s+)?(?:confirmed|successful))|tickets?\s+booked\s+successfully)[.!\s]*$/i;
    return [...document.querySelectorAll('h1, h2, h3, [role="status"], [role="alert"], p, span, div')]
      .some(el => visible(el) && success.test(text(el)));
  }

  async function step() {
    const url = window.location.href;
    if (state.phase === 'cooldown') {
      if (Date.now() >= state.resumeAt) {
        await send({ type: 'resumeMonitoring', runId: state.runId });
        await refresh();
      }
      return;
    }
    if (Date.now() < (state.nextAction || 0)) return;
    if (['qr', 'payment', 'done'].includes(state.phase) && paymentCompleted()) {
      await send({ type: 'beginCooldown', runId: state.runId });
      await refresh();
      tell('Payment completed. Monitoring will resume in five minutes.');
      return;
    }

    // Check delivery status if already in payment/done phase
    if (state.phase === 'payment' || state.phase === 'done') {
      await send({ type: 'retryDelivery', runId: state.runId });
      await refresh();
      const delivery = state.events?.payment;
      if (delivery?.status === 'sent' && state.phase !== 'done') {
        await update({ phase: 'done' }, `Direct Discord upload success! (${delivery.attachments || 0} image(s)).`);
      } else if (delivery?.status === 'failed') {
        tell(`Discord error: ${delivery.error}`);
      }
      return;
    }

    // STEP 4: QR CODE PROCESSING SCREEN (OR AFTER QR CLICKED)
    if (url.includes('/payment-status/')) {
      if (!state.qrCaptureAt) {
        const qrDelay = BMS.actionDelay(5000);
        await update({ phase: 'qr', qrCaptureAt: Date.now() + qrDelay, phaseStarted: Date.now() }, `Payment page loaded. Waiting ${(qrDelay / 1000).toFixed(1)}s for QR to render...`);
        return;
      }
      await captureAndSendQR();
      return;
    }

    // STEP 1: SEAT LAYOUT PAGE
    if (url.includes('/seat-layout/')) {
      if (await handleQuantityModal()) return;

      if (!profile.zones || !profile.zones.length) {
        tell('No seat zones saved. Click "Adjust seats" to draw your target zones.');
        return;
      }

      // Waiting ~5s after seat click to capture seat map
      if (state.phase === 'seat-wait') {
        if (Date.now() < (state.seatCaptureAt || 0)) return;
        const selected = selectedSeatCount();
        if (selected === profile.ticketCount && !payButton()) {
          tell(`${selected}/${profile.ticketCount} seats selected. Waiting for Pay to appear...`);
          return;
        }
        if (selected !== profile.ticketCount) {
          await update({ phase: 'watching', nextAction: 0, nextReload: 0,
            seatZoneOffset: ((state.seatZoneOffset || 0) + 1) % profile.zones.length },
          `Selected ${selected}/${profile.ticketCount} seats. Retrying the saved zones...`);
          return;
        }
        await announce('available', `🎯 ${(state.selectedNames || []).join(', ')}: ${selected} seat(s) selected!`);
        let seatB64 = '', seatError = '';
        try {
          seatB64 = await BMSCapture.seat();
          if (!seatB64) throw Error('No seat image was captured.');
          await send({ type: 'assets', runId: state.runId, seat: seatB64 });
        } catch (e) {
          seatError = e.message;
          console.warn('[Auto-Booker] Error capturing or saving seat map:', e);
        }
        const payDelay = BMS.actionDelay(3000);
        await update({
          phase: 'pay-wait',
          seatCaptureError: seatError,
          payAt: Date.now() + payDelay
        }, seatError ? `Seat screenshot failed: ${seatError}. Continuing to Pay.`
          : `Seat map saved for Discord. Waiting ${(payDelay / 1000).toFixed(1)}s to Pay...`);
        return;
      }

      // Waiting ~3s to click Pay button
      if (state.phase === 'pay-wait' || state.phase === 'checkout') {
        if (Date.now() < (state.payAt || 0)) return;
        const payBtn = payButton();
        if (selectedSeatCount() !== profile.ticketCount) {
          await update({ phase: 'watching', nextAction: 0, nextReload: 0,
            seatZoneOffset: ((state.seatZoneOffset || 0) + 1) % profile.zones.length },
          'The requested seat count is not selected. Retrying the saved zones...');
          return;
        }
        if (payBtn) {
          payBtn.click();
          await update({ phase: 'checkout', payClicked: true, nextReload: 0 }, 'Clicked Pay Button');
          await waitAfter(3000);
        } else {
          tell('Seats selected. Waiting for the Pay button to appear...');
        }
        return;
      }

      // Scanning for green seat pixel
      if (state.phase === 'watching') {
        if (!map()) {
          tell('Waiting for the seat map canvas to load...');
          return;
        }
        const found = scanFirstAvailableSeat();
        if (found) {
          simulateCanvasClick(found.canvas, found.x, found.y);
          const seatMapDelay = BMS.actionDelay(5000);
          await update({
            phase: 'seat-wait',
            layoutUrl: window.location.href,
            seatZoneOffset: found.zoneIndex || 0,
            selectedPoints: [{ x: found.x, y: found.y, name: found.name }],
            selectedNames: [found.name],
            seatCaptureAt: Date.now() + seatMapDelay,
            phaseStarted: Date.now(),
            nextReload: 0
          }, `Clicked unblocked seat: ${found.name}`);
          await waitAfter(3000);
          return;
        }

        // Sold out -> Reload timer
        if (!state.nextReload) {
          const nextDelayMs = (Math.floor(Math.random() * (profile.maxInterval - profile.minInterval + 1)) + profile.minInterval) * 1000;
          await update({ nextReload: Date.now() + nextDelayMs }, `Target zones sold out. Reloading in ${Math.round(nextDelayMs / 1000)}s...`);
        }
        if (Date.now() >= state.nextReload) {
          await send({ type: 'reloadDue', runId: state.runId });
        }
        return;
      }
    }

    // STEP 2: FOOD & BEVERAGE PAGE
    if (url.includes('/food-and-beverages/')) {
      const skipBtn = Array.from(document.querySelectorAll('button, a, div, span'))
        .find(el => el.innerText && el.innerText.trim().toLowerCase() === 'skip' && visible(el));
      if (skipBtn) {
        skipBtn.click();
        await update({ phase: 'contact', phaseStarted: Date.now() }, 'Skipped F&B');
        await waitAfter(3000);
      } else {
        tell('Waiting for Skip button on F&B...');
      }
      return;
    }

    // STEP 3: ORDER SUMMARY / PAYMENT OPTIONS
    if (url.includes('/order-summary/')) {
      const dismissBtn = Array.from(document.querySelectorAll('button'))
        .find(btn => btn.innerText && btn.innerText.trim().toLowerCase() === 'dismiss' && btn.offsetHeight > 0);

      if (dismissBtn) {
        dismissBtn.click();
        await update({ qrClicked: false, qrCaptureAt: 0, qrRetryAt: 0 }, 'Cleared Error Popup');
        await waitAfter(3000);
        return;
      }

      // If QR was already clicked and 5s passed on order-summary (inline QR render), capture it!
      if (state.qrClicked && state.qrCaptureAt && Date.now() >= state.qrCaptureAt) {
        const sent = await captureAndSendQR();
        if (sent) return;
      }

      const emailInput = document.querySelector('input[type="email"], input[placeholder*="abc@gmail.com" i], input[placeholder*="@" i]');
      const phoneInput = document.querySelector('input[type="tel"], input[placeholder*="XXXXX" i], input[placeholder*="mobile" i]');

      if (visible(emailInput) && visible(phoneInput)) {
        if (emailInput.value !== profile.email) setNativeValue(emailInput, profile.email);
        if (phoneInput.value !== profile.phone) setNativeValue(phoneInput, profile.phone);

        const submitBtn = Array.from(document.querySelectorAll('button'))
          .find(btn => visible(btn) && /^submit$/i.test(text(btn)));

        if (submitBtn && !submitBtn.disabled) {
          submitBtn.click();
          await update({ phase: 'contact', contactSubmitted: true }, 'Submitted Contact Details');
          await waitAfter(3000);
          return;
        }
      }

      if (!state.qrClicked || (state.qrRetryAt && Date.now() >= state.qrRetryAt)) {
        const qrTextNodes = Array.from(document.querySelectorAll('*'))
          .filter(el => el.innerText && el.innerText.trim().toLowerCase() === 'scan qr code' && el.children.length === 0 && visible(el));

        if (qrTextNodes.length > 0) {
          const target = qrTextNodes[0];
          const clickableCard = target.closest('div[role="button"]') || target.closest('li') || target.parentElement;
          simulateNaturalClick(clickableCard || target);

          const qrDelay = BMS.actionDelay(5000);
          await update({
            phase: 'qr',
            qrClicked: true,
            qrCaptureAt: Date.now() + qrDelay,
            qrRetryAt: Date.now() + BMS.actionDelay(8000)
          }, 'Selected QR Code Payment');
          await waitAfter(3000);
          return;
        }
      }
    }
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      if (Date.now() - lastPoll > 2500) {
        await refresh();
        lastPoll = Date.now();
      }
      draw();
      if (!state.running || editing) return;
      if (Date.now() < (state.nextCheck || localCheck || 0)) return;
      localCheck = Date.now() + CHECK_MS;
      await update({ nextCheck: localCheck });
      await send({ type: 'retryDelivery', runId: state.runId });
      await step();
    } catch (e) {
      // Log transient error without killing the automation loop
      console.warn('[Auto-Booker] Loop warning:', e);
      tell(e.message);
    } finally {
      busy = false;
      paintTimer();
    }
  }

  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === 'backgroundTick') {
      if (busy) { respond({ ok: true, busy: true }); return false; }
      tick().then(() => respond({ ok: true }), e => respond({ ok: false, error: e.message }));
      return true;
    }
    if (!['refreshState', 'calibrate'].includes(message.type)) return false;
    (async () => {
      await refresh();
      if (message.type === 'calibrate') await editSeats();
    })().then(() => respond({ ok: true }), e => respond({ ok: false, error: e.message }));
    return true;
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.config) refresh().catch(e => tell(e.message));
  });

  window.addEventListener('resize', () => draw(true));
  window.addEventListener('scroll', () => draw(true), true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && editing) $('cancel').onclick(); });

  setInterval(paintTimer, 250);
  setInterval(tick, CHECK_MS);
  tick();
})();
