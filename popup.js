const api = globalThis.browser || chrome;
const $ = id => document.getElementById(id);
let tab, config, current, state = { running: false }, working = false;

async function send(m) {
  const r = await api.runtime.sendMessage(m);
  if (!r?.ok) throw Error(r?.error || 'Extension unavailable.');
  return r.data;
}

function show(message, error = false) {
  $('message').textContent = message;
  $('message').className = `status ${error ? 'error' : 'success'}`;
}

function supported(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'bookmyshow.com' || u.hostname.endsWith('.bookmyshow.com'));
  } catch {
    return false;
  }
}

function render() {
  $('tabContext').textContent = tab ? `Tab ${tab.id}: ${tab.title || 'BookMyShow'}` : 'Open a BookMyShow tab to select its profile.';
  const complete = !!(current?.theatre && current.email && current.phone && current.discord);
  const seats = !!current?.zones?.length;
  $('running').textContent = state.running ? 'Running' : 'Ready';
  $('headline').textContent = !complete ? 'Set up this theatre.' : state.running ? 'Booking assistant is running.' : seats ? 'Ready to start.' : 'Choose seats for this show.';
  $('summary').textContent = !complete ? 'Add the theatre, email, mobile and webhook in Manage profiles.' : state.running ? (state.status || 'Working...') : 'Start runs the complete sequence through to the payment QR.';
  $('seats').replaceChildren();
  for (const z of seats ? current.zones : []) {
    const chip = document.createElement('span');
    chip.className = 'seat-chip';
    chip.textContent = z.name;
    $('seats').append(chip);
  }
  if (!seats) $('seats').textContent = 'No seats saved for this profile.';
  $('details').textContent = current ? `${current.theatre || 'Theatre not set'} • ${current.ticketCount} ticket(s) • ${current.email || 'Email missing'} • ${current.phone || 'Mobile missing'}` : '';
  $('start').textContent = !complete ? 'Set up profile' : !seats ? 'Choose seats' : 'Start automatically';
  $('start').classList.toggle('hidden', !!state.running);
  $('stop').classList.toggle('hidden', !state.running);
  for (const id of ['start', 'stop', 'choose']) $(id).disabled = !tab || working;
  $('profile').disabled = working || !!state.running;
  $('test').disabled = working || !current?.discord;
  $('delivery').textContent = Object.entries(state.events || {}).map(([name, e]) => `Discord ${name}: ${e.status}${e.error ? ' — ' + e.error : ''}`).join('\n') || 'Discord connection is checked when you click Start.';
  $('logs').textContent = (state.logs || []).slice(-12).map(l => `${new Date(l.time).toLocaleTimeString()} ${l.text}`).join('\n') || 'No activity.';
  paintTimer();
}

function paintTimer() {
  if (state.running && state.phase === 'cooldown') {
    const seconds = BMS.countdown(state.resumeAt, Date.now());
    $('timer').textContent = `Monitoring resumes in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    return;
  }
  $('timer').textContent = !state.running
    ? ''
    : state.phase === 'watching'
      ? `Next check in ${BMS.countdown(state.nextCheck || Date.now())}s • Reload in ${state.nextReload ? BMS.countdown(state.nextReload) + 's' : '—'}`
      : `Current step: ${state.phase}`;
}

async function load() {
  config = await send({ type: 'config' });
  state = tab ? await send({ type: 'state', tabId: tab.id }) : { running: false };
  current = config.profiles.find(p => p.id === state.profileId) || config.profiles.find(p => p.id === config.activeProfile) || config.profiles[0];
  $('profile').replaceChildren();
  for (const p of config.profiles) {
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = `${p.name}${p.theatre ? ' — ' + p.theatre : ''}`;
    $('profile').append(option);
  }
  $('profile').value = current.id;
  render();
}

async function perform(fn) {
  working = true;
  render();
  try {
    await fn();
  } catch (e) {
    show(e.message, true);
  } finally {
    working = false;
    render();
  }
}

async function choose() {
  if (!tab?.url.includes('/seat-layout/')) throw Error('Open the BookMyShow seat-selection screen first.');
  await send({ type: 'prepareLayout', tabId: tab.id, profileId: current.id });
  const r = await api.tabs.sendMessage(tab.id, { type: 'calibrate' });
  if (!r?.ok) throw Error(r?.error || 'Reload BookMyShow, then try again.');
  window.close();
}

$('profiles').onclick = () => api.runtime.openOptionsPage();
$('choose').onclick = () => perform(choose);
$('profile').onchange = () => perform(async () => {
  const selected = $('profile').value;
  if (tab) await send({ type: 'bindProfile', tabId: tab.id, profileId: selected });
  else {
    config.activeProfile = selected;
    await send({ type: 'saveConfig', config });
  }
  await load();
});

$('start').onclick = () => perform(async () => {
  if (!current.theatre || !current.email || !current.phone || !current.discord) {
    await api.runtime.openOptionsPage();
    return;
  }
  if (!current?.zones?.length) {
    await choose();
    return;
  }
  show('Checking Discord, then starting...');
  await send({ type: 'start', tabId: tab.id, profileId: current.id });
  await load();
  show('Started. Discord confirmed the start message.');
});

$('stop').onclick = () => perform(async () => {
  await send({ type: 'stop', tabId: tab.id });
  await load();
  show('Stopped.');
});

$('test').onclick = () => perform(async () => {
  show('Testing Discord...');
  show(await send({ type: 'testNotification', profileId: current.id }));
});

async function followActiveTab() {
  const [active] = await api.tabs.query({ active: true, currentWindow: true });
  tab = supported(active?.url) ? active : null;
  await load();
}

api.tabs.onActivated.addListener(() => followActiveTab().catch(e => show(e.message, true)));

(async () => {
  try {
    await followActiveTab();
    setInterval(paintTimer, 250);
    setInterval(async () => {
      if (working || !tab) return;
      try {
        const id = tab.id;
        const next = await send({ type: 'state', tabId: id });
        if (tab?.id !== id) return;
        state = next;
        render();
      } catch {}
    }, 2000);
  } catch (e) {
    show(e.message, true);
  }
})();
