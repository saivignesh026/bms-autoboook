if (typeof importScripts === 'function') importScripts('core.js');
const api = globalThis.browser || chrome;
const sessions = api.storage.session;
api.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
const key = id => `tab:${id}`;
const supported = url => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'bookmyshow.com' || u.hostname.endsWith('.bookmyshow.com'));
  } catch {
    return false;
  }
};
const ownPage = s => !!s.url?.startsWith(api.runtime.getURL(''));
let serial = Promise.resolve();
const stopped = new Set(), deliveries = new Map(), writes = new Map();
const cleanProfile = p => {
  const { discord, discordTest, ...rest } = p;
  return rest;
};

async function configuration() {
  const saved = (await api.storage.local.get('config')).config;
  if (saved?.schemaVersion === 2) return saved;
  const profiles = (saved?.profiles?.length ? saved.profiles : [{}]).map(p => BMS.validateProfile({
    ...p,
    theatre: p.theatre || p.name || '',
    discord: p.discord || saved?.discord || '',
    autoSelect: true,
    checkout: true,
    sendScreenshots: true,
    skipFood: true,
    canvasSelector: '',
    selectedSelector: ''
  }));
  const config = { schemaVersion: 2, profiles, activeProfile: saved?.activeProfile || profiles[0].id };
  await api.storage.local.set({ config });
  return config;
}

async function read(id) {
  const s = (await sessions.get(key(id)))[key(id)] || { running: false, logs: [], reloads: 0 };
  return stopped.has(id) ? { ...s, running: false } : s;
}

function publicState(s) {
  return { ...s, profileSnapshot: s.profileSnapshot ? cleanProfile(s.profileSnapshot) : undefined };
}

function write(id, patch) {
  const task = (writes.get(id) || Promise.resolve()).then(async () => {
    const old = await read(id), delta = typeof patch === 'function' ? patch(old) : patch;
    const s = { ...old, ...delta };
    if (stopped.has(id)) s.running = false;
    await sessions.set({ [key(id)]: s });
    return s;
  });
  writes.set(id, task.catch(() => {}));
  return task;
}

async function log(id, text, runId) {
  return write(id, s => runId && s.runId !== runId ? {} : {
    status: text,
    logs: [...(s.logs || []), { time: Date.now(), text }].slice(-100)
  });
}

function validImage(value) {
  return typeof value === 'string' && value.length < 8000000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value);
}

// Execute the unchanged userscript capture code with page-owned Image/canvas
// objects. Firefox's isolated content-script principal can taint those images.
async function capturePage(tab, kind) {
  const target = { tabId: tab.id, frameIds: [0] };
  const loaded = await api.scripting.executeScript({
    target,
    world: 'MAIN',
    files: ['vendor/html2canvas.min.js', 'capture.js']
  });
  if (!loaded.length || loaded[0].error) {
    throw Error(loaded[0]?.error?.message || 'Could not load the page capture routines.');
  }
  const results = await api.scripting.executeScript({
    target,
    world: 'MAIN',
    args: [kind],
    func: async function (captureKind) {
      try {
        const data = await globalThis.BMSCapture[captureKind]();
        return { ok: true, data };
      } catch (e) {
        return { ok: false, error: `${e.name || 'Error'}: ${e.message || e}` };
      }
    }
  });
  const result = results[0];
  if (result?.error) throw Error(result.error.message || String(result.error));
  if (!result?.result?.ok) throw Error(result?.result?.error || 'Page capture returned no result.');
  const current = await api.tabs.get(tab.id);
  if (current.url !== tab.url) throw Error('The booking page changed while capturing. Retrying on the current page.');
  return result.result.data;
}

function base64ToBlob(base64Data, contentType = 'image/jpeg') {
  const characters = atob(base64Data), arrays = [];
  for (let offset = 0; offset < characters.length; offset += 512) {
    const slice = characters.slice(offset, offset + 512), numbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) numbers[i] = slice.charCodeAt(i);
    arrays.push(new Uint8Array(numbers));
  }
  return new Blob(arrays, { type: contentType });
}

async function discordPost(profile, text, images = []) {
  const url = new URL(BMS.webhook(profile.discord));
  url.search += (url.search ? '&' : '?') + 'wait=true';
  const attachments = images.map((image, id) => ({ id, filename: image.name }));
  const body = new FormData();
  body.append('payload_json', JSON.stringify({
    content: text.slice(0, 1900),
    allowed_mentions: { parse: [] },
    attachments
  }));
  for (let i = 0; i < images.length; i++) {
    const data = images[i].data, comma = data.indexOf(',');
    const mime = data.slice(5, data.indexOf(';'));
    body.append(`files[${i}]`, base64ToBlob(data.slice(comma + 1), mime), images[i].name);
  }
  let response;
  try {
    response = await fetch(url.href, { method: 'POST', body, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw Object.assign(Error('Discord could not be reached. Check internet access; delivery is unconfirmed.'), { retryable: true });
  }
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok) {
    const detail = response.status === 404
      ? 'Webhook not found; copy a new URL from Discord.'
      : response.status === 401 || response.status === 403
        ? 'Discord rejected this webhook.'
        : response.status === 429
          ? 'Discord rate limit; delivery will retry.'
          : String(result.message || 'Request rejected.').slice(0, 150);
    throw Object.assign(Error(`Discord HTTP ${response.status}: ${detail}`), {
      retryable: response.status === 429 || response.status >= 500,
      retryAfter: Math.min(120, Number(result.retry_after) || 5) * 1000
    });
  }
  if (!result.id) throw Object.assign(Error('Discord did not confirm a message ID. Check the channel before retrying.'), { retryable: false });
  if (images.length && (result.attachments?.length || 0) < images.length) {
    throw Object.assign(Error('Discord accepted the message but did not confirm all attachments.'), { retryable: false });
  }
  return { messageId: result.id, attachments: result.attachments?.length || 0 };
}

async function eventStatus(id, name, runId, entry) {
  await write(id, s => s.runId !== runId ? {} : { events: { ...s.events, [name]: entry } });
}

async function deliverEvent(id, runId, name) {
  const token = `${id}:${runId}:${name}`;
  if (deliveries.has(token)) return deliveries.get(token);
  const job = (async () => {
    const s = await read(id);
    if ((!s.running && name !== 'error') || s.runId !== runId) return;
    const entry = s.events?.[name];
    if (!entry || entry.status === 'sent') return;
    const p = s.profileSnapshot, assets = (await sessions.get(`assets:${id}`))[`assets:${id}`] || {};
    const images = [];
    if (name === 'payment') {
      if (assets.qr) images.push({ data: assets.qr, name: 'qr_code.jpg' });
      if (assets.seat) images.push({ data: assets.seat, name: 'seat_map.jpg' });
    }
    await eventStatus(id, name, runId, { ...entry, status: 'sending', attempts: (entry.attempts || 0) + 1 });
    try {
      if (!p.discord) throw Error('No Discord webhook saved in this theatre profile.');
      if (name === 'payment' && !assets.qr) throw Error('QR image has not been saved; refusing a payment notification without it.');
      const message = name === 'payment' ? entry.text
        : name === 'available' ? `🔔 **UPDATE:** ${entry.text}`
          : `🔔 **${p.name} • ${p.theatre}**\n${entry.text}`;
      const result = await discordPost(p, message, images);
      await eventStatus(id, name, runId, { ...entry, status: 'sent', ...result, sentAt: Date.now() });
      await log(id, `Discord delivered: ${name === 'payment' ? 'payment QR' : name} (${result.attachments} image${result.attachments === 1 ? '' : 's'}).`, runId);
    } catch (e) {
      const attempts = (entry.attempts || 0) + 1;
      // v67 retries payment upload failures four times, with a 5s + jitter cooldown.
      const retryAt = (name === 'payment' || e.retryable) && attempts < 4
        ? Date.now() + Math.max(BMS.actionDelay(5000), e.retryAfter || 0) : 0;
      await eventStatus(id, name, runId, { ...entry, status: retryAt ? 'retry' : 'failed', attempts, retryAt, error: e.message });
      await log(id, `Discord: ${e.message}${retryAt ? ' Retrying shortly.' : ' Open the profile and use Test Discord.'}`, runId);
    }
  })().finally(() => deliveries.delete(token));
  deliveries.set(token, job);
  return job;
}

async function handle(m, sender) {
  const own = ownPage(sender);
  if (sender.tab && !own && !supported(sender.tab.url)) throw Error('Unsupported page.');
  if (!own && !sender.tab) throw Error('Untrusted sender.');
  const id = own ? m.tabId : sender.tab?.id;
  switch (m.type) {
    case 'config': {
      const c = await configuration();
      return own ? c : { ...c, profiles: c.profiles.map(cleanProfile) };
    }
    case 'state': {
      let s = await read(id);
      if (Number.isInteger(id) && !s.profileId) {
        const c = await configuration();
        const p = c.profiles.find(p => p.id === c.activeProfile) || c.profiles[0];
        // Pin the initial default to this tab before another tab selects a profile.
        s = await write(id, old => old.profileId ? {} : { profileId: p.id });
      }
      return publicState(s);
    }
    case 'openSettings':
      await api.runtime.openOptionsPage();
      return true;
    case 'saveConfig': {
      if (!own) throw Error('Edit profiles in the extension.');
      const c = m.config;
      if (!Array.isArray(c.profiles) || !c.profiles.length || c.profiles.length > 30) throw Error('Create between 1 and 30 profiles.');
      const stored = await configuration();
      const profiles = c.profiles.map(p => {
        const latest = stored.profiles.find(v => v.id === p.id);
        return BMS.validateProfile({
          ...p,
          autoSelect: true,
          checkout: true,
          sendScreenshots: true,
          skipFood: true,
          canvasSelector: '',
          selectedSelector: '',
          ...(latest ? { zones: latest.zones, layout: latest.layout } : {})
        });
      });
      if (new Set(profiles.map(p => p.id)).size !== profiles.length) throw Error('Duplicate profile IDs.');
      if (!profiles.some(p => p.id === c.activeProfile)) throw Error('Select a profile.');
      await api.storage.local.set({ config: { schemaVersion: 2, profiles, activeProfile: c.activeProfile } });
      return true;
    }
    case 'bindProfile':
    case 'prepareLayout': {
      if (!own && m.type !== 'bindProfile') throw Error('Select a profile using the extension.');
      const s = await read(id);
      if (s.running) throw Error('Stop this tab before changing its profile or seats.');
      const tab = await api.tabs.get(id);
      if (!supported(tab.url)) throw Error('Open a BookMyShow tab.');
      const c = await configuration();
      const p = c.profiles.find(p => p.id === m.profileId);
      if (!p) throw Error('Select a theatre profile first.');
      await write(id, { profileId: p.id });
      if (own) await api.tabs.sendMessage(id, { type: 'refreshState' }).catch(() => {});
      return own ? p : cleanProfile(p);
    }
    case 'zones': {
      if (!sender.tab) throw Error('Choose seats on the page.');
      const c = await configuration(), s = await read(id), p = c.profiles.find(p => p.id === m.profileId);
      if (!p || s.running) throw Error('Stop watching before changing seats.');
      const validated = BMS.validateProfile({ ...p, zones: m.zones });
      const layoutWidth = Number.isFinite(m.layout?.width) && m.layout.width >= 1 ? m.layout.width : 1000;
      const layoutHeight = Number.isFinite(m.layout?.height) && m.layout.height >= 1 ? m.layout.height : 800;
      Object.assign(p, validated, {
        layout: {
          path: new URL(sender.tab.url).pathname,
          width: layoutWidth,
          height: layoutHeight,
          url: sender.tab.url,
          pageKey: BMS.pageKey(sender.tab.url)
        }
      });
      await api.storage.local.set({ config: c });
      await write(id, { profileId: p.id });
      return true;
    }
    case 'start':
    case 'startHere': {
      if (!own && m.type !== 'startHere') throw Error('Start from the extension.');
      const tab = await api.tabs.get(id);
      if (!supported(tab.url)) throw Error('Open a BookMyShow tab.');
      if ((await read(id)).running) throw Error('This tab is already running. Stop it before starting another run.');
      const c = await configuration(), p = c.profiles.find(p => p.id === m.profileId);
      if (!p) throw Error('Choose a profile.');
      if (!p.theatre.trim() || !p.email.trim() || !p.phone.trim() || !p.discord) {
        throw Error('Complete this profile\'s theatre, email, mobile number and Discord webhook first.');
      }
      if (!p.zones.length) throw Error('Choose the seats for this theatre first.');

      // Update layout reference to current tab URL so saved zones work across any showtime
      p.layout = {
        ...(p.layout || { width: 1000, height: 800 }),
        path: new URL(tab.url).pathname,
        url: tab.url,
        pageKey: BMS.pageKey(tab.url)
      };

      const all = await sessions.get(null);
      for (const [k, value] of Object.entries(all)) {
        if (k.startsWith('tab:') && value.running && value.profileId === p.id && k !== key(id)) {
          throw Error('This profile is already running in another tab. Different profiles can run in separate tabs.');
        }
      }
      // Verify the webhook before starting
      {
        const result = await discordPost(p, `🚀 **${p.name} • ${p.theatre}**\nAutomation started. Watching ${p.ticketCount} ticket(s). Payment remains manual.`);
        p.discordTest = { at: Date.now(), ok: true, messageId: result.messageId };
        await api.storage.local.set({ config: c });
      }
      stopped.delete(id);
      const s = {
        running: true,
        profileId: p.id,
        profileSnapshot: structuredClone(p),
        runId: crypto.randomUUID(),
        phase: 'watching',
        layoutUrl: tab.url,
        cycle: 1,
        reloads: 0,
        nextCheck: Date.now() + 2000,
        nextReload: 0,
        logs: [],
        events: {},
        started: Date.now()
      };
      await sessions.set({ [key(id)]: s });
      await sessions.remove(`assets:${id}`);
      await log(id, 'Started. Reloading this tab once before scanning.');
      try {
        await api.tabs.reload(id);
      } catch {
        await write(id, { running: false });
        throw Error('Could not reload this tab. Reload BookMyShow, then start again.');
      }
      return publicState(await read(id));
    }
    case 'beginCooldown': {
      if (!sender.tab) throw Error('Booking-page message required.');
      const s = await read(id);
      if (!s.running || s.runId !== m.runId) throw Error('Run stopped or changed.');
      if (!['qr', 'payment', 'done', 'cooldown'].includes(s.phase)) throw Error('No payment cycle to finish.');
      if (!s.resumeAt) {
        const now = Date.now();
        await write(id, { phase: 'cooldown', cooldownStartedAt: now, resumeAt: now + 5 * 60 * 1000 });
        await log(id, 'Payment completed. Monitoring resumes in 5 minutes.', m.runId);
      }
      return publicState(await read(id));
    }
    case 'resumeMonitoring': {
      if (!sender.tab) throw Error('Booking-page message required.');
      const s = await read(id);
      if (!s.running || s.runId !== m.runId) throw Error('Run stopped or changed.');
      if (s.phase !== 'cooldown' || !s.resumeAt || Date.now() < s.resumeAt) throw Error('The five-minute wait is not over yet.');
      const url = s.layoutUrl || s.profileSnapshot?.layout?.url;
      if (!supported(url) || !new URL(url).pathname.includes('/seat-layout/')) throw Error('The saved seat-map URL is unavailable. Open the seat map and restart.');
      const next = await write(id, {
        runId: crypto.randomUUID(), phase: 'watching', cycle: (s.cycle || 1) + 1,
        started: Date.now(), nextCheck: Date.now() + 500, nextReload: 0, reloads: 0,
        nextAction: 0, cooldownStartedAt: 0, resumeAt: 0, events: {},
        selectedNames: [], selectedPoints: [], seatZoneOffset: 0, seatCaptureAt: 0,
        seatCaptureError: '', payAt: 0, payClicked: false, qrClicked: false,
        qrCaptureAt: 0, qrRetryAt: 0, contactSubmitted: false
      });
      if (!next.running) throw Error('Run stopped.');
      await sessions.remove(`assets:${id}`);
      try {
        const active = await read(id);
        if (!active.running || active.runId !== next.runId) throw Error('Run stopped or changed.');
        await api.tabs.update(id, { url });
      } catch (e) {
        await write(id, old => old.runId === next.runId ? s : {});
        throw e;
      }
      await log(id, 'Five-minute wait finished. Monitoring the saved seat zones again.', next.runId);
      return publicState(await read(id));
    }
    case 'stop': {
      stopped.add(id);
      await write(id, { running: false, nextReload: 0, nextCheck: 0 });
      await log(id, m.reason ? `Stopped: ${String(m.reason).slice(0, 400)}` : 'Stopped.');
      api.tabs.sendMessage(id, { type: 'refreshState' }).catch(() => {});
      return true;
    }
    case 'reloadDue': {
      if (!sender.tab) throw Error('Booking-page message required.');
      const s = await read(id);
      if (!s.running || s.runId !== m.runId) throw Error('Run stopped or changed.');
      return reloadDue(id);
    }
    case 'update': {
      if (!sender.tab) throw Error('Page message required.');
      const old = await read(id);
      if (old.runId !== m.runId || !old.running) throw Error('Run stopped or changed.');
      const allowed = {};
      for (const field of [
        'phase', 'reloads', 'nextReload', 'nextCheck', 'layoutUrl', 'selectedNames', 'seatZoneOffset',
        'selectedPoints', 'payClicked', 'qrClicked', 'contactSubmitted', 'phaseStarted',
        'blocked', 'nextAction', 'seatCaptureAt', 'seatAttempts', 'payAt', 'payAttempts',
        'qrRetryAt', 'qrAttempts', 'qrCaptureAt', 'contactAttempts', 'dismissAttempts', 'seatCaptureError'
      ]) {
        if (field in m.patch) allowed[field] = m.patch[field];
      }
      await write(id, allowed);
      if (m.text) await log(id, String(m.text).slice(0, 500));
      return true;
    }
    case 'capturePage': {
      if (!sender.tab || sender.frameId) throw Error('Booking-page capture required.');
      if (!['seat', 'qr'].includes(m.kind)) throw Error('Invalid capture kind.');
      const s = await read(id);
      if (!s.running || s.runId !== m.runId) throw Error('Run stopped or changed.');
      const data = await capturePage(sender.tab, m.kind);
      const latest = await read(id);
      if (!latest.running || latest.runId !== m.runId) throw Error('Run stopped or changed.');
      return data;
    }
    case 'assets': {
      if (!sender.tab) throw Error('Page message required.');
      const s = await read(id);
      if (!s.running || s.runId !== m.runId) throw Error('Run changed.');
      const assets = (await sessions.get(`assets:${id}`))[`assets:${id}`] || {};
      for (const field of ['seat', 'qr']) {
        if (m[field]) {
          if (!validImage(m[field])) throw Error('Invalid or oversized captured image.');
          assets[field] = m[field];
        }
      }
      if (m.qrKind) assets.qrKind = m.qrKind === 'qr' ? 'qr' : 'screen';
      await sessions.set({ [`assets:${id}`]: assets });
      await log(id, `Saved ${m.qr ? 'QR' : 'seat-map'} image for Discord (${Math.round(String(m.qr || m.seat).length * 0.75 / 1024)} KB).`, m.runId);
      return { seat: !!assets.seat, qr: !!assets.qr };
    }
    case 'event': {
      if (!sender.tab) throw Error('Page event required.');
      const s = await read(id);
      if (!s.running || s.runId !== m.runId) throw Error('Run changed.');
      const name = m.event;
      if (!['available', 'selected', 'payment', 'error'].includes(name)) throw Error('Invalid notification.');
      const existing = s.events?.[name];
      if (existing) return existing;
      const entry = { status: 'queued', text: String(m.text).slice(0, 1000), attempts: 0 };
      await write(id, { events: { ...s.events, [name]: entry } });
      await api.notifications.create({
        type: 'basic',
        iconUrl: api.runtime.getURL('icons/128.png'),
        title: `${s.profileSnapshot.name} • BookMyShow`,
        message: entry.text.slice(0, 250)
      }).catch(() => {});
      void deliverEvent(id, s.runId, name);
      return entry;
    }
    case 'retryDelivery': {
      const s = await read(id);
      if (!own && (!s.running || s.runId !== m.runId)) return false;
      for (const [name, entry] of Object.entries(s.events || {})) {
        if (entry.status === 'retry' && Date.now() >= entry.retryAt) void deliverEvent(id, s.runId, name);
      }
      return true;
    }
    case 'testNotification': {
      if (!own) throw Error('Use the profile\'s Test Discord button.');
      const c = await configuration(), p = c.profiles.find(p => p.id === m.profileId);
      if (!p?.discord) throw Error('Save this profile\'s Discord webhook first.');
      try {
        const r = await discordPost(p, `✅ **Discord connected for ${p.name}**\nTheatre: ${p.theatre || 'Not set yet'}`);
        p.discordTest = { at: Date.now(), ok: true, ...r };
        await api.storage.local.set({ config: c });
        return 'Delivered to Discord. Check your channel.';
      } catch (e) {
        p.discordTest = { at: Date.now(), ok: false, error: e.message };
        await api.storage.local.set({ config: c });
        throw e;
      }
    }
    default:
      throw Error('Unknown command.');
  }
}

// Background scheduling does not depend on the booking page's timer budget.
const watchdogTabs = new Set();
async function reloadDue(id) {
  let claimed = false;
  const s = await write(id, old => {
    if (!old.running || old.phase !== 'watching' || !old.nextReload || Date.now() < old.nextReload) return {};
    claimed = true;
    return { nextReload: 0, reloads: (old.reloads || 0) + 1 };
  });
  if (!claimed || !(await read(id)).running) return false;
  try {
    await api.tabs.reload(id);
    await log(id, 'Reloaded seat map from background scheduler.', s.runId);
  } catch (e) {
    await log(id, `Background reload failed: ${e.message}`, s.runId);
  }
  return true;
}

async function watchdogTab(id) {
  if (watchdogTabs.has(id)) return;
  watchdogTabs.add(id);
  let timeout;
  try {
    const s = await read(id);
    if (!s.running) return;
    await handle({ type: 'retryDelivery', tabId: id }, { url: api.runtime.getURL('background.js') });
    const result = await Promise.race([
      api.tabs.sendMessage(id, { type: 'backgroundTick' }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Page response timed out')), 8000); })
    ]);
    if (result?.ok === false) throw Error(result.error);
    const latest = await read(id);
    if (latest.watchdogError) await write(id, { watchdogError: '' });
    // Only reload an overdue watching page that was not busy selecting seats.
    if (!result?.busy) await reloadDue(id);
  } catch (e) {
    const latest = await read(id);
    if (latest.running) {
      if (!latest.watchdogError) await log(id, `Background check: ${e.message}. Will retry.`, latest.runId);
      await write(id, { watchdogError: e.message });
      // Never reload checkout/payment to recover a missing content script.
      await reloadDue(id);
    }
  } finally {
    clearTimeout(timeout);
    watchdogTabs.delete(id);
  }
}

async function watchdog() {
  const all = await sessions.get(null);
  await Promise.allSettled(Object.entries(all)
    .filter(([k, s]) => k.startsWith('tab:') && s.running)
    .map(([k]) => watchdogTab(Number(k.slice(4)))));
}

if (api.alarms) {
  api.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'bms-watchdog') void watchdog();
  });
  api.alarms.create('bms-watchdog', { periodInMinutes: 0.5 });
  // Firefox background pages can also send frequent nudges between alarms.
  if (api.runtime.getBrowserInfo && typeof setInterval === 'function') {
    setInterval(() => { void watchdog(); }, 2000);
  }
}

api.runtime.onMessage.addListener((m, sender, respond) => {
  const immediate = ['config', 'state', 'stop', 'openSettings', 'retryDelivery', 'capturePage', 'update', 'reloadDue'].includes(m.type);
  const task = immediate ? handle(m, sender) : serial.then(() => handle(m, sender));
  if (!immediate) serial = task.catch(() => {});
  task.then(data => respond({ ok: true, data }), e => respond({ ok: false, error: e.message }));
  return true;
});

api.tabs.onRemoved.addListener(id => {
  stopped.delete(id);
  sessions.remove([key(id), `assets:${id}`]);
});
