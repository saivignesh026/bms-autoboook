const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const captureSource = fs.readFileSync('capture.js', 'utf8');
const contentSource = fs.readFileSync('content.js', 'utf8');
const jpeg = 'data:image/jpeg;base64,YWJj';
const quiet = { warn() {} };
function canvas(area, result = jpeg) {
  return { width: 100, height: 100, className: '',
    getBoundingClientRect: () => ({ width: area, height: area }), getClientRects: () => [1],
    toDataURL(type, quality) { this.request = [type, quality]; if (result instanceof Error) throw result; return result; } };
}
function captureContext(canvases = [], extra = {}) {
  const context = vm.createContext({ console: quiet, setTimeout, clearTimeout, window: { btoa },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    document: { body: {}, querySelectorAll: selector => selector === 'canvas' ? canvases : [], querySelector: () => null,
      createElement: () => {
        let source;
        return { getContext: () => ({ fillRect() {}, drawImage: image => { source = image; } }),
          toDataURL: (type, quality) => source.toDataURL(type, quality) };
      } }, ...extra });
  vm.runInContext(captureSource, context);
  return context;
}
test('the bundled html2canvas 1.4.1 loads for page-context capture', () => {
  const library = fs.readFileSync('vendor/html2canvas.min.js', 'utf8');
  assert.match(library, /html2canvas 1\.4\.1/);
  assert.ok(library.length > 190000);
  const context = vm.createContext({});
  vm.runInContext(library, context);
  assert.equal(typeof context.html2canvas, 'function');
  const scripts = JSON.parse(fs.readFileSync('manifest.json', 'utf8')).content_scripts[0].js;
  assert.ok(!scripts.includes('html2canvas.min.js'));
  assert.ok(!scripts.includes('capture.js'));
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.ok(!manifest.permissions.includes('activeTab'));
});

test('seat screenshot uses the supplied body target, html2canvas options and JPEG quality', async () => {
  let call;
  const output = canvas(500);
  const context = captureContext([], { html2canvas: async (target, options) => { call = { target, options }; return output; } });
  assert.equal(await context.BMSCapture.seat(), jpeg);
  assert.equal(call.target, context.document.body);
  assert.deepEqual(JSON.parse(JSON.stringify(call.options)), {
    useCORS: true, allowTaint: true, scale: 0.8, backgroundColor: '#ffffff'
  });
  assert.deepEqual(output.request, ['image/jpeg', 0.6]);
});

test('SVG extraction uses the supplied white rectangle, base64 encoding and intrinsic size rule', async () => {
  for (const size of [80, 120]) {
    const fallback = canvas(100);
    let source, output;
    class Image {
      set src(value) { source = Buffer.from(value.split(',')[1], 'base64').toString('utf8'); this.width = size; this.height = size; this.onload(); }
    }
    const svg = { querySelectorAll: tag => Array(tag === 'path' ? 6 : 0) };
    const context = captureContext([], { Image, XMLSerializer: class { serializeToString() { return '<svg width="120" height="120"><path/></svg>'; } },
      document: { querySelectorAll: selector => selector === 'svg' ? [svg] : [fallback],
        createElement() { output = { getContext: () => ({ fillRect() {}, drawImage() {} }), toDataURL: () => jpeg }; return output; } } });
    assert.equal((await context.BMSCapture.qr()).data, jpeg);
    assert.equal(output.width, size > 100 ? size : 300);
    assert.equal(output.height, size > 100 ? size : 300);
    assert.match(source, /<rect width="100%" height="100%" fill="white"\/>/);
    assert.match(source, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    assert.equal(fallback.request, undefined);
  }
});

test('QR canvas priority and JPEG quality match the userscript', async () => {
  const tiny = canvas(100), overlay = canvas(100), qr = canvas(100), later = canvas(100);
  tiny.width = 50;
  overlay.className = 'bms-target-box';
  const context = captureContext([tiny, overlay, qr, later]);
  assert.equal((await context.BMSCapture.qr()).data, jpeg);
  assert.deepEqual(qr.request, ['image/jpeg', 0.9]);
  assert.equal(tiny.request, undefined);
  assert.equal(overlay.request, undefined);
  assert.equal(later.request, undefined);
});

test('QR image parent or body is rendered by html2canvas with v67 options and quality', async () => {
  for (const image of [{ src: 'data:image/png;base64,YWJj', parentElement: {} }, null]) {
    let call;
    const output = canvas(100);
    const context = captureContext([], { html2canvas: async (target, options) => { call = { target, options }; return output; },
      document: { body: {}, querySelectorAll: () => [], querySelector: () => image } });
    assert.equal((await context.BMSCapture.qr()).data, jpeg);
    assert.equal(call.target, image ? image.parentElement : context.document.body);
    assert.deepEqual(JSON.parse(JSON.stringify(call.options)), {
      useCORS: true, allowTaint: true, scale: 1.2, backgroundColor: '#ffffff'
    });
    assert.deepEqual(output.request, ['image/jpeg', 0.8]);
  }
});

test('capture errors propagate without invoking a browser screenshot alternative', async () => {
  let browserCalls = 0;
  const context = captureContext([], {
    html2canvas: async () => { throw Error('html2canvas capture failed'); },
    browser: { runtime: { sendMessage: async () => { browserCalls++; } } }
  });
  await assert.rejects(context.BMSCapture.seat(), /html2canvas capture failed/);
  await assert.rejects(context.BMSCapture.qr(), /html2canvas capture failed/);
  assert.equal(browserCalls, 0);
  assert.doesNotMatch(captureSource, /captureVisibleTab|nativeScreenshot|MAX_IMAGE_LENGTH|WeakSet/);
  assert.doesNotMatch(fs.readFileSync('background.js', 'utf8'), /captureVisibleTab|case 'capture'|case 'sendScreenshot'/);
});

function functionSource(start, end) {
  return contentSource.slice(contentSource.indexOf(start), contentSource.indexOf(end));
}
test('quantity modal waits for missing option, then waits again before Select Seats', async () => {
  let now = 10000, options = [], selected = 0, confirmed = 0;
  const button = { innerText: 'Select Seats', offsetHeight: 20, click() { confirmed++; } };
  const context = vm.createContext({ Date: { now: () => now }, quantityStep: 0, quantityAt: 0,
    profile: { ticketCount: 2 }, BMS: { actionDelay: n => n + 150 }, tell() {}, waitAfter: async () => {},
    text: el => el.innerText, visible: () => true,
    document: { querySelectorAll: selector => selector === 'li, div, span' ? options : [button] } });
  vm.runInContext(functionSource('  async function handleQuantityModal()', '  async function captureAndSendQR()'), context);
  await context.handleQuantityModal();
  now += 3150;
  await context.handleQuantityModal();
  assert.equal(context.quantityStep, 0);
  options = [{ innerText: '2', children: [], click() { selected++; } }];
  await context.handleQuantityModal();
  assert.equal(selected, 1);
  assert.equal(confirmed, 0);
  now += 3150;
  await context.handleQuantityModal();
  assert.equal(confirmed, 1);
});
test('inline order-summary and payment-status both capture QR after deadline', async () => {
  for (const url of ['https://in.bookmyshow.com/order-summary/123', 'https://in.bookmyshow.com/payment-status/123']) {
    const events = [], assets = [];
    const context = vm.createContext({ console: quiet, Date,
      window: { location: { href: url } }, state: { phase: 'qr', qrClicked: true, qrCaptureAt: Date.now() - 1, qrRetryAt: Date.now() + 10000 },
      document: { querySelectorAll: () => [], querySelector: () => null }, visible: () => false,
      send: async m => assets.push(m), update: async patch => Object.assign(context.state, patch),
      announce: async event => events.push(event), tell() {}, BMSCapture: { qr: async () => ({ data: jpeg, kind: 'qr' }) } });
    context.paymentCompleted = () => false;
  vm.runInContext(functionSource('  async function captureAndSendQR()', '  async function tick()'), context);
    await context.step();
    assert.equal(assets[0].qr, jpeg);
    assert.deepEqual(events, ['payment']);
  }
});
test('popup IDs cover all JS selectors and normalized zones have no runtime lockout', () => {
  const html = fs.readFileSync('popup.html', 'utf8'), popup = fs.readFileSync('popup.js', 'utf8');
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const match of popup.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(match[1]), match[1]);
  assert.doesNotMatch(contentSource, /errorCount|different show|seat map changed size/i);
  assert.doesNotMatch(popup, /pageKey/);
  const background = fs.readFileSync('background.js', 'utf8');
  assert.doesNotMatch(background, /selected-seats\.jpg/);
  assert.ok(background.indexOf("name: 'qr_code.jpg'") < background.indexOf("name: 'seat_map.jpg'"));
});

const userscriptSource = fs.readFileSync('tests/fixtures/tampermonkey-v67.js', 'utf8');
function suppliedFunction(start, end) {
  return userscriptSource.slice(userscriptSource.indexOf(start), userscriptSource.indexOf(end));
}
test('QR extraction function is copied unchanged from the supplied v67 script', () => {
  const expected = suppliedFunction('  async function getQRBase64()', '  // --- 🚀 SCREENSHOT & DELIVERY ENGINE ---').trim();
  const actual = captureSource.slice(captureSource.indexOf('  async function getQRBase64()'), captureSource.indexOf('  async function qr()')).trim();
  assert.equal(actual, expected);
});

test('seat scanning clicks the outline center and counts filled seats without counting seat digits', () => {
  const BMS = require('../core.js');
  const width = 600, height = 400, pixels = new Uint8ClampedArray(width * height * 4);
  function paint(x, y, w, h, filled) {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
      if (!filled && dx && dy && dx < w - 1 && dy < h - 1) continue;
      pixels.set([20, 160, 20, 255], ((y + dy) * width + x + dx) * 4);
    }
  }
  paint(200, 120, 20, 20, false); // Available seat outline.
  paint(207, 126, 6, 8, true); // Its green seat number is not another seat.
  paint(230, 120, 20, 20, true); // Already selected seat.
  const events = [];
  const seatCanvas = { width, height,
    getBoundingClientRect: () => ({ left: 25, top: 50, width: 300, height: 200 }),
    dispatchEvent: event => events.push([event.type, event.clientX, event.clientY]) };
  const zones = [{ name: 'Two seats', left: 0.3, right: 0.45, top: 0.2, bottom: 0.4 }];
  const context = vm.createContext({ BMS, console: quiet, state: {}, profile: { zones }, host: { style: {} },
    MouseEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    document: { querySelectorAll: () => [seatCanvas], createElement: () => ({
      getContext: () => ({ drawImage() {}, getImageData: () => ({ data: pixels }) })
    }) } });
  vm.runInContext(functionSource('  function seatCanvases()', '  function tell('), context);
  vm.runInContext(functionSource('  function seatMarks(', '  function setNativeValue('), context);
  const found = context.scanFirstAvailableSeat();
  assert.equal(found.x, 209.5);
  assert.equal(found.y, 129.5);
  assert.equal(context.selectedSeatCount(), 1);
  context.simulateCanvasClick(found.canvas, found.x, found.y);
  assert.deepEqual(events, [
    ['mousedown', 129.75, 114.75], ['mouseup', 129.75, 114.75], ['click', 129.75, 114.75]
  ]);
});

test('QR card pointer/mouse event order and coordinates match supplied v67', () => {
  function eventsFor(source) {
    const events = [];
    class MouseEvent { constructor(type, options) { this.type = type; Object.assign(this, options); } }
    const context = vm.createContext({ MouseEvent });
    vm.runInContext(source, context);
    context.simulateNaturalClick({ getBoundingClientRect: () => ({ left: 10, top: 30, width: 80, height: 40 }),
      dispatchEvent: e => events.push([e.type, e.clientX, e.clientY, e.bubbles, e.cancelable]) });
    return events;
  }
  assert.deepEqual(eventsFor(functionSource('  function simulateNaturalClick(', '  function simulateCanvasClick(')),
    eventsFor(suppliedFunction('  function simulateNaturalClick(', '  // End of click reference.')));
});

test('booking waits 5s for seat capture, then 3s for Pay and sends only final images', async () => {
  let now = 10000, url = 'https://in.bookmyshow.com/seat-layout/123', payClicks = 0;
  const assets = [], events = [], captures = [];
  const context = vm.createContext({ Date: { now: () => now }, console: quiet,
    window: { location: { get href() { return url; } } },
    state: { phase: 'watching', runId: 'run' }, profile: { zones: [{}], ticketCount: 2 },
    selectedSeatCount: () => 2,
    BMS: { actionDelay: n => n + 150 }, handleQuantityModal: async () => false, map: () => ({}),
    scanFirstAvailableSeat: () => ({ x: 20, y: 30, name: 'D29 D28', canvas: {} }), simulateCanvasClick() {},
    payButton: () => ({ click() { payClicks++; } }), tell() {},
    send: async m => { if (m.type === 'assets') assets.push(m); },
    update: async patch => Object.assign(context.state, patch), announce: async (event, text) => events.push({ event, text }),
    BMSCapture: { seat: async () => { captures.push(now); return jpeg; }, qr: async () => ({ data: jpeg, kind: 'qr' }) },
    document: { querySelectorAll: () => [], querySelector: () => null } });
  vm.runInContext(functionSource('  async function waitAfter(', '  // v67 quantity timing'), context);
  context.paymentCompleted = () => false;
  vm.runInContext(functionSource('  async function captureAndSendQR()', '  async function tick()'), context);
  await context.step();
  assert.equal(context.state.phase, 'seat-wait');
  assert.equal(events.length, 0);
  context.map = () => null; // Checkout must continue if BMS removes the canvas.
  now += 5000;
  await context.step();
  assert.equal(captures.length, 0);
  now += 150;
  await context.step();
  assert.equal(context.state.phase, 'pay-wait');
  assert.equal(assets[0].seat, jpeg);
  now += 3000;
  await context.step();
  assert.equal(payClicks, 0);
  now += 150;
  await context.step();
  assert.equal(payClicks, 1);
  now += 3150;
  url = 'https://in.bookmyshow.com/payment-status/123';
  await context.step();
  now += 5150;
  await context.step();
  assert.deepEqual(events.map(e => e.event), ['available', 'payment']);
  assert.equal(assets[1].qr, jpeg);
});

test('Pay selector ignores generic Proceed and matches Pay ₹ anywhere, as supplied', () => {
  const elements = [{ textContent: 'Proceed' }, { textContent: 'Continue' }, { textContent: 'Total: Pay ₹450' }];
  const context = vm.createContext({ document: { querySelectorAll: () => elements }, visible: () => true, text: el => el.textContent });
  vm.runInContext(functionSource('  function payButton()', '  // v67 scans'), context);
  assert.equal(context.payButton(), elements[2]);
});

test('Discord multipart uses files[0] QR and files[1] saved seat map with correct bytes', async () => {
  const background = fs.readFileSync('background.js', 'utf8');
  let uploaded;
  const context = vm.createContext({ Blob, FormData, atob, URL, AbortSignal,
    BMS: { webhook: url => url },
    fetch: async (url, options) => {
      uploaded = options;
      return { ok: true, json: async () => ({ id: 'test-message', attachments: [{}, {}] }) };
    } });
  vm.runInContext(background.slice(background.indexOf('function base64ToBlob('), background.indexOf('async function eventStatus(')), context);
  const result = await context.discordPost({ discord: 'https://discord.com/api/webhooks/1/test' }, 'Payment', [
    { name: 'qr_code.jpg', data: jpeg }, { name: 'seat_map.jpg', data: jpeg }
  ]);
  assert.equal(result.attachments, 2);
  for (const [index, name] of ['qr_code.jpg', 'seat_map.jpg'].entries()) {
    const file = uploaded.body.get(`files[${index}]`);
    assert.equal(file.name, name);
    assert.equal(file.type, 'image/jpeg');
    assert.equal(await file.text(), 'abc');
  }
  assert.equal(uploaded.headers, undefined);
});

test('payment upload failure gets four attempts with v67 cooldown and keeps automation running', async () => {
  const background = fs.readFileSync('background.js', 'utf8');
  let now = 10000, attempts = 0;
  const state = { running: true, runId: 'run', profileSnapshot: { discord: 'test' },
    events: { payment: { text: 'Payment text', status: 'queued', attempts: 0 } } };
  const context = vm.createContext({ Date: { now: () => now }, deliveries: new Map(),
    BMS: { actionDelay: base => base + 150 }, read: async () => state,
    sessions: { get: async () => ({ 'assets:1': { qr: jpeg, seat: jpeg } }) }, log: async () => {},
    eventStatus: async (id, name, runId, entry) => { state.events[name] = entry; },
    discordPost: async (profile, text, images) => {
      attempts++;
      assert.equal(text, 'Payment text');
      assert.deepEqual(Array.from(images, image => image.name), ['qr_code.jpg', 'seat_map.jpg']);
      throw Object.assign(Error('Upload failed'), { retryable: false });
    } });
  vm.runInContext(background.slice(background.indexOf('async function deliverEvent('), background.indexOf('async function handle(')), context);
  for (let attempt = 1; attempt <= 4; attempt++) {
    await context.deliverEvent(1, 'run', 'payment');
    assert.equal(state.events.payment.attempts, attempt);
    assert.equal(state.events.payment.status, attempt < 4 ? 'retry' : 'failed');
    if (attempt < 4) {
      assert.equal(state.events.payment.retryAt - now, 5150);
      now = state.events.payment.retryAt;
    }
  }
  assert.equal(attempts, 4);
  assert.equal(state.running, true);
});

test('four consecutive transient tick errors leave the loop available to run again', async () => {
  let now = 10000, calls = 0;
  const state = { running: true };
  const context = vm.createContext({ Date: { now: () => now }, console: quiet, state,
    busy: false, lastPoll: 0, localCheck: 0, CHECK_MS: 500, editing: null,
    refresh: async () => {}, draw() {}, paintTimer() {}, tell() {},
    update: async patch => Object.assign(state, patch), send: async () => {},
    step: async () => { calls++; throw Error('DOM still animating'); } });
  vm.runInContext(functionSource('  async function tick()', '  api.runtime.onMessage.addListener'), context);
  for (let i = 0; i < 4; i++) {
    await context.tick();
    assert.equal(context.busy, false);
    assert.equal(state.running, true);
    now += 500;
  }
  assert.equal(calls, 4);
});

test('full message pipeline retains the seat across navigation and uploads both snapshots to Discord', async () => {
  const backgroundSource = fs.readFileSync('background.js', 'utf8');
  const store = {}, requests = [], injections = [];
  let page;
  const tab = { id: 7, url: 'https://in.bookmyshow.com/seat-layout/test' };
  let listener;
  const api = {
    storage: { local: { setAccessLevel: async () => {} }, session: {
      get: async key => key === null ? structuredClone(store) : { [key]: structuredClone(store[key]) },
      set: async patch => Object.assign(store, structuredClone(patch)), remove: async key => { delete store[key]; }
    } },
    runtime: { getURL: path => `moz-extension://companion/${path}`, onMessage: { addListener: callback => { listener = callback; } } },
    tabs: { get: async () => ({ ...tab }), onRemoved: { addListener() {} } }, notifications: { create: async () => 'notification' }
  };
  const background = vm.createContext({ browser: api, console: quiet, structuredClone, URL, Blob, FormData, atob, AbortSignal,
    BMS: { actionDelay: n => n + 150, webhook: url => url }, fetch: async (url, options) => {
      requests.push(options.body);
      return { ok: true, json: async () => ({ id: 'confirmed', attachments: [{ filename: 'qr_code.jpg' }, { filename: 'seat_map.jpg' }] }) };
    } });
  vm.runInContext(backgroundSource, background);
  store['tab:7'] = { runId: 'booking', running: true, phase: 'seat-wait', selectedNames: ['D29 D28'],
    profileSnapshot: { name: 'Test', theatre: 'Test', discord: 'https://discord.com/api/webhooks/1/test' }, events: {}, logs: [] };
  const send = message => new Promise((resolve, reject) => {
    listener(message, { tab }, result => result.ok ? resolve(result.data) : reject(Error(result.error)));
  });
  const seatData = 'data:image/jpeg;base64,c2VhdA==', qrData = 'data:image/jpeg;base64,cXI=';
  api.scripting = { executeScript: async details => {
    injections.push(details);
    assert.equal(details.world, 'MAIN');
    assert.equal(details.target.tabId, tab.id);
    assert.deepEqual(Array.from(details.target.frameIds), [0]);
    if (details.files) {
      assert.deepEqual(Array.from(details.files), ['vendor/html2canvas.min.js', 'capture.js']);
      page = captureContext([], { html2canvas: async () => canvas(500, tab.url.includes('seat-layout') ? seatData : qrData) });
      assert.equal(page.browser, undefined);
      return [{ frameId: 0, result: undefined }];
    }
    page.captureArgs = details.args;
    return [{ frameId: 0, result: await vm.runInContext(`(${details.func.toString()})(...captureArgs)`, page) }];
  } };
  const capturedSeat = await send({ type: 'capturePage', runId: 'booking', kind: 'seat' });
  await send({ type: 'assets', runId: 'booking', seat: capturedSeat });
  assert.equal(requests.length, 0);
  // A new document has a new capture context; only extension storage survives navigation.
  tab.url = 'https://in.bookmyshow.com/payment-status/test';
  const paymentCapture = { BMSCapture: { qr: () => send({ type: 'capturePage', runId: 'booking', kind: 'qr' }) } };
  const content = vm.createContext({ Date, console: quiet, BMSCapture: paymentCapture.BMSCapture, send,
    state: { ...structuredClone(store['tab:7']), qrCaptureAt: Date.now() - 1 }, tell() {},
    announce: (event, text) => send({ type: 'event', runId: 'booking', event, text }),
    update: patch => send({ type: 'update', runId: 'booking', patch }) });
  vm.runInContext(functionSource('  async function captureAndSendQR()', '  async function step()'), content);
  assert.equal(await content.captureAndSendQR(), true);
  for (let i = 0; i < 20 && store['tab:7'].events.payment?.status !== 'sent'; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(injections.length, 4);
  assert.equal(store['tab:7'].events.payment.status, 'sent');
  assert.equal(store['tab:7'].events.payment.attachments, 2);
  assert.equal(await requests[0].get('files[0]').text(), 'qr');
  assert.equal(await requests[0].get('files[1]').text(), 'seat');
  assert.equal(requests[0].get('files[0]').name, 'qr_code.jpg');
  assert.equal(requests[0].get('files[1]').name, 'seat_map.jpg');
});

test('failed seat-image storage reports the error and allows checkout without claiming a saved screenshot', async () => {
  let message;
  const context = vm.createContext({ Date, console: quiet,
    window: { location: { href: 'https://in.bookmyshow.com/seat-layout/test' } },
    state: { phase: 'seat-wait', seatCaptureAt: Date.now() - 1 }, profile: { zones: [{}], ticketCount: 2 },
    selectedSeatCount: () => 2, payButton: () => ({}), announce: async () => {},
    BMS: { actionDelay: n => n + 150 }, handleQuantityModal: async () => false,
    BMSCapture: { seat: async () => jpeg }, send: async () => { throw Error('Storage quota exceeded'); },
    update: async (patch, text) => { Object.assign(context.state, patch); message = text; } });
  context.paymentCompleted = () => false;
  vm.runInContext(functionSource('  async function step()', '  async function tick()'), context);
  await context.step();
  assert.equal(context.state.phase, 'pay-wait');
  assert.equal(context.state.seatCaptureError, 'Storage quota exceeded');
  assert.match(message, /screenshot failed.*Storage quota exceeded/);
});

test('failed QR capture reports its actual cause and does not announce image delivery', async () => {
  let message, sends = 0;
  const context = vm.createContext({ Date, console: quiet, state: {},
    BMSCapture: { qr: async () => { throw Error('html2canvas could not render the payment page.'); } },
    tell: text => { message = text; }, send: async () => { sends++; } });
  vm.runInContext(functionSource('  async function captureAndSendQR()', '  async function step()'), context);
  assert.equal(await context.captureAndSendQR(), false);
  assert.equal(sends, 0);
  assert.match(message, /QR screenshot failed:.*html2canvas/);
});

test('page-context bridge returns capture errors and rejects navigation during capture', async () => {
  const source = fs.readFileSync('background.js', 'utf8');
  const tab = { id: 9, url: 'https://in.bookmyshow.com/payment-status/test' };
  let currentURL = tab.url, fail = true;
  const page = vm.createContext({ BMSCapture: { qr: async () => {
    if (fail) throw Object.assign(Error('The operation is insecure.'), { name: 'SecurityError' });
    return { data: jpeg, kind: 'qr' };
  } } });
  const api = { tabs: { get: async () => ({ url: currentURL }) }, scripting: { executeScript: async details => {
    assert.equal(details.world, 'MAIN');
    if (details.files) return [{ frameId: 0 }];
    page.args = details.args;
    return [{ frameId: 0, result: await vm.runInContext(`(${details.func.toString()})(...args)`, page) }];
  } } };
  const context = vm.createContext({ api });
  vm.runInContext(source.slice(source.indexOf('async function capturePage('), source.indexOf('function base64ToBlob(')), context);
  await assert.rejects(context.capturePage(tab, 'qr'), /SecurityError: The operation is insecure/);
  fail = false;
  assert.equal((await context.capturePage(tab, 'qr')).data, jpeg);
  currentURL = 'https://in.bookmyshow.com/seat-layout/other';
  await assert.rejects(context.capturePage(tab, 'qr'), /page changed while capturing/);
});

test('two-ticket booking only captures and advances when two filled seats and Pay are confirmed', async () => {
  for (const [selected, hasPay, expected] of [[0, false, 'watching'], [1, true, 'watching'], [2, false, 'seat-wait'], [2, true, 'pay-wait']]) {
    let captures = 0;
    const events = [];
    const context = vm.createContext({ Date, console: quiet,
      window: { location: { href: 'https://in.bookmyshow.com/seat-layout/test' } },
      state: { phase: 'seat-wait', seatCaptureAt: Date.now() - 1, selectedNames: ['Seat 2'], seatZoneOffset: 1 },
      profile: { ticketCount: 2, zones: [{}, {}, {}] }, BMS: { actionDelay: n => n + 150 },
      handleQuantityModal: async () => false, selectedSeatCount: () => selected,
      payButton: () => hasPay ? {} : null, tell() {}, send: async () => {},
      update: async patch => Object.assign(context.state, patch), announce: async event => events.push(event),
      BMSCapture: { seat: async () => { captures++; return jpeg; } } });
    context.paymentCompleted = () => false;
  vm.runInContext(functionSource('  async function step()', '  async function tick()'), context);
    await context.step();
    assert.equal(context.state.phase, expected);
    assert.equal(captures, expected === 'pay-wait' ? 1 : 0);
    assert.deepEqual(events, expected === 'pay-wait' ? ['available'] : []);
    if (expected === 'watching') assert.equal(context.state.seatZoneOffset, 2);
  }
});

test('payment completion detection requires a visible success confirmation', () => {
  let label = '', shown = true;
  const context = vm.createContext({ document: { querySelectorAll: () => [{}] },
    visible: () => shown, text: () => label });
  vm.runInContext(functionSource('  function paymentCompleted()', '  async function step()'), context);
  for (const value of ['Payment successful', 'Your payment is completed!', 'Booking Confirmed', 'Your booking is confirmed.', 'Tickets booked successfully']) {
    label = value;
    assert.equal(context.paymentCompleted(), true, label);
  }
  for (const value of ['Processing Payment', 'Scan QR code', 'QR sent to Discord!', 'Payment not successful', 'Payment failed', 'Booking confirmed?']) {
    label = value;
    assert.equal(context.paymentCompleted(), false, label);
  }
  label = 'Payment successful'; shown = false;
  assert.equal(context.paymentCompleted(), false);
});

function cycleHarness() {
  let now = 10000, generation = 1;
  const navigations = [], layoutUrl = 'https://in.bookmyshow.com/movies/seat-layout/show';
  const tab = { id: 21, url: 'https://in.bookmyshow.com/booking-confirmation/test' };
  const store = {
    'tab:21': { running: true, runId: 'cycle-1', phase: 'done', cycle: 1, layoutUrl,
      profileId: 'theatre', profileSnapshot: { name: 'Theatre', layout: { url: layoutUrl } },
      selectedNames: ['Two seats'], selectedPoints: [{}], qrClicked: true, contactSubmitted: true,
      events: { available: { status: 'sent' }, payment: { status: 'sent' } }, logs: [] },
    'assets:21': { qr: jpeg, seat: jpeg }
  };
  const api = {
    storage: { local: { setAccessLevel: async () => {} }, session: {
      get: async key => ({ [key]: structuredClone(store[key]) }),
      set: async patch => Object.assign(store, structuredClone(patch)), remove: async key => { delete store[key]; }
    } }, runtime: { getURL: path => `moz-extension://companion/${path}`, onMessage: { addListener() {} } },
    tabs: { onRemoved: { addListener() {} }, sendMessage: async () => {},
      update: async (id, patch) => { navigations.push({ id, ...patch }); } }
  };
  const context = vm.createContext({ browser: api, structuredClone, URL, console: quiet,
    Date: { now: () => now }, crypto: { randomUUID: () => `cycle-${++generation}` } });
  vm.runInContext(fs.readFileSync('background.js', 'utf8'), context);
  return { store, navigations, layoutUrl, setNow: value => { now = value; },
    send: (type, runId = 'cycle-1') => context.handle({ type, runId }, { tab, frameId: 0 }) };
}

test('five-minute cooldown persists once, then starts a fresh cycle on the original seat map', async () => {
  const h = cycleHarness();
  await h.send('beginCooldown');
  assert.equal(h.store['tab:21'].resumeAt, 310000);
  h.setNow(20000);
  await h.send('beginCooldown');
  assert.equal(h.store['tab:21'].resumeAt, 310000);
  h.setNow(309999);
  await assert.rejects(h.send('resumeMonitoring'), /not over yet/);
  assert.equal(h.navigations.length, 0);
  h.setNow(310000);
  await h.send('resumeMonitoring');
  const state = h.store['tab:21'];
  assert.equal(state.running, true);
  assert.equal(state.phase, 'watching');
  assert.equal(state.runId, 'cycle-2');
  assert.equal(state.cycle, 2);
  assert.equal(state.resumeAt, 0);
  assert.equal(state.qrClicked, false);
  assert.deepEqual(state.events, {});
  assert.deepEqual(state.selectedNames, []);
  assert.equal(h.store['assets:21'], undefined);
  assert.deepEqual(h.navigations, [{ id: 21, url: h.layoutUrl }]);
});

test('Stop during the cooldown cancels automatic monitoring restart', async () => {
  const h = cycleHarness();
  await h.send('beginCooldown');
  await h.send('stop');
  h.setNow(400000);
  await assert.rejects(h.send('resumeMonitoring'), /stopped or changed/);
  assert.equal(h.store['tab:21'].running, false);
  assert.equal(h.navigations.length, 0);
});

test('success confirmation starts the cooldown; the content loop resumes only after its deadline', async () => {
  let now = 10000, confirmed = false;
  const messages = [];
  const context = vm.createContext({ Date: { now: () => now },
    window: { location: { href: 'https://in.bookmyshow.com/booking-confirmation/test' } },
    state: { phase: 'done', runId: 'booking', events: { payment: { status: 'sent' } } },
    paymentCompleted: () => confirmed, refresh: async () => {}, tell() {},
    send: async message => {
      messages.push(message.type);
      if (message.type === 'beginCooldown') Object.assign(context.state, { phase: 'cooldown', resumeAt: now + 300000 });
    } });
  vm.runInContext(functionSource('  async function step()', '  async function tick()'), context);
  await context.step();
  assert.deepEqual(messages, ['retryDelivery']);
  confirmed = true;
  await context.step();
  assert.equal(messages.at(-1), 'beginCooldown');
  now += 299999;
  await context.step();
  assert.equal(messages.at(-1), 'beginCooldown');
  now++;
  await context.step();
  assert.equal(messages.at(-1), 'resumeMonitoring');
});
