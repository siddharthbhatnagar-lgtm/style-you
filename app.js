(() => { 'use strict';
const __mods=Object.create(null), __cache=Object.create(null);
function require(id){ if(__cache[id]) return __cache[id].exports; const f=__mods[id]; if(!f) throw new Error('Missing module '+id); const m={exports:{}}; __cache[id]=m; f(require,m.exports,m); return m.exports; }
__mods['js/app.js'] = function(require,exports,module){
// Style You — app shell: state, saving with Undo, routing, navigation, updates, shared items.
const store = require('js/store.js');
const { defaultState } = require('js/state.js');
const { clone, localISO, daysBetween } = require('js/util.js');
const { $, html, raw, icon, toast, finishUndo, handlePop, closeAllSheets, sheetsOpen, dropAllSheets, hasPendingUndo, applyLook, isIOS, isStandalone, look } = require('js/ui.js');
const { effectiveStatus } = require('js/engine.js');

const APP_VERSION = '6.4.2';
const state = defaultState();
const ui = { route: '', params: [], mixPage: 0, flags: {} };

const today = () => localISO();

// ---------- saving + Undo ----------
function save() { return store.saveState(state); }

// Change state; optionally offer Undo for 6 seconds. Pictures listed in dropImages are deleted only when the Undo window closes.
function mutate(fn, { undo = null, dropImages = [], rerender = true, toastMsg = null } = {}) {
  const before = undo ? clone(state) : null;
  const res = fn(state);
  save();
  if (rerender) render();
  if (undo) {
    // Undo puts back only the parts this change touched, so other work done meanwhile (e.g. a new occasion) is kept.
    const touched = Object.keys(before).filter(k => JSON.stringify(before[k]) !== JSON.stringify(state[k]));
    toast(undo, {
      undo: () => { for (const k of touched) state[k] = before[k]; save(); render(); toast('Undone', { ms: 2000 }); },
      onExpire: () => { dropImages.forEach(id => { if (!isImageUsed(id)) store.deleteImage(id); }); }
    });
  } else if (toastMsg) toast(toastMsg, { ms: 2500 });
  return res;
}
function overwriteState(next) { for (const k of Object.keys(state)) delete state[k]; Object.assign(state, next); }
function replaceState(next) { overwriteState(next); save(); }

// Every picture id the saved data points at (used for clean-up and to avoid deleting shared pictures).
function imageRefs(s = state) {
  const r = new Set();
  const add = id => { if (id) r.add(id); };
  s.wardrobe.forEach(w => { add(w.photo?.full); add(w.photo?.thumb); });
  s.looks.forEach(l => { Object.values(l.pictures || {}).forEach(add); (l.pieces || []).forEach(p => add(p.thumb)); });
  s.sessions.forEach(x => { add(x.photoId); Object.values(x.pictures || {}).forEach(add); });
  add(s.profile.myPhoto);
  return r;
}
function isImageUsed(id) { return imageRefs().has(id); }

// ---------- helpers used by many screens ----------
const itemById = id => state.wardrobe.find(w => w.id === id);
const itemsActive = () => state.wardrobe.filter(w => w.status !== 'Archived');
const availableNow = w => effectiveStatus(w, today()) === 'Available';
function aiName(which = state.profile.defaultAI) { return which === 'chatgpt' ? 'ChatGPT' : 'Gemini'; }
function aiForStage(stage = 'looks', session = null) {
  const map = state.profile.aiRouting || {};
  const key = stage === 'shopping' ? 'shopping' : (stage === 'preview' || stage === 'correction' ? 'preview' : 'looks');
  const override = session?.bridge?.stageAI?.[key];
  const pref = override || map[key];
  return pref && pref !== 'default' ? pref : (session?.ai || state.profile.defaultAI);
}
function sessionReturnURL(id) {
  try { return `${location.origin}${location.pathname}#/session/${encodeURIComponent(id)}`; } catch { return ''; }
}
function activeSessions() { return state.sessions.filter(s => s.status === 'active'); }
function recordHandoff({ sessionId = null, provider = null, kind = 'request', method = 'unknown', stage = '', note = '' } = {}) {
  const e = { id: `h-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toISOString(), sessionId, provider: provider || state.profile.defaultAI, kind, method, stage, note };
  state.handoffs = Array.isArray(state.handoffs) ? state.handoffs : [];
  state.handoffs.unshift(e); state.handoffs = state.handoffs.slice(0, 60); save();
  return e;
}
function recordAIInbox({ sessionId = null, provider = null, type = 'result', title = 'AI result received', detail = '', payload = '', route = '' } = {}) {
  const e = { id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toISOString(), sessionId, provider: provider || null, type, title, detail: String(detail || '').slice(0, 240), payload: String(payload || '').slice(0, 50000), route, read: false };
  state.aiInbox = Array.isArray(state.aiInbox) ? state.aiInbox : [];
  state.aiInbox.unshift(e); state.aiInbox = state.aiInbox.slice(0, 80); save();
  return e;
}
function unreadAI() { return (state.aiInbox || []).filter(x => !x.read).length; }
function backupDue() {
  const st = state.settings;
  if (st.backupSnoozeUntil && st.backupSnoozeUntil > today()) return false;
  if ((st.photosSinceBackup || 0) >= 20) return true;
  const hasData = state.wardrobe.length + state.looks.length > 0;
  if (!hasData) return false;
  const since = st.lastBackup || st.firstRunAt || today();
  return daysBetween(since.slice(0, 10), today()) >= 14;
}
// iPhone in a Safari tab: Safari may clear saved data after 7 days without a visit, so pictures are kept for this visit only.
// The Home Screen app has its own storage, separate from Safari; data is still only on the phone, so backups matter.
function photosAtRisk() { return isIOS && !isStandalone(); }

// ---------- routing ----------
const routes = {};
function route(name, fn) { routes[name] = fn; }
function go(path) {
  const target = '#/' + String(path || 'home').replace(/^#?\/?/, '');
  if (location.hash === target) render(); else location.hash = target;
}
async function goClean(path) { await closeAllSheets(); go(path); }

const TABS = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'wardrobe', label: 'Wardrobe', icon: 'hanger' },
  { id: 'create', label: 'Create', icon: 'sparkle' },
  { id: 'looks', label: 'Looks', icon: 'bookmark' },
  { id: 'settings', label: 'More', icon: 'more' }
];
const TAB_OF = { home: 'home', session: 'create', week: 'create', create: 'create', wardrobe: 'wardrobe', item: 'wardrobe', add: 'wardrobe', label: 'wardrobe', mix: 'create', looks: 'looks', look: 'looks', 'import-look': 'looks', settings: 'settings', ai: 'settings' };

function renderNav(active) {
  const nav = $('#nav');
  nav.innerHTML = html`${TABS.map(t => raw(html`<a href="#/${t.id}" class="tab${t.id === 'create' ? ' tab-create' : ''}${active === t.id ? ' on' : ''}" ${raw(active === t.id ? 'aria-current="page"' : '')}>${icon(t.icon)}<span>${t.label}</span></a>`))}`;
}

let lastRoute = '';
function render() {
  const hash = location.hash.replace(/^#\/?/, '') || 'home';
  const [name, ...params] = hash.split('/').map(x => { try { return decodeURIComponent(x); } catch { return x; } });
  ui.seq = (ui.seq || 0) + 1;
  const needsSetup = !state.profile.onboarded && name !== 'onboarding' && name !== 'about';
  if (needsSetup && name === 'session' && params[0] && params[0] !== 'new') {
    // A return link from the AI app opened a browser where Style You holds nothing (on iPhone, Safari and the
    // Home Screen app keep separate data). Say where the occasion is instead of starting setup.
    document.body.classList.add('no-nav'); renderNav('');
    returnLanding($('#view')); lastRoute = hash; return;
  }
  if (needsSetup) { location.replace('#/onboarding'); return; }
  const fn = routes[name] || routes.home;
  const tab = TAB_OF[name] || (name === 'onboarding' ? '' : 'home');
  document.body.classList.toggle('no-nav', name === 'onboarding');
  renderNav(tab);
  const view = $('#view');
  const changed = lastRoute !== hash;
  ui.route = name; ui.params = params;
  const fail = e => {
    console.error(e);
    view.innerHTML = html`<div class="page"><div class="card warn-card"><h2>Something went wrong on this screen</h2><p>${String(e?.message || e)}</p><a class="btn primary" href="#/home">Go to Today</a></div></div>`;
  };
  try { const r = fn(view, params); if (r && typeof r.catch === 'function') r.catch(fail); }
  catch (e) { fail(e); }
  if (changed) {
    lastRoute = hash;
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) { view.classList.remove('enter'); void view.offsetWidth; view.classList.add('enter'); clearTimeout(ui.enterT); ui.enterT = setTimeout(() => view.classList.remove('enter'), 260); }
    window.scrollTo(0, 0);
    const h = view.querySelector('h1'); if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }
}

function returnLanding(view) {
  view.innerHTML = html`<div class="page landing"><div class="ob-hero"><img class="logo-big" src="icon.svg" alt="" width="76" height="76">
    <h1>Open Style You from your Home Screen</h1>
    <p class="lead">Your occasion is saved in the Style You app on your Home Screen, or in the browser where you started it. This browser keeps its own separate copy, and it's empty.</p></div>
    <ol class="steps"><li>Go to your Home Screen and open <b>Style You</b>.</li><li>Your occasion opens where you left it. The reply you copied is still on the clipboard, so you can paste it there.</li></ol>
    <div class="btn-col"><a class="btn ghost" href="#/onboarding">Set up Style You in this browser instead</a></div></div>`;
}

// ---------- updates (service worker) ----------
let swReg = null;
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    swReg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    if (!swReg) return;
    const showIfWaiting = () => { if (swReg.waiting && navigator.serviceWorker.controller) showUpdate(); };
    showIfWaiting();
    swReg.addEventListener('updatefound', () => {
      const nw = swReg.installing;
      nw?.addEventListener('statechange', () => { if (nw.state === 'installed') showIfWaiting(); });
    });
    // Reload only after the user tapped "update" (the first install also changes the controller).
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!ui.updating || ui.reloading) return; ui.reloading = true; location.reload(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') swReg.update().catch(() => {}); });
  } catch (e) { console.warn('SW', e); }
}
function showUpdate() {
  const b = $('#update');
  b.innerHTML = html`<button class="update-btn">${icon('refresh')}<span>New version – tap to update</span></button>`;
  b.hidden = false;
  b.querySelector('button').onclick = async () => {
    await store.flush();
    ui.updating = true;
    if (swReg?.waiting) swReg.waiting.postMessage({ type: 'SKIP_WAITING' }); else location.reload();
  };
}

// ---------- things shared into the app (Android) ----------
let inboxHandler = null;
function onInbox(fn) { inboxHandler = fn; }
let inboxBusy = null;
function checkInbox() {
  if (inboxBusy) return inboxBusy;
  inboxBusy = (async () => {
    try {
      const entries = await store.peekInbox().catch(() => []);
      for (const e of entries) { if (!inboxHandler) break; try { await inboxHandler(e); } catch (err) { console.error(err); } await store.removeInbox(e.id).catch(() => {}); }
    } finally { inboxBusy = null; }
  })();
  return inboxBusy;
}

// ---------- boot ----------
async function boot() {
  await store.open();
  overwriteState(await store.loadState());
  applyLook(state.settings.appearance || 'auto');
  store.setPhotosEphemeral(photosAtRisk() && !state.settings.keepTabPhotos);
  if (state.settings.migratedFromV5) { delete state.settings.migratedFromV5; save(); setTimeout(() => toast('Your earlier wardrobe and looks were brought over.', { ms: 5000 }), 600); }
  window.addEventListener('hashchange', () => { if (sheetsOpen()) dropAllSheets(); render(); });
  window.addEventListener('popstate', () => { handlePop(); });
  window.addEventListener('sy-save-error', e => toast(e.detail === 'QuotaExceededError' ? 'This device is out of space for Style You. Free space in Settings → Storage.' : 'Could not save just now. Your last change may be lost.', { ms: 8000 }));
  window.addEventListener('pagehide', () => { finishUndo(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') finishUndo(); else checkInbox(); });
  if (store.mode === 'memory') document.body.classList.add('no-storage');
  render();
  registerSW();
  checkInbox();
  if (isStandalone() && !isIOS) store.persist();
  setTimeout(sweepOrphans, 8000);
}

// Pictures nothing points at (for example after the app was closed during an Undo window) are removed.
async function sweepOrphans() {
  try {
    if (sheetsOpen() || hasPendingUndo()) { setTimeout(sweepOrphans, 15000); return; }
    // Photos that no longer exist (e.g. kept only for one Safari-tab visit): forget them so the item offers "Add a photo".
    let fixed = 0;
    for (const w of state.wardrobe) if (w.photo?.full && (await store.imageExists(w.photo.full)) === 'no') { w.photo = null; fixed++; }
    if (state.profile.myPhoto && (await store.imageExists(state.profile.myPhoto)) === 'no') { state.profile.myPhoto = null; fixed++; }
    for (const l of state.looks) {
      if (l.pictures?.after && (await store.imageExists(l.pictures.after)) === 'no') { l.pictures = { ...l.pictures, after: null, afterThumb: null }; fixed++; }
      if (l.pictures?.actual && (await store.imageExists(l.pictures.actual)) === 'no') { l.pictures = { ...l.pictures, actual: null, actualThumb: null }; fixed++; }
      if (l.pictures?.before && (await store.imageExists(l.pictures.before)) === 'no') { l.pictures.before = null; fixed++; }
    }
    for (const x of state.sessions) if (x.photoId && (await store.imageExists(x.photoId)) === 'no') { x.photoId = null; fixed++; }
    if (fixed) { save(); if (['wardrobe', 'item', 'looks', 'look'].includes(ui.route)) render(); }
    const refs = imageRefs(); const now = Date.now();
    const keep = new Set(ui.keepImages || []);
    for (const m of await store.allImageMeta()) if (!refs.has(m.id) && !keep.has(m.id) && now - (m.createdAt || 0) > 10 * 60 * 1000) await store.deleteImage(m.id);
  } catch (e) { console.warn('sweep', e); }
}

Object.defineProperty(exports,'APP_VERSION',{enumerable:true,get:()=>APP_VERSION});
Object.defineProperty(exports,'state',{enumerable:true,get:()=>state});
Object.defineProperty(exports,'ui',{enumerable:true,get:()=>ui});
Object.defineProperty(exports,'today',{enumerable:true,get:()=>today});
Object.defineProperty(exports,'save',{enumerable:true,get:()=>save});
Object.defineProperty(exports,'mutate',{enumerable:true,get:()=>mutate});
Object.defineProperty(exports,'replaceState',{enumerable:true,get:()=>replaceState});
Object.defineProperty(exports,'imageRefs',{enumerable:true,get:()=>imageRefs});
Object.defineProperty(exports,'isImageUsed',{enumerable:true,get:()=>isImageUsed});
Object.defineProperty(exports,'itemById',{enumerable:true,get:()=>itemById});
Object.defineProperty(exports,'itemsActive',{enumerable:true,get:()=>itemsActive});
Object.defineProperty(exports,'availableNow',{enumerable:true,get:()=>availableNow});
Object.defineProperty(exports,'aiName',{enumerable:true,get:()=>aiName});
Object.defineProperty(exports,'aiForStage',{enumerable:true,get:()=>aiForStage});
Object.defineProperty(exports,'sessionReturnURL',{enumerable:true,get:()=>sessionReturnURL});
Object.defineProperty(exports,'activeSessions',{enumerable:true,get:()=>activeSessions});
Object.defineProperty(exports,'recordHandoff',{enumerable:true,get:()=>recordHandoff});
Object.defineProperty(exports,'recordAIInbox',{enumerable:true,get:()=>recordAIInbox});
Object.defineProperty(exports,'unreadAI',{enumerable:true,get:()=>unreadAI});
Object.defineProperty(exports,'backupDue',{enumerable:true,get:()=>backupDue});
Object.defineProperty(exports,'photosAtRisk',{enumerable:true,get:()=>photosAtRisk});
Object.defineProperty(exports,'route',{enumerable:true,get:()=>route});
Object.defineProperty(exports,'go',{enumerable:true,get:()=>go});
Object.defineProperty(exports,'goClean',{enumerable:true,get:()=>goClean});
Object.defineProperty(exports,'render',{enumerable:true,get:()=>render});
Object.defineProperty(exports,'onInbox',{enumerable:true,get:()=>onInbox});
Object.defineProperty(exports,'checkInbox',{enumerable:true,get:()=>checkInbox});
Object.defineProperty(exports,'boot',{enumerable:true,get:()=>boot});
Object.defineProperty(exports,'look',{enumerable:true,get:()=>look});
};
__mods['js/catalog.js'] = function(require,exports,module){
// Reference data: categories, occasions, colour names, colour maths. Pure (Node-testable).

// group: top | bottom | one (complete outfit) | layer | footwear | accessory
// style: indian | western | both ; prefix: code letters ; f: default formality 1-5
const CATEGORIES = [
  { id: 'kurta', label: 'Kurta / kurti', group: 'top', style: 'indian', prefix: 'K', f: 3 },
  { id: 'shirt', label: 'Shirt', group: 'top', style: 'western', prefix: 'S', f: 3 },
  { id: 'top', label: 'Top / blouse', group: 'top', style: 'western', prefix: 'S', f: 2 },
  { id: 'tshirt', label: 'T-shirt', group: 'top', style: 'western', prefix: 'T', f: 1 },
  { id: 'trousers', label: 'Trousers / pants', group: 'bottom', style: 'both', prefix: 'P', f: 3 },
  { id: 'jeans', label: 'Jeans', group: 'bottom', style: 'western', prefix: 'J', f: 1 },
  { id: 'palazzo', label: 'Palazzo / salwar', group: 'bottom', style: 'indian', prefix: 'P', f: 2 },
  { id: 'churidar', label: 'Churidar / leggings', group: 'bottom', style: 'indian', prefix: 'P', f: 2 },
  { id: 'pyjama', label: 'Pyjama / dhoti', group: 'bottom', style: 'indian', prefix: 'P', f: 2 },
  { id: 'skirt', label: 'Skirt', group: 'bottom', style: 'both', prefix: 'SK', f: 2 },
  { id: 'shorts', label: 'Shorts', group: 'bottom', style: 'western', prefix: 'SH', f: 1 },
  { id: 'dress', label: 'Dress', group: 'one', style: 'western', prefix: 'D', f: 3 },
  { id: 'saree', label: 'Saree', group: 'one', style: 'indian', prefix: 'SR', f: 4 },
  { id: 'lehenga', label: 'Lehenga set', group: 'one', style: 'indian', prefix: 'L', f: 5 },
  { id: 'kurtaset', label: 'Kurta set', group: 'one', style: 'indian', prefix: 'KS', f: 3 },
  { id: 'sherwani', label: 'Sherwani', group: 'one', style: 'indian', prefix: 'SW', f: 5 },
  { id: 'suit', label: 'Suit', group: 'one', style: 'western', prefix: 'SU', f: 5 },
  { id: 'jacket', label: 'Jacket / blazer', group: 'layer', style: 'western', prefix: 'JK', f: 4 },
  { id: 'nehru', label: 'Nehru jacket', group: 'layer', style: 'indian', prefix: 'JK', f: 4 },
  { id: 'dupatta', label: 'Dupatta / shawl', group: 'layer', style: 'indian', prefix: 'DP', f: 3 },
  { id: 'sweater', label: 'Sweater / cardigan', group: 'layer', style: 'western', prefix: 'SW', f: 2 },
  { id: 'footwear', label: 'Footwear', group: 'footwear', style: 'both', prefix: 'F', f: 3 },
  { id: 'earrings', label: 'Earrings', group: 'accessory', style: 'both', prefix: 'A', f: 3 },
  { id: 'necklace', label: 'Necklace', group: 'accessory', style: 'both', prefix: 'A', f: 3 },
  { id: 'bangles', label: 'Bangles / bracelet', group: 'accessory', style: 'both', prefix: 'A', f: 3 },
  { id: 'watch', label: 'Watch', group: 'accessory', style: 'both', prefix: 'A', f: 3 },
  { id: 'sunglasses', label: 'Sunglasses', group: 'accessory', style: 'both', prefix: 'A', f: 2 },
  { id: 'bag', label: 'Bag', group: 'accessory', style: 'both', prefix: 'A', f: 3 },
  { id: 'belt', label: 'Belt', group: 'accessory', style: 'western', prefix: 'A', f: 3 },
  { id: 'other', label: 'Other', group: 'accessory', style: 'both', prefix: 'X', f: 3 }
];
const CAT = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

const GROUP_LABEL = { top: 'Tops', bottom: 'Bottoms', one: 'Full outfits', layer: 'Layers', footwear: 'Footwear', accessory: 'Accessories' };

// Guess a category from free text ("navy chinos" -> trousers).
const GUESS = [
  [/kurt[ai]s? set|kurta pyjama|salwar suit|anarkali/, 'kurtaset'], [/kurt/, 'kurta'], [/sherwani/, 'sherwani'],
  [/saree|sari\b/, 'saree'], [/lehenga|ghagra|chaniya/, 'lehenga'], [/dupatta|stole|shawl/, 'dupatta'],
  [/nehru|bandhgala|waistcoat/, 'nehru'], [/blazer|jacket|coat/, 'jacket'], [/sweater|cardigan|hoodie|pullover/, 'sweater'],
  [/t-?shirt|tee\b|polo/, 'tshirt'], [/shirt/, 'shirt'], [/blouse|top\b|tunic|crop/, 'top'],
  [/jean|denim/, 'jeans'], [/palazzo|salwar|patiala|sharara/, 'palazzo'], [/churidar|legging/, 'churidar'],
  [/pyjama|pajama|dhoti/, 'pyjama'], [/skirt/, 'skirt'], [/short/, 'shorts'],
  [/chino|trouser|pant|slack|cargo|culotte/, 'trousers'], [/dress|gown|jumpsuit/, 'dress'], [/suit/, 'suit'],
  [/shoe|sneaker|loafer|heel|sandal|jutti|mojari|kolhapuri|chappal|boot|flat|slipper|oxford|brogue|wedge/, 'footwear'],
  [/earring|jhumk|stud/, 'earrings'], [/necklace|chain|pendant|choker/, 'necklace'], [/bangle|bracelet|kada/, 'bangles'],
  [/watch/, 'watch'], [/sunglass|goggle|shades/, 'sunglasses'], [/bag|clutch|purse|tote|potli/, 'bag'], [/belt/, 'belt']
];
function guessCategory(text = '') {
  const t = String(text).toLowerCase();
  for (const [re, id] of GUESS) if (re.test(t)) return id;
  return 'other';
}

const OCCASIONS = [
  { id: 'wedding', label: 'Wedding', f: [4, 5], subs: ['Haldi', 'Mehendi', 'Sangeet', 'Pheras / ceremony', 'Reception', 'Cocktail'] },
  { id: 'festive', label: 'Festival / puja', f: [3, 5], subs: ['Diwali', 'Holi', 'Navratri / garba', 'Eid', 'Puja at home', 'Temple visit'] },
  { id: 'work', label: 'Office / work', f: [3, 4], subs: ['Everyday office', 'Important meeting', 'Presentation', 'Office Diwali party'] },
  { id: 'interview', label: 'Interview', f: [4, 5], subs: [] },
  { id: 'party', label: 'Party / night out', f: [3, 4], subs: ['Casual', 'Dressy', 'Club / lounge'] },
  { id: 'date', label: 'Date / dinner', f: [2, 4], subs: ['Casual', 'Smart casual', 'Fine dining'] },
  { id: 'travel', label: 'Travel', f: [1, 3], subs: ['Airport / transit', 'Sightseeing', 'Business travel', 'Beach / resort'] },
  { id: 'casual', label: 'Casual outing', f: [1, 3], subs: ['Day out', 'Brunch', 'Shopping', 'Family visit'] },
  { id: 'formal', label: 'Formal event', f: [4, 5], subs: ['Black tie', 'Awards', 'Graduation'] },
  { id: 'other', label: 'Other', f: [1, 5], subs: [] }
];
const OCC = Object.fromEntries(OCCASIONS.map(o => [o.id, o]));

// Day types for Today / Mix & Match context
const DAY_TYPES = [
  { id: 'work', label: 'Work', f: [3, 4] },
  { id: 'casual', label: 'Casual', f: [1, 3] },
  { id: 'outing', label: 'Outing', f: [2, 3] },
  { id: 'festive', label: 'Festive / puja', f: [3, 5] },
  { id: 'evening', label: 'Evening out', f: [3, 4] },
  { id: 'travel', label: 'Travel', f: [1, 3] }
];
const DAY = Object.fromEntries(DAY_TYPES.map(d => [d.id, d]));

const TEMPS = ['Hot', 'Warm', 'Mild', 'Cool', 'Cold'];
const EXTRAS = ['Humid', 'Rainy', 'Windy'];

const STATUSES = ['Available', 'Laundry', 'Alteration', 'Packed', 'Archived'];

const PATTERNS = ['Solid', 'Printed', 'Floral', 'Striped', 'Checked', 'Embroidered', 'Self-design'];
const FABRICS = ['Cotton', 'Linen', 'Silk', 'Chiffon / georgette', 'Rayon / viscose', 'Polyester', 'Denim', 'Wool', 'Velvet', 'Leather', 'Metal', 'Other'];
const HEAVY_FABRICS = ['Wool', 'Velvet', 'Leather'];
const LIGHT_FABRICS = ['Cotton', 'Linen', 'Chiffon / georgette', 'Rayon / viscose'];

// ---------- Colour names (incl. common Indian names) ----------
const PALETTE = [
  ['White', '#FFFFFF'], ['Off-white', '#F4F1E8'], ['Ivory', '#FFFBEA'], ['Cream', '#F3E5C8'], ['Beige', '#D9C7A7'],
  ['Light brown', '#B98D62'], ['Tan', '#C58B4E'], ['Brown', '#7A4A2A'], ['Khaki', '#B5A36C'], ['Rust', '#B7410E'],
  ['Black', '#141414'], ['Charcoal', '#3B3D42'], ['Grey', '#8C8F96'], ['Light grey', '#C9CACE'], ['Silver', '#BFC1C6'],
  ['Navy', '#1F2A44'], ['Royal blue', '#2E5AAC'], ['Blue', '#2F5DA8'], ['Sky blue', '#8EC5EA'], ['Denim', '#3A5578'], ['Powder blue', '#B7CCE6'],
  ['Teal', '#127C7C'], ['Turquoise', '#30C5C0'], ['Mint', '#A8E6CF'], ['Sea green', '#2E8B57'], ['Bottle green', '#006A4E'],
  ['Emerald', '#1F9D6B'], ['Green', '#3C8D3C'], ['Parrot green', '#5CB300'], ['Olive', '#6B7A3A'],
  ['Mustard', '#E1AD01'], ['Yellow', '#F2D04B'], ['Lemon', '#F7EA6B'], ['Gold', '#C9A227'], ['Saffron', '#F4A300'],
  ['Orange', '#D9772B'], ['Peach', '#F6B89B'], ['Coral', '#F07B67'],
  ['Red', '#C0292B'], ['Maroon', '#7A1F24'], ['Wine', '#6B2737'],
  ['Pink', '#E88AAE'], ['Baby pink', '#F6C9D5'], ['Rani pink', '#D6246E'], ['Magenta', '#C2187A'],
  ['Lavender', '#B9A7DA'], ['Mauve', '#A77B9B'], ['Purple', '#6A3D9A']
];

function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '').trim();
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) { case r: h = (g - b) / d + (g < b ? 6 : 0); break; case g: h = (b - r) / d + 2; break; default: h = (r - g) / d + 4; }
    h *= 60;
  }
  return [h, s, l];
}
function srgbToLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function rgbToLab([r, g, b]) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + 16 / 116;
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const PALETTE_LAB = PALETTE.map(([n, h]) => [n, h, rgbToLab(hexToRgb(h))]);
function nameColour(hex) {
  const rgb = hexToRgb(hex); if (!rgb) return 'Unknown';
  const lab = rgbToLab(rgb);
  let best = PALETTE_LAB[0], bd = Infinity;
  for (const p of PALETTE_LAB) {
    const d = (p[2][0] - lab[0]) ** 2 + (p[2][1] - lab[1]) ** 2 + (p[2][2] - lab[2]) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best[0];
}
function hexForName(name) {
  const p = PALETTE.find(([n]) => n.toLowerCase() === String(name || '').toLowerCase());
  return p ? p[1] : null;
}

const NEUTRAL_NAMES = new Set(['White', 'Off-white', 'Ivory', 'Cream', 'Beige', 'Light brown', 'Tan', 'Khaki', 'Black', 'Charcoal', 'Grey', 'Light grey', 'Silver', 'Navy', 'Denim', 'Brown']);
function colourInfo(hex) {
  const rgb = hexToRgb(hex) || [128, 128, 128];
  const [h, s, l] = rgbToHsl(rgb);
  const name = nameColour(hex);
  const neutral = NEUTRAL_NAMES.has(name) || s < 0.15 || l > 0.93 || l < 0.1;
  const loud = !neutral && s > 0.55 && l > 0.28 && l < 0.72;
  return { hex, name, h, s, l, neutral, loud };
}

function hueDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

// Relationship between two colours: neutral | tonal | analogous | complementary | contrast | clash
function relation(a, b) {
  if (a.neutral || b.neutral) return 'neutral';
  const d = hueDiff(a.h, b.h);
  if (d <= 15) return 'tonal';
  if (d <= 50) return 'analogous';
  if (d >= 150) return 'complementary';
  if (d >= 110) return 'contrast';
  return 'clash';
}

// Score a pair 0..1 by style. style: 'indian' | 'western' | 'fusion'; festive boosts bright combos.
function pairScore(a, b, { style = 'fusion', festive = false, pref = null } = {}) {
  const rel = relation(a, b);
  const base = {
    western: { neutral: 0.9, tonal: 0.8, analogous: 0.75, complementary: 0.55, contrast: 0.45, clash: 0.15 },
    indian: { neutral: 0.85, tonal: 0.75, analogous: 0.85, complementary: 0.75, contrast: 0.55, clash: 0.25 },
    fusion: { neutral: 0.88, tonal: 0.78, analogous: 0.8, complementary: 0.65, contrast: 0.5, clash: 0.2 }
  }[style] || {};
  let s = base[rel] ?? 0.5;
  if (festive && (rel === 'analogous' || rel === 'complementary') && a.loud && b.loud) s += style === 'indian' ? 0.12 : 0.05;
  if (!festive && a.loud && b.loud) s -= style === 'western' ? 0.2 : 0.08;
  if (pref === 'pop' && (rel === 'complementary' || rel === 'contrast')) s += 0.2;
  if (pref === 'pop' && rel === 'neutral') s -= 0.05;
  if (pref === 'tonal' && (rel === 'tonal' || rel === 'analogous')) s += 0.2;
  if (pref === 'tonal' && (rel === 'complementary' || rel === 'contrast')) s -= 0.15;
  return Math.max(0, Math.min(1, s));
}

const RELATION_WHY = {
  neutral: 'a neutral base keeps the stronger colour clean',
  tonal: 'shades of one colour look calm and put-together',
  analogous: 'neighbouring colours look rich together',
  complementary: 'opposite colours make each other pop',
  contrast: 'a bold contrast that stands out',
  clash: 'a daring mix'
};
Object.defineProperty(exports,'CATEGORIES',{enumerable:true,get:()=>CATEGORIES});
Object.defineProperty(exports,'CAT',{enumerable:true,get:()=>CAT});
Object.defineProperty(exports,'GROUP_LABEL',{enumerable:true,get:()=>GROUP_LABEL});
Object.defineProperty(exports,'guessCategory',{enumerable:true,get:()=>guessCategory});
Object.defineProperty(exports,'OCCASIONS',{enumerable:true,get:()=>OCCASIONS});
Object.defineProperty(exports,'OCC',{enumerable:true,get:()=>OCC});
Object.defineProperty(exports,'DAY_TYPES',{enumerable:true,get:()=>DAY_TYPES});
Object.defineProperty(exports,'DAY',{enumerable:true,get:()=>DAY});
Object.defineProperty(exports,'TEMPS',{enumerable:true,get:()=>TEMPS});
Object.defineProperty(exports,'EXTRAS',{enumerable:true,get:()=>EXTRAS});
Object.defineProperty(exports,'STATUSES',{enumerable:true,get:()=>STATUSES});
Object.defineProperty(exports,'PATTERNS',{enumerable:true,get:()=>PATTERNS});
Object.defineProperty(exports,'FABRICS',{enumerable:true,get:()=>FABRICS});
Object.defineProperty(exports,'HEAVY_FABRICS',{enumerable:true,get:()=>HEAVY_FABRICS});
Object.defineProperty(exports,'LIGHT_FABRICS',{enumerable:true,get:()=>LIGHT_FABRICS});
Object.defineProperty(exports,'PALETTE',{enumerable:true,get:()=>PALETTE});
Object.defineProperty(exports,'hexToRgb',{enumerable:true,get:()=>hexToRgb});
Object.defineProperty(exports,'rgbToHex',{enumerable:true,get:()=>rgbToHex});
Object.defineProperty(exports,'rgbToHsl',{enumerable:true,get:()=>rgbToHsl});
Object.defineProperty(exports,'rgbToLab',{enumerable:true,get:()=>rgbToLab});
Object.defineProperty(exports,'nameColour',{enumerable:true,get:()=>nameColour});
Object.defineProperty(exports,'hexForName',{enumerable:true,get:()=>hexForName});
Object.defineProperty(exports,'colourInfo',{enumerable:true,get:()=>colourInfo});
Object.defineProperty(exports,'hueDiff',{enumerable:true,get:()=>hueDiff});
Object.defineProperty(exports,'relation',{enumerable:true,get:()=>relation});
Object.defineProperty(exports,'pairScore',{enumerable:true,get:()=>pairScore});
Object.defineProperty(exports,'RELATION_WHY',{enumerable:true,get:()=>RELATION_WHY});
};
__mods['js/dna.js'] = function(require,exports,module){
// Style DNA: a few plain statements learned from the user's own ratings and choices. Pure (Node-testable).
// Every signal must appear at least twice before it becomes a statement. Nothing generic is ever made up:
// with too little to go on, the list is empty and the screen says so.
const { CAT } = require('js/catalog.js');

const MAX_STATEMENTS = 6;
const MIN_SIGNAL = 2;
const REASON_TEXT = {
  'Uncomfortable': 'Prioritise comfort even when the outfit is more formal.',
  'Too formal': 'Prefer a more relaxed level of formality when the occasion allows.',
  'Too casual': 'Prefer a more polished finish rather than very casual styling.',
  'Colours': 'Be conservative with colour combinations unless I ask for a colour-forward look.',
  "Pieces don't go together": 'Prefer cohesive combinations with a clear relationship between the main pieces.'
};
const MAIN_GROUPS = ['top', 'bottom', 'one'];

function counts(list) { const m = new Map(); for (const x of list) if (x) m.set(x, (m.get(x) || 0) + 1); return m; }
function top(m, n = 2) { return [...m].filter(([, c]) => c >= MIN_SIGNAL).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n).map(([k]) => k); }
function joinAnd(a) { return a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : a[0] || ''; }

// Learned statements from the current data. Returns [{ text, source: 'learned' }].
function deriveDNA(st = {}) {
  const wardrobe = st.wardrobe || [], worn = st.worn || [], looks = st.looks || [], sessions = st.sessions || [];
  const byId = id => wardrobe.find(w => w.id === id);
  const out = [];

  // 1. Repeated reasons for "Not for me".
  const reasons = worn.filter(x => x.rating === 'Not for me').flatMap(x => String(x.reason || '').split(',').map(v => v.trim()).filter(Boolean));
  const rc = counts(reasons);
  for (const [r, text] of Object.entries(REASON_TEXT)) if ((rc.get(r) || 0) >= MIN_SIGNAL) out.push(text);

  // Pieces from outfits rated "Love it", and from saved looks rated "Love it" (pieces the user owns).
  const lovedSets = [
    ...worn.filter(x => x.rating === 'Love it').map(x => (x.itemIds || []).map(byId).filter(Boolean)),
    ...looks.filter(l => l.rating === 'Love it').map(l => (l.pieces || []).map(p => p.wardrobeId && byId(p.wardrobeId)).filter(Boolean))
  ].filter(a => a.length);
  const loved = lovedSets.flat();

  // 2. Colours that keep appearing in loved outfits.
  const colours = top(counts(loved.filter(w => w.colour?.name && !w.colour?.unknown).map(w => w.colour.name)));
  if (colours.length) out.push(`Outfits I love often include ${joinAnd(colours)}.`);

  // 3. The main piece loved outfits are built around.
  const mains = top(counts(loved.filter(w => MAIN_GROUPS.includes((CAT[w.category] || CAT.other).group) && w.category !== 'other').map(w => (CAT[w.category] || CAT.other).label.split(' /')[0].toLowerCase())), 2);
  if (mains.length) out.push(`My favourite outfits are often built around a ${joinAnd(mains)}.`);

  // 4. Patterns that keep appearing in loved outfits.
  const pats = top(counts(loved.map(w => w.pattern).filter(Boolean)), 2);
  if (pats.length) out.push(`I often enjoy ${joinAnd(pats.map(p => p.toLowerCase()))} pieces.`);

  // 5. How dressy loved outfits are (needs at least two loved outfits).
  const lovedForm = lovedSets.map(a => { const f = a.filter(w => MAIN_GROUPS.includes((CAT[w.category] || CAT.other).group)).map(w => Number.isFinite(w.formality) ? w.formality : (CAT[w.category] || CAT.other).f); return f.length ? f.reduce((x, y) => x + y, 0) / f.length : null; }).filter(v => v != null);
  if (lovedForm.length >= MIN_SIGNAL) {
    const avg = lovedForm.reduce((x, y) => x + y, 0) / lovedForm.length;
    if (avg <= 2.2) out.push("I'm happiest in relaxed, easy pieces when the occasion allows.");
    else if (avg >= 3.8) out.push('I like a polished, dressier finish.');
  }

  // 6. The style direction chosen again and again for occasions.
  const dirs = top(counts(sessions.map(x => x.occasion?.style).filter(v => v && v !== 'Surprise me')), 1);
  if (dirs.length) out.push(`For occasions I usually choose ${dirs[0]} styling.`);

  return [...new Set(out)].map(text => ({ text, source: 'learned' }));
}

// Rebuild: the user's own statements (typed or edited by them) are always kept; learned ones are replaced.
function mergeDNA(existing = [], learned = [], stamp = Date.now()) {
  const mine = (existing || []).filter(x => x && x.source === 'user' && String(x.text || '').trim());
  const seen = new Set(mine.map(x => x.text.trim().toLowerCase()));
  const room = Math.max(0, MAX_STATEMENTS - mine.length);
  const fresh = learned.filter(x => !seen.has(x.text.trim().toLowerCase())).slice(0, room);
  return [...mine, ...fresh.map((x, i) => ({ id: `dna-${stamp}-${i}`, text: x.text, source: 'learned' }))];
}
Object.defineProperty(exports,'MAX_STATEMENTS',{enumerable:true,get:()=>MAX_STATEMENTS});
Object.defineProperty(exports,'deriveDNA',{enumerable:true,get:()=>deriveDNA});
Object.defineProperty(exports,'mergeDNA',{enumerable:true,get:()=>mergeDNA});
};
__mods['js/engine.js'] = function(require,exports,module){
// Mix & Match engine. Runs on the phone, offline, no AI. Pure functions (Node-testable).
const { CAT, colourInfo, pairScore, relation, RELATION_WHY, HEAVY_FABRICS, LIGHT_FABRICS, OCC, DAY } = require('js/catalog.js');
const { daysBetween } = require('js/util.js');

const LAUNDRY_REVIEW_DAYS = 3;

function groupOf(item) { return (CAT[item.category] || CAT.other).group; }
function styleOf(item) { return (CAT[item.category] || CAT.other).style; }
function formalityOf(item) { return Number.isFinite(item.formality) ? item.formality : (CAT[item.category] || CAT.other).f; }

// Availability is explicit. Laundry never silently becomes wearable; after a few days the UI can suggest reviewing it.
function effectiveStatus(item) {
  return item.status || 'Available';
}

function laundryReviewDue(item, today) {
  return item?.status === 'Laundry' && !!item.statusSince && !!today && daysBetween(item.statusSince, today) >= LAUNDRY_REVIEW_DAYS;
}

function info(item) {
  if (!item._ci) Object.defineProperty(item, '_ci', { value: colourInfo(item.colour?.hex || '#8C8F96'), enumerable: false, writable: true });
  return item._ci;
}
function info2(item) {
  if (!item.secondColour?.hex) return null;
  if (!item._ci2 || item._ci2.hex !== item.secondColour.hex) Object.defineProperty(item, '_ci2', { value: { hex: item.secondColour.hex, ci: colourInfo(item.secondColour.hex) }, enumerable: false, writable: true, configurable: true });
  return item._ci2.ci;
}

// ---------- the user's own tags (seasons, occasions, second colour) ----------
// Untagged pieces are scored exactly as before; tags only add information.
const TEMP_ORDER = ['Cold', 'Cool', 'Mild', 'Warm', 'Hot'];
// How far today's temperature is from the nearest season the piece is tagged for (null = no temperature tag).
function seasonDistance(item, temp) {
  const tags = (item.seasons || []).filter(t => TEMP_ORDER.includes(t));
  if (!temp || !tags.length || (item.seasons || []).includes('All-weather')) return null;
  const at = TEMP_ORDER.indexOf(temp); if (at < 0) return null;
  return Math.min(...tags.map(t => Math.abs(TEMP_ORDER.indexOf(t) - at)));
}
// A piece tagged only for the opposite weather (e.g. Hot-only on a Cold day) sinks below everything that suits the
// weather, so it is used only when nothing else can make an outfit (a sparse wardrobe is never left with nothing).
// Accessories are never penalised for weather.
const OFF_SEASON = -1.2;
function offSeason(item, c) {
  const d = seasonDistance(item, c.temp);
  return d != null && d >= 3 && groupOf(item) !== 'accessory';
}
function seasonScore(item, c) {
  let s = 0;
  const d = seasonDistance(item, c.temp);
  if (offSeason(item, c)) return OFF_SEASON;
  if (d === 0) s += 0.05; else if (d === 2) s -= 0.1;
  if ((c.extras || []).includes('Rainy') && (item.seasons || []).includes('Rainy')) s += 0.04;
  return s;
}
// Occasion tags the user (or AI labelling) gave a piece, matched to the kind of day or occasion being planned.
const OCCASION_TAGS = {
  wedding: ['Wedding', 'Festive'], festive: ['Festive', 'Religious'], work: ['Work'], interview: ['Work', 'Formal'], party: ['Party'],
  date: ['Party', 'Everyday'], travel: ['Travel'], casual: ['Everyday'], formal: ['Formal'], outing: ['Everyday'], evening: ['Party']
};
function occasionTags(c) { return OCCASION_TAGS[c.occasionId] || OCCASION_TAGS[c.dayType] || []; }
function occasionScore(item, c, weight = 0.08) {
  const want = occasionTags(c); const have = item.occasions || [];
  return want.length && have.some(o => want.includes(o)) ? weight : 0;
}
// The pair score, lowered when a piece's second colour clashes with the other piece.
function pairWithSecond(t, b, opts) {
  const main = pairScore(info(t), info(b), opts);
  let worst = main;
  const t2 = info2(t), b2 = info2(b);
  if (t2) worst = Math.min(worst, pairScore(t2, info(b), opts));
  if (b2) worst = Math.min(worst, pairScore(info(t), b2, opts));
  return main - 0.4 * (main - worst);
}
function metalOf(item) {
  const n = (item.colour?.name || '').toLowerCase();
  if (/gold|yellow|mustard/.test(n)) return 'gold';
  if (/silver|grey|white/.test(n)) return 'silver';
  return null;
}

// Build the context range and labels from day type / occasion.
function resolveContext(ctx = {}) {
  const c = { style: 'fusion', festive: false, temp: null, extras: [], avoidColours: [], chips: {}, count: 3, ...ctx };
  const occ = c.occasionId ? OCC[c.occasionId] : null;
  const day = c.dayType ? DAY[c.dayType] : null;
  c.range = c.range || (occ ? occ.f : day ? day.f : [1, 5]);
  c.festive = c.festive || ['wedding', 'festive'].includes(c.occasionId) || c.dayType === 'festive';
  c.label = c.label || (occ ? occ.label : day ? day.label : 'Any day');
  return c;
}

function weatherOk(item, c) {
  const fab = item.fabric;
  if (!fab) return true;
  if ((c.temp === 'Hot' || c.temp === 'Warm') && HEAVY_FABRICS.includes(fab) && groupOf(item) !== 'accessory') return false;
  return true;
}
function weatherScore(item, c) {
  const fab = item.fabric; let s = 0;
  if (!fab) return 0;
  if ((c.temp === 'Hot' || c.temp === 'Warm' || c.extras.includes('Humid')) && LIGHT_FABRICS.includes(fab)) s += 0.08;
  if ((c.temp === 'Cold' || c.temp === 'Cool') && (HEAVY_FABRICS.includes(fab) || fab === 'Silk')) s += 0.06;
  if ((c.temp === 'Cold') && fab === 'Linen') s -= 0.1;
  if (c.extras.includes('Rainy') && (fab === 'Velvet' || fab === 'Silk' || fab === 'Leather')) s -= 0.08;
  return s;
}

function formalityFit(item, c) {
  const f = formalityOf(item); const [lo, hi] = c.range;
  if (f >= lo && f <= hi) return 0.1;
  const d = f < lo ? lo - f : f - hi;
  return d === 1 ? -0.08 : -1; // more than 1 step outside: effectively excluded
}

function styleFit(top, bottom, c) {
  const st = c.style;
  const a = styleOf(top), b = styleOf(bottom);
  const mixed = (a === 'indian' && b === 'western') || (a === 'western' && b === 'indian');
  if (st === 'indian') return (a === 'western' || b === 'western') ? -0.25 : 0.05;
  if (st === 'western') return (a === 'indian' || b === 'indian') ? -0.25 : 0.05;
  return mixed ? 0.02 : 0; // fusion: mixing is fine
}

function rarelyBonus(item, today) {
  const n = item.timesWorn || 0;
  const days = item.lastWorn && today ? daysBetween(item.lastWorn, today) : 120;
  return Math.min(0.2, days / 600) + (n === 0 ? 0.05 : 0);
}

function wornRecently(item, worn, today, days = 3) {
  return worn.some(w => w.itemIds?.includes(item.id) && today && daysBetween(w.date, today) >= 0 && daysBetween(w.date, today) < days);
}

function baseKey(ids) { return [...ids].sort().join('+'); }

function ratingFor(ids, worn) {
  const key = baseKey(ids); let s = 0;
  for (const w of worn) {
    if (!w.rating || !w.itemIds) continue;
    if (ids.every(id => w.itemIds.includes(id)) || baseKey(w.baseIds || []) === key) {
      s += w.rating === 'Love it' ? 0.25 : w.rating === 'Fine' ? 0.03 : w.rating === 'Not for me' ? -0.5 : 0;
    }
  }
  return Math.max(-0.8, Math.min(0.4, s));
}

function repeatPenalty(ids, worn, audience) {
  if (!audience) return 0;
  return worn.some(w => w.audience === audience && w.mainId && ids.includes(w.mainId)) ? -0.35 : 0;
}

// Main entry: returns up to c.count outfits.
function suggest(items, worn = [], sets = [], ctx = {}, today = null) {
  const c = resolveContext(ctx);
  const chips = c.chips || {};
  const avoid = new Set((c.avoidColours || []).map(s => String(s).toLowerCase()));
  const notes = [];

  const usable = items.filter(it => effectiveStatus(it, today) === 'Available')
    .filter(it => !avoid.has((it.colour?.name || '').toLowerCase()))
    .filter(it => weatherOk(it, c));

  // Sets that cannot be split act as one complete outfit.
  const lockedIds = new Set();
  const setBases = [];
  for (const s of sets) {
    if (s.canSplit) continue;
    const parts = usable.filter(it => s.itemIds.includes(it.id));
    if (parts.length && parts.length === s.itemIds.length) {
      setBases.push({ kind: 'set', parts, main: parts.find(p => ['top', 'one'].includes(groupOf(p))) || parts[0] });
    }
    s.itemIds.forEach(id => lockedIds.add(id));
  }
  const free = usable.filter(it => !lockedIds.has(it.id));
  const by = g => free.filter(it => groupOf(it) === g);
  const tops = by('top'), bottoms = by('bottom'), ones = by('one'), layers = by('layer'), shoes = by('footwear'), accs = by('accessory');

  const recentIds = new Set(free.concat(setBases.flatMap(b => b.parts)).filter(it => wornRecently(it, worn, today)).map(it => it.id));

  const bases = [];
  for (const t of tops) for (const b of bottoms) bases.push({ kind: 'pair', parts: [t, b], main: t });
  for (const o of ones) bases.push({ kind: 'one', parts: [o], main: o });
  bases.push(...setBases);

  const around = chips.around ? items.find(i => i.id === chips.around) : null;
  const pref = chips.pop ? 'pop' : chips.tonal ? 'tonal' : chips.adventurous ? 'pop' : null;

  const scored = [];
  for (const base of bases) {
    const ids = base.parts.map(p => p.id);
    if (around && ['top', 'bottom', 'one'].includes(groupOf(around)) && !ids.includes(around.id)) continue;
    let s = 0;
    let rel = 'neutral';
    if (base.kind === 'pair') {
      const [t, b] = base.parts;
      s += pairWithSecond(t, b, { style: c.style, festive: c.festive, pref });
      rel = relation(info(t), info(b));
      s += styleFit(t, b, c);
    } else {
      s += 0.72 + (info(base.main).loud && c.festive ? 0.05 : 0);
      rel = info(base.main).neutral ? 'neutral' : 'tonal';
    }
    let bad = false;
    for (const p of base.parts) {
      const ff = formalityFit(p, c);
      if (ff <= -1) { bad = true; break; }
      s += (chips.occasionSafe ? 1.6 : 1) * ff;
      s += weatherScore(p, c) + seasonScore(p, c) + occasionScore(p, c);
      if (chips.favourites && p.favourite) s += 0.15;
      if (chips.rarely) s += rarelyBonus(p, today);
      if (chips.comfort && formalityOf(p) <= 2) s += 0.05;
      if (chips.comfort && HEAVY_FABRICS.includes(p.fabric)) s -= 0.1;
    }
    if (bad) continue;
    if (chips.adventurous && (rel === 'complementary' || rel === 'contrast')) s += 0.1;
    if (!chips.adventurous && base.parts.filter(p => info(p).loud).length > 1 && !c.festive) s -= 0.05;
    const recent = ids.some(id => recentIds.has(id));
    if (recent) s -= 0.6;
    s += ratingFor(ids, worn);
    s += repeatPenalty(ids, worn, c.audience);
    scored.push({ base, ids, score: s, rel, recent });
  }
  scored.sort((a, b) => b.score - a.score);

  // Pick diverse results: avoid repeating the same main piece.
  const picked = []; const usedMain = new Set();
  for (const sc of scored) {
    if (picked.length >= c.count) break;
    if (usedMain.has(sc.base.main.id) && scored.length > c.count * 2) continue;
    picked.push(sc); usedMain.add(sc.base.main.id);
  }
  for (const sc of scored) { if (picked.length >= c.count) break; if (!picked.includes(sc)) picked.push(sc); }

  const outfits = picked.map(sc => complete(sc, { layers, shoes, accs, c, chips, around, today }));
  if (!bases.length) notes.push(tops.length + ones.length === 0 ? 'Add at least one top or one full outfit.' : 'Add at least one bottom, or a full outfit like a dress or kurta set.');
  if (outfits[0]?.recent) notes.push('Some pieces were worn in the last 3 days — not enough other options.');
  if (outfits[0] && outfits[0].ids.some(id => { const it = items.find(x => x.id === id); return it && offSeason(it, c); })) notes.push(`Not enough pieces tagged for ${String(c.temp).toLowerCase()} weather, so some tagged for other weather are included.`);
  return { outfits, notes, optimisingFor: optimisingFor(c, chips) };
}

function pickBest(cands, baseInfos, c, pref, extraScore = () => 0) {
  let best = null, bs = -Infinity;
  for (const it of cands) {
    const ci = info(it);
    let s = baseInfos.reduce((acc, bi) => acc + pairScore(ci, bi, { style: c.style, festive: c.festive, pref }), 0) / Math.max(1, baseInfos.length);
    const ff = formalityFit(it, c); if (ff <= -1) continue;
    s += ff + weatherScore(it, c) + seasonScore(it, c) + occasionScore(it, c, 0.05) + extraScore(it);
    if (s > bs) { bs = s; best = it; }
  }
  return best;
}

function complete(sc, { layers, shoes, accs, c, chips, around, today }) {
  const pref = chips.pop ? 'pop' : chips.tonal ? 'tonal' : null;
  const parts = [...sc.base.parts];
  const baseInfos = parts.map(info);
  const missing = [];
  const needLayer = c.temp === 'Cold' || (c.temp === 'Cool' && !chips.minimal);
  const wantLayer = needLayer || (c.festive && styleOf(sc.base.main) === 'indian' && sc.base.kind === 'pair');
  if (wantLayer) {
    const cands = layers.filter(l => needLayer || styleOf(l) === 'indian');
    const l = (around && groupOf(around) === 'layer') ? around : pickBest(cands, baseInfos, c, pref);
    if (l) parts.push(l); else if (needLayer) missing.push('A warm layer (jacket, shawl or sweater)');
  } else if (around && groupOf(around) === 'layer') parts.push(around);

  const shoe = (around && groupOf(around) === 'footwear') ? around : pickBest(shoes, baseInfos, c, pref, it => (chips.favourites && it.favourite ? 0.1 : 0) - (c.extras.includes('Rainy') && /suede/i.test(it.name || '') ? 0.2 : 0));
  if (shoe) parts.push(shoe); else missing.push('Footwear');

  const maxAcc = chips.minimal ? 1 : 2;
  const chosenAcc = [];
  if (around && groupOf(around) === 'accessory') chosenAcc.push(around);
  const metal = chosenAcc.length ? metalOf(chosenAcc[0]) : null;
  const accPool = accs.filter(a => !chosenAcc.includes(a));
  while (chosenAcc.length < maxAcc) {
    const usedCats = new Set(chosenAcc.map(a => a.category));
    const m = chosenAcc.map(metalOf).find(Boolean) || metal;
    const pool = accPool.filter(a => !usedCats.has(a.category) && !chosenAcc.includes(a) && (!m || !metalOf(a) || metalOf(a) === m));
    if (!pool.length) break;
    const a = pickBest(pool, baseInfos, c, pref, it => (it.category === 'sunglasses' && (c.temp === 'Hot' || c.temp === 'Warm') ? 0.1 : 0) - (it.category === 'sunglasses' && (c.dayType === 'evening' || c.dayType === 'festive') ? 0.3 : 0));
    if (!a) break;
    chosenAcc.push(a);
  }
  parts.push(...chosenAcc);

  const main = sc.base.main;
  const why = buildWhy(sc, parts, c);
  const ownedCount = parts.length;
  return {
    ids: parts.map(p => p.id),
    baseIds: sc.ids,
    score: Math.round(sc.score * 100) / 100,
    relation: sc.rel,
    recent: sc.recent,
    title: titleFor(sc, parts),
    why,
    missing,
    coverage: `${ownedCount} of ${ownedCount + missing.length} pieces owned`,
    allOwned: missing.length === 0,
    mainId: main.id
  };
}

function titleFor(sc, parts) {
  const short = p => (CAT[p.category]?.label || 'piece').split(' /')[0].toLowerCase();
  const label = p => p.colour?.unknown || !p.colour?.name ? short(p) : p.colour.name;
  if (sc.base.kind !== 'pair') { const m = sc.base.main; return m.colour?.unknown ? (CAT[m.category]?.label.split(' /')[0] || 'Outfit') : `${m.colour.name} ${short(m)}`; }
  const [a, b] = sc.base.parts.map(label);
  if (a.toLowerCase() === b.toLowerCase() && !sc.base.parts.some(p => p.colour?.unknown)) return `All ${a.toLowerCase()}`;
  return `${a.charAt(0).toUpperCase() + a.slice(1)} + ${b.toLowerCase()}`;
}

function buildWhy(sc, parts, c) {
  const reason = RELATION_WHY[sc.rel] || 'a balanced combination';
  const bits = [reason.charAt(0).toUpperCase() + reason.slice(1)];
  if ((c.temp === 'Hot' || c.extras?.includes('Humid')) && parts.some(p => LIGHT_FABRICS.includes(p.fabric))) bits.push('light fabric for the heat');
  if (c.temp === 'Cold' && parts.some(p => groupOf(p) === 'layer')) bits.push('a layer for the cold');
  if (c.extras?.includes('Rainy')) bits.push('easy in the rain');
  return bits.join('; ') + '.';
}

function optimisingFor(c, chips = {}) {
  const out = [c.label];
  if (c.temp) out.push(c.temp.toLowerCase());
  (c.extras || []).forEach(e => out.push(e.toLowerCase()));
  if (chips.occasionSafe) out.push('occasion-safe');
  if (chips.pop) out.push('colour pop');
  if (chips.tonal) out.push('tonal');
  if (chips.rarely) out.push('rarely worn');
  if (chips.favourites) out.push('favourites');
  if (chips.comfort) out.push('comfort');
  if (chips.adventurous) out.push('adventurous');
  if (chips.minimal) out.push('minimal pieces');
  if (c.audience) out.push(`not repeated for ${c.audience.toLowerCase()}`);
  out.push('not worn recently');
  return out.join(' · ');
}

// Readiness for Today card: needs one top + one bottom, or one full outfit.
function wardrobeReady(items, today) {
  const av = items.filter(i => effectiveStatus(i, today) === 'Available');
  const g = av.map(groupOf);
  return g.includes('one') || (g.includes('top') && g.includes('bottom'));
}

// Plan several days without repeating a main piece (top, bottom or full outfit) where possible.
// days: [{key, date, dayType, temp, extras, label}]
function planDays(items, worn = [], sets = [], days = [], base = {}, today = null) {
  const usedBase = new Set();
  return days.map(d => {
    const r = suggest(items, worn, sets, { ...base, dayType: d.dayType, temp: d.temp || null, extras: d.extras || [], count: 15 }, today);
    let pick = r.outfits.find(o => !o.baseIds.some(id => usedBase.has(id)));
    let repeat = false;
    if (!pick && r.outfits.length) { pick = r.outfits[0]; repeat = true; }
    if (pick) pick.baseIds.forEach(id => usedBase.add(id));
    return { ...d, outfit: pick || null, repeat };
  });
}

// Travel capsule: the fewest clothes that give `nDays` different outfits.
function capsule(items, worn = [], sets = [], ctx = {}, nDays = 3, today = null) {
  const r = suggest(items, [], sets, { ...ctx, count: 60 }, today);
  const pool = r.outfits.slice();
  const chosen = []; const packed = new Set(); const keys = new Set();
  while (chosen.length < nDays && pool.length) {
    let bi = -1, best = Infinity;
    pool.forEach((o, i) => {
      if (keys.has([...o.baseIds].sort().join('+'))) return;
      const add = o.baseIds.filter(id => !packed.has(id)).length;
      const v = add * 10 - o.score;
      if (v < best) { best = v; bi = i; }
    });
    if (bi < 0) break;
    const o = pool.splice(bi, 1)[0];
    keys.add([...o.baseIds].sort().join('+'));
    chosen.push(o); o.ids.forEach(id => packed.add(id));
  }
  return { outfits: chosen, packIds: [...packed], short: Math.max(0, nDays - chosen.length), notes: r.notes };
}
Object.defineProperty(exports,'offSeason',{enumerable:true,get:()=>offSeason});
Object.defineProperty(exports,'seasonDistance',{enumerable:true,get:()=>seasonDistance});
Object.defineProperty(exports,'occasionTags',{enumerable:true,get:()=>occasionTags});
Object.defineProperty(exports,'LAUNDRY_REVIEW_DAYS',{enumerable:true,get:()=>LAUNDRY_REVIEW_DAYS});
Object.defineProperty(exports,'groupOf',{enumerable:true,get:()=>groupOf});
Object.defineProperty(exports,'styleOf',{enumerable:true,get:()=>styleOf});
Object.defineProperty(exports,'formalityOf',{enumerable:true,get:()=>formalityOf});
Object.defineProperty(exports,'effectiveStatus',{enumerable:true,get:()=>effectiveStatus});
Object.defineProperty(exports,'laundryReviewDue',{enumerable:true,get:()=>laundryReviewDue});
Object.defineProperty(exports,'resolveContext',{enumerable:true,get:()=>resolveContext});
Object.defineProperty(exports,'wornRecently',{enumerable:true,get:()=>wornRecently});
Object.defineProperty(exports,'suggest',{enumerable:true,get:()=>suggest});
Object.defineProperty(exports,'optimisingFor',{enumerable:true,get:()=>optimisingFor});
Object.defineProperty(exports,'wardrobeReady',{enumerable:true,get:()=>wardrobeReady});
Object.defineProperty(exports,'planDays',{enumerable:true,get:()=>planDays});
Object.defineProperty(exports,'capsule',{enumerable:true,get:()=>capsule});
};
__mods['js/handoff.js'] = function(require,exports,module){
// Handoff planner: decides how a request reaches the AI app and writes the steps the user sees, from the one route
// this browser will actually use. Every AI step uses it, so the steps can never promise something that won't happen.
// Pure (Node-testable).

// "your photo", "your photo and the wardrobe sheet", "a, b and c"
function joinLabels(labels = []) {
  const l = labels.filter(Boolean);
  if (l.length <= 1) return l[0] || '';
  return `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`;
}

// files: labels of the pictures this request needs, in the order the AI must receive them (your photo always first).
// canShare: whether this browser can share those files straight into another app.
// Returns { route: 'share' | 'copy', steps: [html strings], save: [indexes of files that need a Save button] }.
function planHandoff({ name = 'Gemini', files = [], canShare = false, sendLabel = '', intro = [], after = [] } = {}) {
  const labels = files.filter(Boolean);
  const route = labels.length && canShare ? 'share' : 'copy';
  const list = joinLabels(labels);
  const steps = [...intro];
  if (route === 'share') {
    steps.push(`Tap <b>${sendLabel || `Send to ${name}`}</b>, then choose <b>${name}</b>.`);
    steps.push(`Style You sends ${list} and copies the request too. If the text doesn't appear in ${name}, paste it.`);
  } else if (labels.length) {
    steps.push(labels.length > 1 ? `Save ${list} to your phone with the buttons below.` : `Save ${list} to your phone with the button below.`);
    steps.push(`Tap <b>Copy request &amp; open ${name}</b>. A new chat is fine.`);
    steps.push(labels.length > 1
      ? `In ${name}, attach ${labels[0]} first, then ${joinLabels(labels.slice(1))}. Paste the request and send.`
      : `In ${name}, attach ${labels[0]}, then paste the request and send.`);
  } else {
    steps.push(`Tap <b>Copy request &amp; open ${name}</b>. A new chat is fine.`);
    steps.push('Paste the request and send.');
  }
  steps.push(...after);
  return { route, steps, save: route === 'copy' ? labels.map((_, i) => i) : [] };
}
Object.defineProperty(exports,'joinLabels',{enumerable:true,get:()=>joinLabels});
Object.defineProperty(exports,'planHandoff',{enumerable:true,get:()=>planHandoff});
};
__mods['js/images.js'] = function(require,exports,module){
// Image handling on the phone: shrink, colour detection, duplicate fingerprints, contact sheets, share cards.
// Pure pixel functions (dominantFromPixels, dhashFromGray, hamming) are Node-testable.
const { rgbToHex, rgbToLab, nameColour } = require('js/catalog.js');

// ---------- pure helpers ----------
function dist2(a, b) { return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2; }

// pixels: Uint8ClampedArray RGBA of a w*h image. Returns {hex,name,confidence}.
// Background is estimated from the border; clusters close to it are down-weighted.
function dominantFromPixels(px, w, h) {
  const border = [], centre = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4; if (px[i + 3] < 128) continue;
    const c = [px[i], px[i + 1], px[i + 2]];
    const edge = x < w * 0.08 || x >= w * 0.92 || y < h * 0.08 || y >= h * 0.92;
    const inner = x >= w * 0.25 && x < w * 0.75 && y >= h * 0.2 && y < h * 0.8;
    if (edge) border.push(c); else if (inner) centre.push(c);
  }
  if (!centre.length) return { hex: '#8C8F96', name: 'Grey', confidence: 0 };
  const bg = border.length ? border.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0]).map(v => v / border.length) : null;
  const bgLab = bg ? rgbToLab(bg) : null;
  // k-means, k=4, deterministic seeds
  const labs = centre.map(c => rgbToLab(c));
  const k = Math.min(4, labs.length);
  let cents = Array.from({ length: k }, (_, j) => labs[Math.floor((j + 0.5) * labs.length / k)].slice());
  let assign = new Array(labs.length).fill(0);
  for (let it = 0; it < 8; it++) {
    for (let i = 0; i < labs.length; i++) { let b = 0, bd = Infinity; for (let j = 0; j < k; j++) { const d = dist2(labs[i], cents[j]); if (d < bd) { bd = d; b = j; } } assign[i] = b; }
    const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < labs.length; i++) { const s = sums[assign[i]]; s[0] += labs[i][0]; s[1] += labs[i][1]; s[2] += labs[i][2]; s[3]++; }
    cents = sums.map((s, j) => s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : cents[j]);
  }
  const counts = new Array(k).fill(0); const rgbSum = Array.from({ length: k }, () => [0, 0, 0]);
  for (let i = 0; i < labs.length; i++) { counts[assign[i]]++; const c = centre[i]; const s = rgbSum[assign[i]]; s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; }
  let best = 0, bs = -1;
  for (let j = 0; j < k; j++) {
    if (!counts[j]) continue;
    let weight = counts[j];
    if (bgLab && Math.sqrt(dist2(cents[j], bgLab)) < 12) weight *= 0.25; // looks like background
    if (weight > bs) { bs = weight; best = j; }
  }
  const rgb = rgbSum[best].map(v => v / counts[best]);
  const hex = rgbToHex(rgb);
  return { hex, name: nameColour(hex), confidence: Math.round(100 * counts[best] / labs.length) / 100 };
}

// gray: array of 9*8 luminance values (row-major, width 9). Returns 16-char hex.
function dhashFromGray(gray) {
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += gray[y * 9 + x] > gray[y * 9 + x + 1] ? '1' : '0';
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}
function hamming(a = '', b = '') {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { d += x & 1; x >>= 1; } }
  return d;
}
const DUPLICATE_DISTANCE = 6;

// ---------- browser helpers ----------
async function loadBitmap(blob) {
  if (globalThis.createImageBitmap) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { /* fall through */ }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob); const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This picture could not be opened. Try a JPEG or PNG.')); };
    img.src = url;
  });
}
function canvas(w, h) {
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c;
}
function toBlob(cv, type = 'image/jpeg', q = 0.82) {
  return new Promise((resolve, reject) => cv.toBlob(b => b ? resolve(b) : reject(new Error('Could not save the picture')), type, q));
}
// Shrink so the longest edge is <= max. Re-encoding drops embedded location data.
async function shrink(src, max = 800, q = 0.82) {
  const bmp = src instanceof Blob ? await loadBitmap(src) : src;
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
  const s = Math.min(1, max / Math.max(w, h));
  const cv = canvas(w * s, h * s); const ctx = cv.getContext('2d');
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
  const blob = await toBlob(cv, 'image/jpeg', q);
  return { blob, w: cv.width, h: cv.height, bmp };
}

function analyse(bmp) {
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
  const sw = 48, sh = Math.max(8, Math.round(48 * h / w));
  const cv = canvas(sw, sh); const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, sw, sh);
  const colour = dominantFromPixels(ctx.getImageData(0, 0, sw, sh).data, sw, sh);
  const g = canvas(9, 8); const gx = g.getContext('2d', { willReadFrequently: true });
  gx.drawImage(bmp, 0, 0, 9, 8);
  const d = gx.getImageData(0, 0, 9, 8).data; const gray = [];
  for (let i = 0; i < d.length; i += 4) gray.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  return { colour, fp: dhashFromGray(gray) };
}

// Pick the colour at a tapped point (x,y in 0..1) averaging a small patch.
async function colourAt(blob, fx, fy) {
  const bmp = await loadBitmap(blob);
  const w = bmp.width, h = bmp.height;
  const cv = canvas(w, h); const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const r = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  const x = Math.round(fx * w), y = Math.round(fy * h);
  const d = ctx.getImageData(Math.max(0, x - r), Math.max(0, y - r), r * 2, r * 2).data;
  let s = [0, 0, 0], n = 0;
  for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; n++; }
  const hex = rgbToHex(s.map(v => v / Math.max(1, n)));
  return { hex, name: nameColour(hex) };
}

function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function drawContain(ctx, img, x, y, w, h) {
  const iw = img.width, ih = img.height; const s = Math.min(w / iw, h / ih);
  ctx.drawImage(img, x + (w - iw * s) / 2, y + (h - ih * s) / 2, iw * s, ih * s);
}
function drawSwatch(ctx, x, y, w, h, hex) { ctx.fillStyle = hex || '#BBBBBB'; roundRect(ctx, x + w * 0.25, y + h * 0.15, w * 0.5, h * 0.7, 18); ctx.fill(); }

// entries: [{code, name, hex, blob|null}] -> JPEG blob, max 12 per sheet (3 x 4)
async function contactSheet(entries) {
  const cols = 3, rows = Math.ceil(entries.length / cols), cw = 520, ch = 560, pad = 20;
  const cv = canvas(cols * cw + pad * 2, rows * ch + pad * 2); const ctx = cv.getContext('2d');
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, cv.width, cv.height);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]; const x = pad + (i % cols) * cw, y = pad + Math.floor(i / cols) * ch;
    ctx.fillStyle = '#F2F2F4'; roundRect(ctx, x + 8, y + 8, cw - 16, ch - 16, 20); ctx.fill();
    if (e.blob) { try { const img = await loadBitmap(e.blob); drawContain(ctx, img, x + 24, y + 24, cw - 48, ch - 150); } catch { drawSwatch(ctx, x + 24, y + 24, cw - 48, ch - 150, e.hex); } }
    else drawSwatch(ctx, x + 24, y + 24, cw - 48, ch - 150, e.hex);
    ctx.fillStyle = '#111111'; ctx.font = 'bold 64px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(e.code, x + cw / 2, y + ch - 60);
  }
  return toBlob(cv, 'image/jpeg', 0.86);
}

// Share card for WhatsApp etc. looks: [{title, lines:[], pictureBlob, swatches:[hex]}]
async function shareCard({ heading, looks, footer = 'Made with Style You' }) {
  const W = 1080, n = looks.length, colW = n === 1 ? 940 : Math.floor((W - 80 - (n - 1) * 30) / n);
  const H = 1350; const cv = canvas(W, H); const ctx = cv.getContext('2d');
  ctx.fillStyle = '#FAFAFC'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#15151C'; ctx.font = 'bold 56px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(heading.slice(0, 32), 60, 110);
  for (let i = 0; i < n; i++) {
    const L = looks[i]; const x = 40 + i * (colW + 30), y = 160, ph = 760;
    ctx.fillStyle = '#ECECF2'; roundRect(ctx, x, y, colW, ph, 28); ctx.fill();
    if (L.pictureBlob) { try { const img = await loadBitmap(L.pictureBlob); ctx.save(); roundRect(ctx, x, y, colW, ph, 28); ctx.clip(); drawContain(ctx, img, x, y, colW, ph); ctx.restore(); } catch { /* keep swatches */ } }
    else { const sw = L.swatches || []; const bw = Math.min(140, (colW - 60) / Math.max(1, sw.length)); sw.forEach((hex, j) => { ctx.fillStyle = hex; roundRect(ctx, x + 30 + j * (bw + 10), y + 200, bw, 360, 20); ctx.fill(); }); }
    ctx.fillStyle = '#15151C'; ctx.font = 'bold 40px sans-serif';
    ctx.fillText((n > 1 ? `${i + 1}. ` : '') + (L.title || '').slice(0, n > 1 ? 14 : 30), x, y + ph + 60);
    ctx.font = '30px sans-serif'; ctx.fillStyle = '#4A4A57';
    (L.lines || []).slice(0, 6).forEach((t, j) => ctx.fillText(String(t).slice(0, n > 1 ? 18 : 40), x, y + ph + 110 + j * 42));
  }
  ctx.fillStyle = '#8A8A96'; ctx.font = '28px sans-serif'; ctx.fillText(footer, 60, H - 40);
  return toBlob(cv, 'image/jpeg', 0.88);
}
Object.defineProperty(exports,'dominantFromPixels',{enumerable:true,get:()=>dominantFromPixels});
Object.defineProperty(exports,'dhashFromGray',{enumerable:true,get:()=>dhashFromGray});
Object.defineProperty(exports,'hamming',{enumerable:true,get:()=>hamming});
Object.defineProperty(exports,'DUPLICATE_DISTANCE',{enumerable:true,get:()=>DUPLICATE_DISTANCE});
Object.defineProperty(exports,'loadBitmap',{enumerable:true,get:()=>loadBitmap});
Object.defineProperty(exports,'toBlob',{enumerable:true,get:()=>toBlob});
Object.defineProperty(exports,'shrink',{enumerable:true,get:()=>shrink});
Object.defineProperty(exports,'analyse',{enumerable:true,get:()=>analyse});
Object.defineProperty(exports,'colourAt',{enumerable:true,get:()=>colourAt});
Object.defineProperty(exports,'contactSheet',{enumerable:true,get:()=>contactSheet});
Object.defineProperty(exports,'shareCard',{enumerable:true,get:()=>shareCard});
};
__mods['js/main.js'] = function(require,exports,module){
// Entry point: load every screen, then start.
const { boot, ui } = require('js/app.js');
require('js/views/onboarding.js');
require('js/views/home.js');
require('js/views/create.js');
require('js/views/wardrobe.js');
require('js/views/mix.js');
require('js/views/looks.js');
require('js/views/session.js');
require('js/views/week.js');
require('js/views/ai.js');
require('js/views/settings.js');

window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); ui.installPrompt = e; });
boot().catch(e => {
  console.error(e);
  document.getElementById('view').innerHTML = '<div class="page"><h1>Style You could not start</h1><p>Please reload the page. If this keeps happening, your browser may be blocking storage.</p></div>';
});

};
__mods['js/parse.js'] = function(require,exports,module){
// Reading AI replies pasted back into the app, and checking product links. Pure (Node-testable).
const { normalise, parsePrice } = require('js/util.js');
const { guessCategory } = require('js/catalog.js');

const CODE_RE = /\b([A-Z]{1,2}\d{2,3})\b/;

function cleanText(t = '') {
  return String(t)
    .replace(/\r\n?/g, '\n')
    .replace(/[​-‍﻿]/g, '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/ /g, ' ');
}

// The occasion a reply belongs to: the STYLEYOU_SESSION line the AI was asked to repeat at the top of its reply.
// The first such line wins (a reply that also quotes the request repeats the same id). Returns '' when there is none.
function readSessionId(text = '') {
  const m = cleanText(text).match(/STYLEYOU[_ ]SESSION\s*:\s*([A-Za-z0-9][A-Za-z0-9_-]{2,80})/i);
  return m && m[1].toLowerCase() !== 'unassigned' ? m[1] : '';
}

// Generic STYLEYOU_<KIND>_<KEY>_BEGIN ... STYLEYOU_<KIND>_<KEY>_END blocks.
function blocks(text, kind) {
  const t = cleanText(text);
  const re = new RegExp(`STYLEYOU[_ ]${kind}[_ ]([A-Z0-9]+)[_ ]BEGIN([\\s\\S]*?)STYLEYOU[_ ]${kind}[_ ]\\1[_ ]END`, 'gi');
  const out = []; let m;
  while ((m = re.exec(t))) out.push({ key: m[1].toUpperCase(), body: m[2].trim() });
  return out;
}
function singleBlock(text, kind) {
  const t = cleanText(text);
  const re = new RegExp(`STYLEYOU[_ ]${kind}[_ ]BEGIN([\\s\\S]*?)STYLEYOU[_ ]${kind}[_ ]END`, 'i');
  const m = t.match(re);
  return m ? m[1].trim() : null;
}

function field(body, name) {
  const m = body.match(new RegExp(`^\\s*${name}\\s*[:\\-–]\\s*(.+)$`, 'im'));
  return m ? m[1].trim() : '';
}
function bulletLines(body) {
  return body.split('\n').map(l => l.trim()).filter(l => /^([-*•·]|\d+[.)])\s+/.test(l)).map(l => l.replace(/^([-*•·]|\d+[.)])\s+/, '').trim());
}

// Match a piece to the wardrobe: by code first, then by close name.
function matchWardrobe(text, code, wardrobe = []) {
  if (code) {
    const byCode = wardrobe.find(w => (w.code || '').toUpperCase() === code.toUpperCase());
    if (byCode) return { item: byCode, how: 'code' };
  }
  const n = normalise(text);
  if (!n) return null;
  const hit = wardrobe.find(w => normalise(w.name) && (n.includes(normalise(w.name)) || normalise(w.name).includes(n)));
  return hit ? { item: hit, how: 'name' } : null;
}

function parsePiece(line, wardrobe = []) {
  const parts = line.split('|').map(s => s.trim()).filter(Boolean);
  let category = '', name = '', status = '';
  if (parts.length >= 3) { [category, name, status] = parts; }
  else if (parts.length === 2) { [name, status] = parts; if (/^(top|bottom|footwear|layer|accessor|jewel|outer|full)/i.test(name)) { category = name; name = status; status = ''; } }
  else {
    const m = line.match(/^([^:]{2,24}):\s*(.+)$/);
    if (m) { category = m[1]; name = m[2]; } else name = line;
  }
  const flags = `${status} ${name}`;
  const code = (flags.match(CODE_RE) || [])[1] || '';
  const saysOwned = /\bowned\b|\bown\b|wardrobe|already have/i.test(flags);
  const saysMissing = /\bmissing\b|\bnew\b|\bbuy\b|not owned|to buy/i.test(flags);
  name = name.replace(/\(?\b(owned|missing|new|buy)\b[^)]*\)?/ig, '').replace(CODE_RE, '').replace(/[\s,;:–-]+$/, '').trim();
  let owned = false, wardrobeId = null, warning = '';
  if (saysOwned && !saysMissing) {
    const m = matchWardrobe(name, code, wardrobe);
    if (m) { owned = true; wardrobeId = m.item.id; }
    else warning = code ? `The AI named ${code}, which is not in your wardrobe; marked as missing.` : 'Marked missing: could not find it in your wardrobe.';
  }
  return { category: category || '', name: name || line, owned, wardrobeId, code: owned ? code : '', warning, guess: guessCategory(`${category} ${name}`) };
}

function parseLooks(text, wardrobe = []) {
  const found = blocks(text, 'LOOK').filter(b => /^[1-9]$/.test(b.key));
  const looks = found.map(b => {
    const name = field(b.body, 'Name') || `Look ${b.key}`;
    const why = field(b.body, 'Why') || field(b.body, 'Why it works');
    const pieces = bulletLines(b.body).map(l => parsePiece(l, wardrobe)).filter(p => p.name && p.name.length > 1);
    return { number: Number(b.key), name, why, pieces };
  }).filter(l => l.pieces.length);
  looks.sort((a, b) => a.number - b.number);
  const dedup = []; const seen = new Set();
  for (const l of looks) if (!seen.has(l.number)) { seen.add(l.number); dedup.push(l); }
  return dedup;
}

// Outfit blocks that reference wardrobe codes (daily improve, judge, week).
function parseCodeOutfits(text, wardrobe = [], kind = 'OUTFIT') {
  const codes = new Map(wardrobe.map(w => [String(w.code || '').toUpperCase(), w]));
  return blocks(text, kind).map(b => {
    const line = field(b.body, 'Codes') || field(b.body, 'Pieces') || b.body.split('\n')[0];
    const found = [...line.toUpperCase().matchAll(/\b([A-Z]{1,2}\d{2,3})\b/g)].map(m => m[1]);
    const ids = []; const unknown = [];
    for (const c of found) { const w = codes.get(c); if (w) { if (!ids.includes(w.id)) ids.push(w.id); } else unknown.push(c); }
    return { key: b.key, ids, unknown, why: field(b.body, 'Why'), missing: field(b.body, 'Missing') };
  }).filter(o => o.ids.length || o.missing);
}

function parseLabels(text, wardrobe = []) {
  const body = singleBlock(text, 'LABELS') ?? cleanText(text);
  const codes = new Map(wardrobe.map(w => [String(w.code || '').toUpperCase(), w]));
  const out = []; const unknown = [];
  for (const raw of body.split('\n')) {
    const line = raw.replace(/^([-*•·]|\d+[.)])\s+/, '').trim();
    const cells = line.split('|').map(s => s.trim());
    if (cells.length < 3) continue;
    const code = (cells[0].match(CODE_RE) || [])[1];
    if (!code) continue;
    const item = codes.get(code.toUpperCase());
    if (!item) { unknown.push(code); continue; }
    const [, category = '', colour = '', pattern = '', fabric = '', formality = '', occasions = ''] = cells;
    const f = parseInt(formality, 10);
    out.push({ id: item.id, code, category, colour, pattern, fabric, formality: Number.isFinite(f) ? Math.max(1, Math.min(5, f)) : null, occasions: occasions.split(/[,;/]/).map(s => s.trim()).filter(Boolean) });
  }
  return { labels: out, unknown };
}

function parseColours(text) {
  const body = singleBlock(text, 'COLOURS') ?? singleBlock(text, 'COLORS');
  if (!body) return null;
  const list = name => (field(body, name).split(/[,;]/).map(s => s.trim()).filter(Boolean)).slice(0, 12);
  const good = list('Good'), careful = list('Careful');
  return good.length || careful.length ? { good, careful } : null;
}

// ---------- Products ----------
const RETAILERS = [
  { name: 'Amazon', host: /(^|\.)amazon\.in$/i, product: /\/(dp|gp\/product|gp\/aw\/d)\/[A-Z0-9]{10}(\/|\?|$)/i },
  { name: 'Flipkart', host: /(^|\.)flipkart\.com$/i, product: /\/p\/itm[0-9a-z]{6,}/i },
  { name: 'Myntra', host: /(^|\.)myntra\.com$/i, product: /\/\d{6,}(\/buy)?\/?$/i },
  { name: 'AJIO', host: /(^|\.)ajio\.com$/i, product: /\/p\/[0-9a-z_]{6,}/i },
  { name: 'Tata CLiQ', host: /(^|\.)tatacliq\.com$/i, product: /\/p-mp\d{6,}/i },
  { name: 'Nykaa Fashion', host: /(^|\.)nykaafashion\.com$/i, product: /\/p\/\d{4,}/i },
  { name: 'Nykaa', host: /(^|\.)nykaa\.com$/i, product: /\/p\/\d{4,}/i },
  { name: 'Meesho', host: /(^|\.)meesho\.com$/i, product: /\/p\/[0-9a-z]{4,}/i }
];
const SEARCH_HINTS = /(\/s\?|\/s\/|\/search|[?&](q|k|query|keyword|rawQuery|text)=|\/sch\/|\/browse|\/c\/|\/category|\/collections?\/)/i;

function checkLink(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { return { ok: false, reason: 'Not a valid link' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'Not a secure (https) link' };
  if (u.username || u.password) return { ok: false, reason: 'Unsafe link' };
  const r = RETAILERS.find(x => x.host.test(u.hostname));
  if (!r) return { ok: false, reason: `Unknown shop (${u.hostname})` };
  const path = u.pathname + u.search;
  if (!r.product.test(u.pathname) || (SEARCH_HINTS.test(path) && !r.product.test(u.pathname))) return { ok: false, retailer: r.name, reason: 'Search, category or home page — not a product page' };
  return { ok: true, retailer: r.name, url: u.toString() };
}

function extractUrl(s = '') {
  const md = s.match(/\]\((https?:\/\/[^)\s]+)\)/);
  if (md) return md[1];
  const m = s.match(/https?:\/\/[^\s<>"')\]]+/);
  return m ? m[0].replace(/[.,;]+$/, '') : '';
}

function parseProducts(text) {
  const body = singleBlock(text, 'PRODUCTS');
  const src = body ?? cleanText(text);
  const lines = src.split('\n').map(l => l.trim()).filter(l => /piece\s*:/i.test(l) || (/\|/.test(l) && /https?:\/\//.test(l)));
  const items = lines.map(l => {
    const get = k => { const m = l.match(new RegExp(`${k}\\s*:\\s*([^|]+)`, 'i')); return m ? m[1].trim() : ''; };
    const piece = get('Piece') || l.split('|')[0].replace(/^([-*•·]|\d+[.)])\s+/, '').trim();
    const notFound = /not\s*found|no (verified|exact)/i.test(l);
    const url = notFound ? '' : extractUrl(l);
    const link = url ? checkLink(url) : { ok: false, reason: notFound ? 'No exact product found' : 'No link given' };
    const price = parsePrice(get('Price'));
    return {
      piece, brand: get('Brand'), product: get('Product'), retailer: link.retailer || get('Retailer'),
      priceText: get('Price'), price: Number.isFinite(price) ? price : null,
      url: link.ok ? link.url : '', found: !!link.ok, reason: link.ok ? '' : link.reason
    };
  });
  return { items, hadBlock: body !== null };
}
Object.defineProperty(exports,'readSessionId',{enumerable:true,get:()=>readSessionId});
Object.defineProperty(exports,'cleanText',{enumerable:true,get:()=>cleanText});
Object.defineProperty(exports,'blocks',{enumerable:true,get:()=>blocks});
Object.defineProperty(exports,'singleBlock',{enumerable:true,get:()=>singleBlock});
Object.defineProperty(exports,'matchWardrobe',{enumerable:true,get:()=>matchWardrobe});
Object.defineProperty(exports,'parsePiece',{enumerable:true,get:()=>parsePiece});
Object.defineProperty(exports,'parseLooks',{enumerable:true,get:()=>parseLooks});
Object.defineProperty(exports,'parseCodeOutfits',{enumerable:true,get:()=>parseCodeOutfits});
Object.defineProperty(exports,'parseLabels',{enumerable:true,get:()=>parseLabels});
Object.defineProperty(exports,'parseColours',{enumerable:true,get:()=>parseColours});
Object.defineProperty(exports,'RETAILERS',{enumerable:true,get:()=>RETAILERS});
Object.defineProperty(exports,'checkLink',{enumerable:true,get:()=>checkLink});
Object.defineProperty(exports,'parseProducts',{enumerable:true,get:()=>parseProducts});
};
__mods['js/parts.js'] = function(require,exports,module){
// Shared building blocks used by several screens.
const store = require('js/store.js');
const { state, mutate, itemById, today, aiName, save, recordHandoff } = require('js/app.js');
const { $, $$, html, raw, icon, toast, openSheet, copyText, readClipboardText, readClipboardImage, pickFiles, canShareFiles, download, isAndroid, isIOS, AI } = require('js/ui.js');
const { planHandoff } = require('js/handoff.js');
const { CAT } = require('js/catalog.js');
const { esc, uid, plural } = require('js/util.js');
const { shrink, loadBitmap, toBlob } = require('js/images.js');

// ---------- pictures ----------
// Render <img data-img="id"> then call hydrate(root) to load from storage.
function img(id, { cls = '', alt = '' } = {}) {
  return id ? raw(`<img class="${cls}" data-img="${esc(id)}" alt="${esc(alt)}" loading="lazy" decoding="async">`) : raw('');
}
async function hydrate(root = document) {
  for (const el of $$('img[data-img]', root)) {
    if (el.dataset.done) continue;
    el.dataset.done = '1';
    const u = await store.imageURL(el.dataset.img);
    if (u) el.src = u; else { el.classList.add('missing'); el.removeAttribute('src'); }
  }
}

function swatch(hex, cls = '') { return raw(`<span class="swatch ${cls}" style="--c:${esc(/^#[0-9a-f]{6}$/i.test(hex || '') ? hex : '#8C8F96')}"></span>`); }

// One wardrobe tile (photo or colour block).
function tile(it, { small = false, selectable = false, selected = false, extra = '' } = {}) {
  if (!it) return raw('');
  const hex = it.colour?.hex || '#8C8F96';
  return raw(html`<div class="tile${small ? ' small' : ''}${selected ? ' sel' : ''}" data-id="${it.id}" ${raw(selectable ? `role="checkbox" aria-checked="${selected}" tabindex="0"` : '')}>
    <div class="tile-pic" style="--c:${hex}"><span class="tile-sw"></span>${it.photo?.thumb ? img(small ? it.photo.thumb : (it.photo.full || it.photo.thumb), { alt: it.name }) : ''}
      <span class="code">${it.code}</span>${it.favourite ? raw(`<span class="fav">${icon('heart').__raw}</span>`) : ''}${selectable ? raw(`<span class="tick">${icon('check').__raw}</span>`) : ''}</div>
    ${small ? '' : raw(html`<div class="tile-name">${it.name}</div>`)}${raw(extra)}</div>`);
}

// An outfit board built from the user's own item photos.
function board(ids, { missing = [] } = {}) {
  const items = ids.map(itemById).filter(Boolean);
  const main = items.filter(i => ['top', 'bottom', 'one'].includes(CAT[i.category]?.group));
  const rest = items.filter(i => !main.includes(i));
  return raw(html`<div class="board">
    <div class="board-main">${main.map(i => tile(i))}</div>
    ${rest.length || missing.length ? raw(html`<div class="board-rest">${rest.map(i => tile(i, { small: true }))}${missing.map(m => raw(html`<div class="tile small ghost"><div class="tile-pic"><span class="miss">${icon('plus')}</span></div><div class="tile-name">${m}</div></div>`))}</div>`) : ''}
  </div>`);
}
function itemList(ids) {
  return ids.map(itemById).filter(Boolean).map(i => `${i.name} (${i.code})`).join(', ');
}

// ---------- Wore this + rating ----------
const REASONS = ['Colours', "Pieces don't go together", 'Too formal', 'Too casual', 'Uncomfortable'];
const AUDIENCES = ['Office', 'Family', 'Friends', 'Event guests'];
function woreThis(ids, { baseIds = ids, mainId = ids[0], audience = null, date = today(), lookId = null, after = null } = {}) {
  const entryId = uid('n-');
  mutate(s => {
    s.worn.push({ id: entryId, date, itemIds: ids, baseIds, mainId, rating: null, reason: '', audience, lookId });
    for (const id of ids) { const w = s.wardrobe.find(x => x.id === id); if (w) { w.timesWorn = (w.timesWorn || 0) + 1; w.lastWorn = date; } }
    if (lookId) { const l = s.looks.find(x => x.id === lookId); if (l) l.wornOn = date; }
  }, { undo: 'Logged as worn today' });
  rateSheet(entryId, after);
}
function rateSheet(entryId, after = null) {
  const s = openSheet(html`<p class="lead">How did it feel? This helps future suggestions.</p>
    <div class="rate-row">${['Love it', 'Fine', 'Not for me'].map(r => raw(html`<button class="btn rate" data-r="${r}">${r}</button>`))}</div>
    <div class="reason" hidden><p class="muted">What didn't work? (optional)</p><div class="chips">${REASONS.map(r => raw(html`<button class="chip" data-reason="${r}">${r}</button>`))}</div></div>
    <p class="muted small-gap">Who saw it? (helps avoid repeats)</p><div class="chips" data-aud>${AUDIENCES.map(a => raw(html`<button class="chip" data-a="${a}" aria-pressed="false">${a}</button>`))}</div>
    <div class="btn-col"><button class="btn primary" data-done>Done</button><button class="btn ghost" data-close="1">Skip</button></div>`, { title: 'Rate this outfit', onClose: () => after?.() });
  const entry = () => state.worn.find(w => w.id === entryId);
  s.body.addEventListener('click', e => {
    const r = e.target.closest('[data-r]'), rs = e.target.closest('[data-reason]'), a = e.target.closest('[data-a]');
    if (r) {
      $$('[data-r]', s.body).forEach(b => b.classList.toggle('on', b === r));
      const en = entry(); if (en) { en.rating = r.dataset.r; save(); }
      $('.reason', s.body).hidden = r.dataset.r !== 'Not for me';
    }
    if (rs) { rs.classList.toggle('on'); const en = entry(); if (en) { en.reason = $$('[data-reason].on', s.body).map(b => b.dataset.reason).join(', '); save(); } }
    if (a) { $$('[data-a]', s.body).forEach(b => { const on = b === a && b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', on); b.classList.toggle('on', on); }); const en = entry(); if (en) { en.audience = $('[data-a].on', s.body)?.dataset.a || null; save(); } }
    if (e.target.closest('[data-done]')) { s.close(); toast('Saved. Thanks!', { ms: 2000 }); }
  });
}

// ---------- sending a request to the AI ----------
// The main button is a real link to the AI app (never blocked as a pop-up); tapping it also copies the request.
// Copying and sharing are started straight from the tap, because phones only allow them during a tap.
// files: [{ file, label }] (or plain Files), in the order the AI must receive them. The handoff planner picks the
// route this browser can really use and writes matching steps; on the copy route each picture gets a Save button.
function handoffFiles(files) {
  const f = typeof files === 'function' ? files() : files;
  return (Array.isArray(f) ? f : []).filter(Boolean).map(x => x instanceof Blob ? { file: x, label: x.name || 'the picture' } : x).filter(x => x && x.file);
}
function handoffHTML({ text, files = null, sendLabel = null, which = state.profile.defaultAI, note = '', sessionId = '', stage = '', intro = [], after = [] }) {
  const name = aiName(which);
  const list = handoffFiles(files);
  const plan = planHandoff({ name, files: list.map(x => x.label), canShare: list.length > 0 && canShareFiles(list.map(x => x.file)), sendLabel: sendLabel || `Send to ${name}`, intro, after });
  const link = (cls, label) => raw(html`<a class="btn ${cls}" data-copy href="${AI[which].url}" target="_blank" rel="noopener">${icon('copy')}<span>${label}</span></a>`);
  return raw(html`<div class="handoff" data-which="${which}" data-session="${sessionId || ''}" data-stage="${stage || ''}" data-route="${plan.route}">
    <ol class="steps">${plan.steps.map(s => raw(`<li>${s}</li>`))}</ol>
    ${plan.route === 'share' ? raw(html`<button class="btn primary big" data-send>${icon('share')}<span>${sendLabel || `Send to ${name}`}</span></button>${link('secondary', `Copy request & open ${name}`)}`)
    : raw(html`${plan.save.length ? raw(html`<div class="btn-col save-files">${plan.save.map(i => raw(html`<button class="btn secondary" data-savefile="${i}">${icon('download')}<span>Save ${list[i].label}</span></button>`))}</div>`) : ''}${link('primary big', `Copy request & open ${name}`)}`)}
    ${note ? raw(`<p class="muted center">${note}</p>`) : ''}
    <details class="see"><summary>See what we'll send</summary><pre class="req">${text}</pre><button class="btn small ghost" data-copyonly>${icon('copy')}<span>Copy only</span></button>
      <p class="muted small">Style You never sends anything by itself. It copies the request${list.length ? ' and, where this browser allows, shares the pictures' : ''}; you send it in ${name}. No AI key is used.</p></details>
    <button class="linkish" data-switch>Use ${which === 'gemini' ? 'ChatGPT' : 'Gemini'} instead</button>
  </div>`);
}
// Starts the copy inside the tap. Returns a promise of true/false.
function copyNow(text) {
  try {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => copyText(text));
  } catch { /* fall back */ }
  return copyText(text);
}
function wireHandoff(root, { text, files = null, onSent = null, onSwitch = null }) {
  const h = root?.classList?.contains('handoff') ? root : $('.handoff', root); if (!h) return;
  const which = h.dataset.which;
  const getText = () => typeof text === 'function' ? text() : text;
  h.querySelector('[data-copy]')?.addEventListener('click', () => {
    // no preventDefault: the link opens the AI app
    copyNow(getText()).then(ok => { if (!ok) { h.querySelector('details').open = true; toast('Copying did not work here. Open "See what we\'ll send" and copy the text by hand.', { ms: 8000 }); } else toast(`Copied. Paste it into ${aiName(which)}.`, { ms: 3500 }); });
    recordHandoff({ sessionId: h.dataset.session || null, provider: which, kind: 'request', method: 'copy-open', stage: h.dataset.stage || '' }); onSent?.('copy', which);
  });
  h.querySelector('[data-send]')?.addEventListener('click', () => {
    const t = getText();
    const fl = handoffFiles(files).map(x => x.file);
    copyNow(t); // also on the clipboard in case the AI app drops the text
    let p;
    try { p = navigator.share({ files: fl, text: t }); } catch (e) { p = Promise.reject(e); }
    p.then(() => { recordHandoff({ sessionId: h.dataset.session || null, provider: which, kind: 'request', method: 'file-share', stage: h.dataset.stage || '' }); onSent?.('share', which); toast(`Shared. If the request text is missing in ${aiName(which)}, paste it — it's already copied.`, { ms: 5000 }); },
      e => { if (e?.name !== 'AbortError') toast('Sending did not work. Use "Copy request" instead.', { ms: 5000 }); });
  });
  h.querySelectorAll('[data-savefile]').forEach(b => b.addEventListener('click', () => {
    const f = handoffFiles(files)[+b.dataset.savefile]; if (!f) return;
    download(f.file, f.file.name || 'style-you.jpg');
    b.classList.add('done'); toast(`Saved ${f.label}. Attach it in ${aiName(which)}.`, { ms: 3500 });
  }));
  h.querySelector('[data-copyonly]')?.addEventListener('click', () => { copyNow(getText()).then(ok => toast(ok ? 'Copied' : 'Select the text and copy it', { ms: 2000 })); });
  const sw = h.querySelector('[data-switch]');
  // A switch button that has nowhere to go is removed rather than left dead.
  if (sw && !onSwitch) sw.remove();
  else sw?.addEventListener('click', () => onSwitch(which === 'gemini' ? 'chatgpt' : 'gemini'));
}

// ---------- bringing a reply back ----------
function pasteHTML({ label = 'Paste the reply', hint = '' } = {}) {
  return raw(html`<div class="paste">
    <button class="btn primary big" data-paste>${icon('paste')}<span>${label}</span></button>
    ${hint ? raw(`<p class="muted center">${hint}</p>`) : ''}
    <details class="manual"><summary>Paste it by hand instead</summary>
      <textarea rows="6" placeholder="Long-press here and choose Paste" aria-label="Reply text"></textarea>
      <button class="btn secondary" data-use>Use this text</button></details>
  </div>`);
}
function wirePaste(root, onText) {
  const p = $('.paste', root); if (!p) return;
  const manual = p.querySelector('details'); const ta = p.querySelector('textarea');
  p.querySelector('[data-paste]').addEventListener('click', async () => {
    const r = await readClipboardText();
    if (r.ok && r.text.trim()) return onText(r.text);
    manual.open = true; ta.focus();
    toast(r.ok ? 'Nothing copied yet. In the AI app, tap Copy under the reply, then come back.' : 'This browser needs you to paste by hand: long-press the box and tap Paste.', { ms: 6000 });
  });
  p.querySelector('[data-use]').addEventListener('click', () => { if (ta.value.trim()) onText(ta.value); else toast('The box is empty', { ms: 2000 }); });
}

// ---------- bringing a picture back ----------
function pictureReturnHTML(which = state.profile.defaultAI) {
  const name = aiName(which);
  const fast = isAndroid
    ? `<li>In ${name}, open the picture and tap <b>Share</b>, then pick <b>Style You</b>.</li><li>Or tap <b>Copy</b> on the picture and come back to <b>Paste picture</b>.</li>`
    : `<li>In ${name}, press and hold the picture, then tap <b>Copy</b>.</li><li>Come back and tap <b>Paste picture</b>.</li>`;
  return raw(html`<div class="picret">
    <p class="eyebrow">${isAndroid ? 'Fastest on Android' : isIOS ? 'Fastest on iPhone' : 'Fastest way'}</p>
    <ol class="steps">${raw(fast)}</ol>
    <button class="btn primary big" data-ppaste>${icon('paste')}<span>Paste picture</span></button>
    <p class="eyebrow">Other ways</p>
    <div class="btn-col"><button class="btn secondary" data-ppick>${icon('image')}<span>Choose from Photos / Files</span></button>
    <button class="btn secondary" data-pshot>${icon('crop')}<span>Use a screenshot and crop</span></button></div>
  </div>`);
}
function wirePictureReturn(root, onBlob) {
  const r = $('.picret', root); if (!r) return;
  r.querySelector('[data-ppaste]').onclick = async () => {
    const c = await readClipboardImage();
    if (c.ok) return onBlob(c.blob);
    toast(c.reason === 'empty' ? 'No picture copied yet. Copy the picture in the AI app first.' : 'Pasting pictures is not allowed here. Use "Choose from Photos / Files".', { ms: 5000 });
  };
  r.querySelector('[data-ppick]').onclick = async () => { const [f] = await pickFiles({ accept: 'image/*' }); if (f) onBlob(f); };
  r.querySelector('[data-pshot]').onclick = async () => { const [f] = await pickFiles({ accept: 'image/*' }); if (!f) return; const c = await cropSheet(f); if (c) onBlob(c); };
}

// Draw a box over the screenshot to keep just the picture.
function cropSheet(file) {
  return new Promise(async resolve => {
    let bmp; try { bmp = await loadBitmap(file); } catch (e) { toast(e.message, { ms: 4000 }); return resolve(null); }
    const url = URL.createObjectURL(file);
    let done = false;
    const s = openSheet(html`<p class="muted">Drag across the picture to keep just the styled image.</p>
      <div class="crop"><img src="${url}" alt="Screenshot to crop" draggable="false"><div class="crop-box" hidden></div></div>
      <div class="btn-col"><button class="btn primary" data-ok disabled>Use this part</button><button class="btn secondary" data-all>Use the whole picture</button><button class="btn ghost" data-close="1">Cancel</button></div>`,
      { title: 'Crop the screenshot', full: true, onClose: () => { URL.revokeObjectURL(url); if (!done) { done = true; resolve(null); } } });
    const wrap = $('.crop', s.body), box = $('.crop-box', s.body), im = $('img', s.body), ok = $('[data-ok]', s.body);
    let start = null, rect = null;
    const pt = e => { const b = im.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)) }; };
    const draw = () => { const b = im.getBoundingClientRect(), w = wrap.getBoundingClientRect(); box.hidden = false; Object.assign(box.style, { left: `${b.left - w.left + rect.x * b.width}px`, top: `${b.top - w.top + rect.y * b.height}px`, width: `${rect.w * b.width}px`, height: `${rect.h * b.height}px` }); };
    wrap.addEventListener('pointerdown', e => { e.preventDefault(); wrap.setPointerCapture(e.pointerId); start = pt(e); rect = { x: start.x, y: start.y, w: 0, h: 0 }; draw(); });
    wrap.addEventListener('pointermove', e => { if (!start) return; const p = pt(e); rect = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) }; draw(); });
    wrap.addEventListener('pointerup', () => { start = null; ok.disabled = !(rect && rect.w > 0.05 && rect.h > 0.05); });
    const finish = async whole => {
      let out = file;
      if (!whole) {
        const W = bmp.width, H = bmp.height; const cv = document.createElement('canvas');
        cv.width = Math.round(rect.w * W); cv.height = Math.round(rect.h * H);
        cv.getContext('2d').drawImage(bmp, rect.x * W, rect.y * H, rect.w * W, rect.h * H, 0, 0, cv.width, cv.height);
        out = await toBlob(cv, 'image/jpeg', 0.9);
      }
      done = true; await s.close(); resolve(out);
    };
    ok.onclick = () => finish(false);
    $('[data-all]', s.body).onclick = () => finish(true);
  });
}

// Store a picture as a 1080 px copy (+ 200 px thumb). Returns {full, thumb}.
async function keepPicture(blob, kind = 'look') {
  const big = await shrink(blob, 1080, 0.85);
  const small = await shrink(big.bmp, 240, 0.8);
  const full = await store.putImage(big.blob, kind, { w: big.w, h: big.h });
  const thumb = await store.putImage(small.blob, kind + '-thumb', { w: small.w, h: small.h });
  return { full, thumb };
}

// ---------- before / after ----------
function compareHTML(beforeId, afterId, { labelA = 'You now', labelB = 'Proposed', cls = '' } = {}) {
  if (!afterId) return raw('');
  if (!beforeId) return raw(html`<figure class="cmp-one">${img(afterId, { alt: 'Proposed look' })}<figcaption>AI style visualisation. Fit and details may differ.</figcaption></figure>`);
  return raw(html`<div class="cmp ${cls}" data-mode="side">
    <div class="seg" role="tablist" aria-label="Compare view"><button role="tab" aria-selected="true" data-m="side">Side by side</button><button role="tab" aria-selected="false" data-m="slide">Slider</button></div>
    <div class="cmp-side"><figure>${img(beforeId, { alt: labelA })}<figcaption>${labelA}</figcaption></figure><figure>${img(afterId, { alt: labelB })}<figcaption>${labelB}</figcaption></figure></div>
    <div class="cmp-slide" hidden><div class="cmp-stage">${img(afterId, { cls: 'cmp-b', alt: labelB })}${img(beforeId, { cls: 'cmp-a', alt: labelA })}<span class="cmp-line"></span><span class="cmp-la">${labelA}</span><span class="cmp-lb">${labelB}</span></div>
      <input type="range" min="0" max="100" value="50" aria-label="Slide to compare ${labelA} with ${labelB}"></div>
    <p class="muted small">AI style visualisation. Fit and details may differ.</p>
  </div>`);
}
function wireCompare(root) {
  for (const c of $$('.cmp', root)) {
    const setMode = m => { c.dataset.mode = m; $$('[data-m]', c).forEach(b => b.setAttribute('aria-selected', String(b.dataset.m === m))); $('.cmp-side', c).hidden = m !== 'side'; $('.cmp-slide', c).hidden = m !== 'slide'; };
    $$('[data-m]', c).forEach(b => b.onclick = () => setMode(b.dataset.m));
    const r = $('input[type=range]', c); const st = $('.cmp-stage', c);
    const upd = () => st.style.setProperty('--pos', `${r.value}%`);
    r.oninput = upd; upd();
  }
  // Tap a picture to see it full screen.
  for (const im of $$('.cmp-side img, .cmp-one img, .pic-solo img', root)) {
    im.classList.add('zoomable'); im.setAttribute('tabindex', '0'); im.setAttribute('role', 'button');
    const open = () => { if (!im.src) return; openSheet(html`<img class="full-view" src="${im.src}" alt="${im.alt || 'Picture'}">`, { title: im.alt || 'Picture', full: true }); };
    im.addEventListener('click', open);
    im.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  }
}

// ---------- empty state ----------
function empty(title, text, actions = '') {
  return raw(html`<div class="empty"><div class="empty-ic">${icon('sparkle')}</div><h2>${title}</h2><p>${text}</p>${raw(actions)}</div>`);
}

function plainCount(n, w, p) { return plural(n, w, p); }
Object.defineProperty(exports,'img',{enumerable:true,get:()=>img});
Object.defineProperty(exports,'hydrate',{enumerable:true,get:()=>hydrate});
Object.defineProperty(exports,'swatch',{enumerable:true,get:()=>swatch});
Object.defineProperty(exports,'tile',{enumerable:true,get:()=>tile});
Object.defineProperty(exports,'board',{enumerable:true,get:()=>board});
Object.defineProperty(exports,'itemList',{enumerable:true,get:()=>itemList});
Object.defineProperty(exports,'REASONS',{enumerable:true,get:()=>REASONS});
Object.defineProperty(exports,'AUDIENCES',{enumerable:true,get:()=>AUDIENCES});
Object.defineProperty(exports,'woreThis',{enumerable:true,get:()=>woreThis});
Object.defineProperty(exports,'rateSheet',{enumerable:true,get:()=>rateSheet});
Object.defineProperty(exports,'handoffFiles',{enumerable:true,get:()=>handoffFiles});
Object.defineProperty(exports,'handoffHTML',{enumerable:true,get:()=>handoffHTML});
Object.defineProperty(exports,'copyNow',{enumerable:true,get:()=>copyNow});
Object.defineProperty(exports,'wireHandoff',{enumerable:true,get:()=>wireHandoff});
Object.defineProperty(exports,'pasteHTML',{enumerable:true,get:()=>pasteHTML});
Object.defineProperty(exports,'wirePaste',{enumerable:true,get:()=>wirePaste});
Object.defineProperty(exports,'pictureReturnHTML',{enumerable:true,get:()=>pictureReturnHTML});
Object.defineProperty(exports,'wirePictureReturn',{enumerable:true,get:()=>wirePictureReturn});
Object.defineProperty(exports,'cropSheet',{enumerable:true,get:()=>cropSheet});
Object.defineProperty(exports,'keepPicture',{enumerable:true,get:()=>keepPicture});
Object.defineProperty(exports,'compareHTML',{enumerable:true,get:()=>compareHTML});
Object.defineProperty(exports,'wireCompare',{enumerable:true,get:()=>wireCompare});
Object.defineProperty(exports,'empty',{enumerable:true,get:()=>empty});
Object.defineProperty(exports,'plainCount',{enumerable:true,get:()=>plainCount});
};
__mods['js/prompts.js'] = function(require,exports,module){
// The text requests Style You hands to Gemini / ChatGPT. Pure (Node-testable).
const { CAT, OCC } = require('js/catalog.js');
const { prettyDate } = require('js/util.js');

const REQUEST_VERSION = 'v4.0';
const SIGN = `(Style You request ${REQUEST_VERSION})`;
function returnLine(sessionId = '') {
  if (!sessionId) return '';
  try { const l = globalThis.location; return l?.origin && l?.pathname ? `\nSTYLEYOU_RETURN: ${l.origin}${l.pathname}#/session/${encodeURIComponent(sessionId)}` : ''; } catch { return ''; }
}
// The session line every request starts with. The AI is asked to repeat it, so a reply shared or pasted back
// can be matched to the right occasion even when several are open.
function sessionHead(sessionId = '', { image = false } = {}) {
  const sid = sessionId || 'unassigned';
  const echo = !sessionId ? '' : image
    ? `\nIf you reply with any text, start it with the line STYLEYOU_SESSION: ${sid} exactly as written.`
    : `\nStart your reply with the line STYLEYOU_SESSION: ${sid} exactly as written.`;
  return `STYLEYOU_SESSION: ${sid}${returnLine(sessionId)}${echo}`;
}

// Text written by the 6.3 "Add a preference" button before the user typed anything. Never sent as a preference.
const DNA_PLACEHOLDER = 'Add your preference here.';
function dnaStatements(p = {}) {
  const d = p.styleDNA?.statements;
  return (Array.isArray(d) ? d.map(x => typeof x === 'string' ? x : x?.text) : [])
    .map(x => String(x || '').trim()).filter(x => x && x !== DNA_PLACEHOLDER);
}
// The user's own style notes and the preferences learned from their ratings, labelled separately.
function memoryLines(p = {}, conflictRule = '') {
  const notes = String(p.styleNotes || '').trim();
  const dna = dnaStatements(p);
  const out = [];
  if (notes) out.push(`My style notes: ${notes}${/[.!?]$/.test(notes) ? '' : '.'}`);
  if (dna.length) out.push(`Learned preferences from my ratings: ${dna.join('; ')}${/[.!?]$/.test(dna[dna.length - 1]) ? '' : '.'}`);
  if (out.length && conflictRule) out.push(conflictRule);
  return out.length ? '\n' + out.join('\n') : '';
}

const CLOTHING_TEXT = {
  auto: 'menswear or womenswear; follow my brief and wardrobe, and do not infer gender or other demographics from my photo',
  menswear: 'menswear', womenswear: 'womenswear', both: 'menswear or womenswear; follow my brief and wardrobe'
};

function sizesText(p = {}) {
  const s = p.sizes || {};
  const bits = [s.top && `top ${s.top}`, s.bottom && `bottom ${s.bottom}`, s.shoe && `shoes ${s.shoe}`].filter(Boolean);
  return bits.length ? bits.join(', ') : 'not given';
}

function wardrobeLines(wardrobe = [], available = null) {
  const list = available ? wardrobe.filter(available) : wardrobe;
  if (!list.length) return 'None listed.';
  return list.map(w => {
    const bits = [w.name, CAT[w.category]?.label, w.colour?.unknown ? '' : w.colour?.name, w.secondColour?.name ? `secondary ${w.secondColour.name}` : '', w.pattern, w.fabric, w.fit, w.occasions?.length ? `occasions: ${w.occasions.join('/')}` : ''].filter(Boolean);
    return `${w.code} · ${[...new Set(bits)].join(' · ')}`;
  }).join('\n');
}

function colourText(p) {
  const c = p.colours;
  if (!c || (!c.good?.length && !c.careful?.length)) return 'not set';
  return `good: ${(c.good || []).join(', ') || '—'}; use carefully: ${(c.careful || []).join(', ') || '—'}`;
}
function avoidText(p, extra = '') {
  const a = [...(p.avoidColours || [])];
  return [a.length ? `avoid colours: ${a.join(', ')}` : '', p.customs || '', extra].filter(Boolean).join('; ') || 'none';
}
function lang(p) { return p.language && p.language !== 'English' ? `\nReply language: ${p.language} (keep the STYLEYOU markers and codes exactly as shown).` : ''; }

const PIECE_FORMAT = `- [Category] | [Item, with colour] | owned [CODE] or missing`;

// opts.sheet: a labelled picture of the user's clothes is sent as Image 2.
function occasionRequest(s, p, wardrobeText, { sheet = false } = {}) {
  const o = s.occasion || {};
  const occ = OCC[o.occasionId]?.label || o.occasionId || 'Occasion';
  const when = [o.date ? prettyDate(o.date, { weekday: 'long', day: 'numeric', month: 'long' }) : 'date not set', o.daypart].filter(Boolean).join(', ');
  const weather = [o.weatherTemp, ...(o.weatherExtras || [])].filter(Boolean).join(' + ') || 'not given';
  return `Reply in TEXT ONLY. Do not create or edit any image in this reply.
Image 1 is my photo.${sheet ? ' Image 2 is a labelled sheet of my clothes; its codes match my wardrobe list below.' : ''}
Check Image 1 only: if it is not a clear, usable full-length photo of one person, say so and stop. The user has already confirmed they are 18 or older in Style You; do not infer or comment on age from appearance.

Act as my personal stylist ${SIGN}.
${sessionHead(s.id)}
Occasion: ${occ}${o.sub ? ` (${o.sub})` : ''} — ${when} — ${o.place || 'place not set'} — ${o.setting || 'indoors and outdoors'}.
Weather: ${weather}${o.weatherSummary ? ` (${o.weatherSummary})` : ''}.
Style direction: ${o.style || 'surprise me'}${o.vibes?.length ? `; mood: ${o.vibes.join(', ')}` : ''}.
Clothing: ${CLOTHING_TEXT[p.clothing] || CLOTHING_TEXT.auto}. My sizes: ${sizesText(p)}.
Budget for anything new: ${o.budget ? `₹${o.budget}` : 'not set'}.
Customs, comfort and dislikes: ${avoidText(p, [o.notes, p.comfort].filter(Boolean).join('; '))}.
My colours: ${colourText(p)}.${memoryLines(p, "If any of these conflict with this occasion's details above, follow the occasion's details.")}${o.alreadyWorn ? `\nAlready worn in front of the same people (do not repeat these main pieces): ${o.alreadyWorn}.` : ''}
My wardrobe (use these codes; use my own pieces where they fit):
${wardrobeText}
${sheet ? 'Use Image 2 only as a visual reference for those same codes; do not invent wardrobe items not listed here.\n' : ''}${o.noShopping ? 'Use ONLY pieces from my wardrobe list; do not suggest anything I would need to buy. Every piece must be marked owned with its code. If something important is missing, say so in the Why line instead.\n' : ''}
Apart from that check, do not guess or comment on ethnicity, race, religion, health, age or body measurements. Describe any styling observation neutrally.
Give exactly 3 different looks suited to the occasion (default: safe, contemporary, more expressive; less variation if the occasion calls for it).
List EVERY piece head to toe: clothing, layer if needed, footwear, accessories and jewellery.
Use exactly this format, with no code fences:

STYLEYOU_LOOK_1_BEGIN
Name: [short name]
Why: [one sentence]
Pieces:
${PIECE_FORMAT}
STYLEYOU_LOOK_1_END

(then STYLEYOU_LOOK_2_BEGIN … STYLEYOU_LOOK_2_END and STYLEYOU_LOOK_3_BEGIN … STYLEYOU_LOOK_3_END in the same format)

Finish with one line: Choose Look 1, 2 or 3.${lang(p)}`;
}

function piecesText(look) {
  return look.pieces.map(x => `- ${x.category ? x.category + ' | ' : ''}${x.name}${x.owned ? ` (mine${x.code ? ', ' + x.code : ''})` : ''}`).join('\n');
}

const PHOTO_HERE = 'Edit the full-length photo of me attached to this message. If no photo of me is attached, ask me to attach it and stop.';
const IDENTITY = 'Edit my photo; do not create a new person. Keep my face, facial features, hairstyle, skin tone, apparent body shape and proportions, pose and background as close to the original as possible.';

function pictureRequest(look, products = [], sessionId = '') {
  const refs = products.filter(p => p?.found).map(p => `- ${p.piece || 'Missing piece'}: ${[p.brand, p.product, p.retailer].filter(Boolean).join(' · ')}${p.url ? ` · ${p.url}` : ''}`).join('\n');
  return `${sessionHead(sessionId, { image: true })}
I choose Look ${look.number}: ${look.name} ${SIGN}.
Its pieces:
${piecesText(look)}
${refs ? `\nFor the pieces I needed to buy, use these product references as closely as possible:\n${refs}\n` : ''}
${PHOTO_HERE} Dress me in exactly this look.
${IDENTITY}
Change only clothing, footwear, accessories and jewellery. Do not slim, age, de-age, beautify or add make-up.
Preserve the distinctive visible details of the chosen garments and product references as closely as possible.
Make ONE image only. It is an AI style visualisation, not a virtual try-on; fit and fine details may differ.`;
}

function correctionRequest(look, sessionId = '') {
  return `${sessionHead(sessionId, { image: true })}
The last picture did not match Look ${look.number}: ${look.name} ${SIGN}. Please try again.
${PHOTO_HERE}
${IDENTITY}
Use exactly these pieces and nothing else:
${piecesText(look)}
Change only clothing, footwear, accessories and jewellery. Make ONE image only.`;
}

function productsRequest(look, s, p) {
  const missing = look.pieces.filter(x => !x.owned);
  return `${sessionHead(s.id)}
Now find products for Look ${look.number}: ${look.name} ${SIGN}.
Pieces I need to buy:
${missing.map(x => `- ${x.name}`).join('\n') || '- (none)'}

For EVERY piece above, find one specific product currently sold in India, in my size where possible (${sizesText(p)}), keeping the total within ${s.occasion?.budget ? `₹${s.occasion.budget}` : 'a sensible budget'}.
Prefer Amazon India, Myntra, AJIO, Flipkart, Tata CLiQ or Nykaa Fashion.
Each link must be that product's own page — never a home, category or search page.
Never invent a product, link, price or stock. If you cannot find an exact product, write NOT FOUND for that piece.
Use exactly this format, with no code fences:

STYLEYOU_PRODUCTS_BEGIN
- Piece: [piece] | Brand: [brand] | Product: [product name] | Retailer: [shop] | Price: ₹[price] | Link: https://...
- Piece: [piece] | NOT FOUND
STYLEYOU_PRODUCTS_END

Remind me to check size, price and stock on the shop's page before buying.`;
}

function outfitFormat(n, prefix = 'OUTFIT', keys = null) {
  const ks = keys || Array.from({ length: n }, (_, i) => String(i + 1));
  return ks.map(k => `STYLEYOU_${prefix}_${k}_BEGIN
Codes: [codes from my wardrobe, comma separated]
Why: [one sentence]
Missing: [anything important I don't own, described generically, or None]
STYLEYOU_${prefix}_${k}_END`).join('\n\n');
}

function dailyRequest(ctx, p, wardrobeText, recent) {
  return `Act as my everyday stylist ${SIGN}. Reply in text only.
Today: ${ctx.label}; weather: ${[ctx.temp, ...(ctx.extras || [])].filter(Boolean).join(' + ') || 'not given'}; place: ${p.city?.name || 'not set'}.
Clothing: ${CLOTHING_TEXT[p.clothing] === CLOTHING_TEXT.auto ? 'follow my wardrobe' : CLOTHING_TEXT[p.clothing]}. Customs and dislikes: ${avoidText(p)}. My colours: ${colourText(p)}.${memoryLines(p, "If any of these conflict with today's weather or kind of day, those come first.")}
Worn in the last 3 days (avoid): ${recent || 'nothing logged'}.
My available wardrobe:
${wardrobeText}

Suggest exactly 2 outfits using ONLY my wardrobe codes. Name anything important that is missing generically, with no brand, link or price.
Use exactly this format, with no code fences:

${outfitFormat(2)}${lang(p)}`;
}

function judgeRequest(outfits, p) {
  return `Act as my stylist ${SIGN}. The attached picture shows my clothes, each labelled with a code.
Here are 3 outfits from my wardrobe:
${outfits.map((o, i) => `${i + 1}. ${o.codes.join(', ')}`).join('\n')}
Which works best, and why? You may swap pieces, but use ONLY codes shown in the picture.
Answer in text only, using exactly this format with no code fences:

${outfitFormat(3)}${lang(p)}`;
}

function seeItOnMeRequest(items) {
  return `Two pictures are attached ${SIGN}: Image 1 is a full-length photo of me, and Image 2 is a sheet of my own clothes labelled with codes.
If Image 1 is missing or is not a clear, usable full-length photo of one person, say so and stop. The user has already confirmed they are 18 or older in Style You; do not infer or comment on age from appearance.
Edit my photo so I am wearing exactly these pieces from the sheet: ${items.map(i => `${i.code} (${i.name})`).join(', ')}.
Edit my photo; do not create a new person. Keep my face, facial features, hairstyle, skin tone, body shape, pose and background exactly as they are.
Change only clothing, footwear, accessories and jewellery to match those pieces as closely as possible. Make ONE image only.`;
}

function labelsRequest(codes) {
  return `The attached picture shows my clothes, each labelled with a code ${SIGN}.
For every code (${codes.join(', ')}) write one line, using exactly this format with no code fences:

STYLEYOU_LABELS_BEGIN
[CODE] | [category, e.g. Kurta, Shirt, Trousers, Saree, Footwear, Earrings] | [main colour] | [pattern: Solid, Printed, Floral, Striped, Checked, Embroidered] | [fabric if you can tell, else Unknown] | [formality 1-5, 1 = very casual, 5 = very formal] | [suitable occasions, comma separated]
STYLEYOU_LABELS_END

Only use the codes shown. If you cannot see an item clearly, still write its line with Unknown where unsure.`;
}

function coloursRequest(p) {
  return `Look at my attached photo ${SIGN}. Reply in text only.
Suggest colours that would work well with my colouring, and a few to use carefully. Describe everything neutrally; do not label my skin tone, ethnicity or anything else about me.
Use exactly this format, with no code fences:

STYLEYOU_COLOURS_BEGIN
Good: [8 colour names, comma separated]
Careful: [4 colour names, comma separated]
STYLEYOU_COLOURS_END${lang(p)}`;
}

const WEEKDAY_KEYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function weekRequest(days, p, wardrobeText) {
  return `Plan my outfits for these days using ONLY my wardrobe ${SIGN}. Reply in text only.
${days.map(d => `- ${d.key} (${prettyDate(d.date)}): ${d.label}${d.weather ? `, ${d.weather}` : ''}`).join('\n')}
Do not repeat the same main piece (top, bottom or full outfit) on two days unless there is no other option.
Customs and dislikes: ${avoidText(p)}. My colours: ${colourText(p)}.${memoryLines(p, "If any of these conflict with a day's weather or plans, those come first.")}
My available wardrobe:
${wardrobeText}

Use exactly this format for each day, with no code fences:

${outfitFormat(days.length, 'DAY', days.map(d => d.key))}${lang(p)}`;
}

// When a reply came back without the markers.
function fixFormatRequest(kind) {
  const what = { LOOK: 'the 3 looks', PRODUCTS: 'the product list', OUTFIT: 'the outfits', DAY: 'the day plans', LABELS: 'the labels', COLOURS: 'the colour list' }[kind] || 'your answer';
  return `Please repeat ${what} exactly in the STYLEYOU format I asked for, with the BEGIN and END lines, and nothing else. Text only, no code fences ${SIGN}.`;
}
Object.defineProperty(exports,'sessionHead',{enumerable:true,get:()=>sessionHead});
Object.defineProperty(exports,'memoryLines',{enumerable:true,get:()=>memoryLines});
Object.defineProperty(exports,'dnaStatements',{enumerable:true,get:()=>dnaStatements});
Object.defineProperty(exports,'DNA_PLACEHOLDER',{enumerable:true,get:()=>DNA_PLACEHOLDER});
Object.defineProperty(exports,'REQUEST_VERSION',{enumerable:true,get:()=>REQUEST_VERSION});
Object.defineProperty(exports,'sizesText',{enumerable:true,get:()=>sizesText});
Object.defineProperty(exports,'wardrobeLines',{enumerable:true,get:()=>wardrobeLines});
Object.defineProperty(exports,'occasionRequest',{enumerable:true,get:()=>occasionRequest});
Object.defineProperty(exports,'pictureRequest',{enumerable:true,get:()=>pictureRequest});
Object.defineProperty(exports,'correctionRequest',{enumerable:true,get:()=>correctionRequest});
Object.defineProperty(exports,'productsRequest',{enumerable:true,get:()=>productsRequest});
Object.defineProperty(exports,'dailyRequest',{enumerable:true,get:()=>dailyRequest});
Object.defineProperty(exports,'judgeRequest',{enumerable:true,get:()=>judgeRequest});
Object.defineProperty(exports,'seeItOnMeRequest',{enumerable:true,get:()=>seeItOnMeRequest});
Object.defineProperty(exports,'labelsRequest',{enumerable:true,get:()=>labelsRequest});
Object.defineProperty(exports,'coloursRequest',{enumerable:true,get:()=>coloursRequest});
Object.defineProperty(exports,'WEEKDAY_KEYS',{enumerable:true,get:()=>WEEKDAY_KEYS});
Object.defineProperty(exports,'weekRequest',{enumerable:true,get:()=>weekRequest});
Object.defineProperty(exports,'fixFormatRequest',{enumerable:true,get:()=>fixFormatRequest});
};
__mods['js/state.js'] = function(require,exports,module){
// App state shape, defaults, migration and codes. Pure (Node-testable).
const { CAT, guessCategory, hexForName, nameColour } = require('js/catalog.js');
const { uid, localISO } = require('js/util.js');
const { checkLink } = require('js/parse.js');

const STATE_VERSION = 9;   // internal
const EXPORT_SCHEMA = 2;   // backup file schema

function defaultState() {
  return {
    v: STATE_VERSION,
    profile: {
      name: '', adultConfirmed: false, onboarded: false,
      city: null, // {name, lat, lon}
      sizes: { top: '', bottom: '', shoe: '' },
      clothing: 'auto', styleNotes: '', customs: '', comfort: '', avoidColours: [],
      language: 'English', defaultAI: 'gemini', aiRouting: { looks: 'default', shopping: 'default', preview: 'default' }, colours: null, styleDNA: { statements: [], updatedAt: null }, keepPhotos: false, market: 'India'
    },
    wardrobe: [], sets: [], worn: [], looks: [], sessions: [], aiInbox: [], handoffs: [], week: null,
    settings: { lastBackup: null, photosSinceBackup: 0, backupSnoozeUntil: null, appearance: 'auto', homeScreenTipDismissed: false, firstRunAt: localISO() },
    codeSeq: {}
  };
}

function nextCode(state, category) {
  const prefix = (CAT[category] || CAT.other).prefix;
  const used = new Set(state.wardrobe.map(w => w.code));
  let n = state.codeSeq[prefix] || 0;
  let code;
  do { n++; code = `${prefix}${String(n).padStart(2, '0')}`; } while (used.has(code));
  state.codeSeq[prefix] = n;
  return code;
}

function newItem(state, { name, category, colourHex, colourName, photo = null, fp = '', fabric = '', pattern = '', formality = null, notes = '' }) {
  const cat = category && CAT[category] ? category : guessCategory(name);
  const cn = colourName || guessColourWord(name);
  const hex = colourHex || hexForName(cn) || null;
  const item = {
    id: uid('w-'), code: '', name: (name || CAT[cat].label).trim().slice(0, 80), category: cat,
    colour: hex ? { hex, name: colourName || (hexForName(cn) ? cn : nameColour(hex)) } : { hex: '#8C8F96', name: 'Not set', unknown: true }, pattern, fabric,
    formality: Number.isFinite(formality) ? formality : null, secondColour: null, seasons: [], occasions: [], fit: '', status: 'Available', statusSince: null,
    favourite: false, timesWorn: 0, lastWorn: null, photo, fp, notes, createdAt: new Date().toISOString()
  };
  item.code = nextCode(state, cat);
  return item;
}

const COLOUR_WORDS = ['off-white', 'off white', 'light brown', 'light grey', 'royal blue', 'sky blue', 'bottle green', 'sea green', 'parrot green', 'rani pink', 'baby pink', 'powder blue',
  'white', 'ivory', 'cream', 'beige', 'tan', 'brown', 'khaki', 'rust', 'black', 'charcoal', 'grey', 'gray', 'silver', 'navy', 'blue', 'denim', 'teal', 'turquoise', 'mint',
  'emerald', 'green', 'olive', 'mustard', 'yellow', 'lemon', 'gold', 'saffron', 'orange', 'peach', 'coral', 'red', 'maroon', 'wine', 'burgundy', 'pink', 'magenta', 'lavender', 'mauve', 'purple'];
function guessColourWord(text = '') {
  const t = String(text).toLowerCase();
  for (const w of COLOUR_WORDS) if (t.includes(w)) {
    const map = { 'off white': 'Off-white', gray: 'Grey', burgundy: 'Wine' };
    return map[w] || w.split(/[\s-]/).map((p, i) => i === 0 ? p[0].toUpperCase() + p.slice(1) : p).join(w.includes('-') ? '-' : ' ');
  }
  return '';
}

// Names that are plural by nature (a pair, or one garment) stay as they are.
const PLURAL_NOUNS = /(jeans|trousers|pants|shorts|leggings|chinos|palazzos?|pyjamas|pajamas|sunglasses|goggles|glasses|earrings|bangles|heels|loafers|sneakers|sandals|shoes|flats|boots|juttis|mojaris|jhumkas|studs|slippers|chappals|kolhapuris|cufflinks)$/i;
const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
function singular(name = '') {
  if (PLURAL_NOUNS.test(name)) return name;
  if (/sses$/i.test(name)) return name.slice(0, -2);
  if (/[^s]s$/i.test(name)) return name.slice(0, -1);
  return name;
}

// Split pasted text like "3 white shirts, navy chinos; brown loafers" into item names.
function splitBulk(text = '') {
  const out = [];
  for (let raw of String(text).split(/[\n;,]+/)) {
    raw = raw.replace(/^([-*•·]|\d+[.)])\s+/, '').trim();
    if (!raw) continue;
    const m = raw.match(/^(\d{1,2})\s*[x×]?\s+(.+)$/i);
    if (m) {
      const n = Math.min(10, parseInt(m[1], 10));
      if (!n) continue;
      const name = cap(singular(m[2].trim()));
      for (let i = 0; i < n; i++) out.push(n > 1 ? `${name} ${i + 1}` : name);
    } else out.push(cap(raw));
  }
  return out.slice(0, 200);
}

// Data can come from a backup file someone edited: keep colours and links safe to show.
const HEX = /^#[0-9a-f]{6}$/i;
function sanitize(st) {
  for (const w of st.wardrobe) { if (!w.colour || !HEX.test(w.colour.hex || '')) w.colour = { hex: '#8C8F96', name: 'Not set', unknown: true }; if (w.secondColour && !HEX.test(w.secondColour.hex || '')) w.secondColour = null; if (!CAT[w.category]) w.category = 'other'; w.seasons = Array.isArray(w.seasons) ? w.seasons.slice(0, 6) : []; w.occasions = Array.isArray(w.occasions) ? w.occasions.slice(0, 10) : []; w.fit = typeof w.fit === 'string' ? w.fit.slice(0,40) : ''; }
  for (const l of st.looks) {
    l.pieces = Array.isArray(l.pieces) ? l.pieces : [];
    for (const p of l.pieces) if (p.hex && !HEX.test(p.hex)) p.hex = null;
    l.products = (Array.isArray(l.products) ? l.products : []).map(p => { const c = p.url ? checkLink(p.url) : { ok: false }; return c.ok ? { ...p, url: c.url, retailer: c.retailer, found: true } : { ...p, url: '', found: false, reason: p.reason || 'No exact product found' }; });
    l.pictures = l.pictures && typeof l.pictures === 'object' ? l.pictures : {};
  }
  return st;
}

// Style DNA written by 6.3: drop the unedited "Add your preference here." placeholder and the generic sentence 6.3
// made up when it had nothing to learn; mark what 6.3 generated as learned and anything else as the user's own.
const DNA_PLACEHOLDER = 'Add your preference here.';
const DNA_GENERIC_63 = 'Keep recommendations close to the outfits I rate positively, and treat negative feedback as a strong signal not to repeat the same problem.';
const DNA_AUTO_63 = [/^Prioritise comfort even when the outfit is more formal\.$/, /^Prefer a more relaxed level of formality when the occasion allows\.$/, /^Prefer a more polished finish rather than very casual styling\.$/, /^Be conservative with colour combinations unless I explicitly ask for a colour-forward look\.$/, /^Prefer cohesive combinations with a clear relationship between the main pieces\.$/, /^Successful outfits often include .+\.$/];
function cleanDNA(dna) {
  const d = dna && typeof dna === 'object' ? dna : {};
  const statements = (Array.isArray(d.statements) ? d.statements : []).map(x => typeof x === 'string' ? { text: x } : x)
    .filter(x => x && typeof x.text === 'string').map(x => ({ ...x, text: x.text.trim().slice(0, 180) }))
    .filter(x => x.text && x.text !== DNA_PLACEHOLDER && x.text !== DNA_GENERIC_63)
    .map((x, i) => ({ id: x.id || `dna-m${i}`, text: x.text, source: x.source === 'user' || x.source === 'learned' ? x.source : (DNA_AUTO_63.some(r => r.test(x.text)) ? 'learned' : 'user') }));
  // If cleaning removed everything, let Style DNA build itself again from the ratings.
  const removedAll = !statements.length && Array.isArray(d.statements) && d.statements.length > 0;
  return { statements, updatedAt: removedAll ? null : (d.updatedAt || null) };
}

// Accepts any earlier saved shape (build v4/v5 localStorage, export schema 1-2, or current) and returns current state.
function migrate(raw) {
  const s = defaultState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return s;
  // A backup file wraps the data in "state"; read the inner part whatever its version.
  if (raw.state && typeof raw.state === 'object' && !Array.isArray(raw.wardrobe)) return migrate(raw.state);
  if ((Number.isInteger(raw.v) && raw.v >= 6) || raw.schemaVersion === EXPORT_SCHEMA) {
    const src = raw;
    const out = sanitize({
      ...s, ...src, v: STATE_VERSION,
      profile: { ...s.profile, ...(src.profile || {}), sizes: { ...s.profile.sizes, ...(src.profile?.sizes || {}) }, aiRouting: { ...s.profile.aiRouting, ...(src.profile?.aiRouting || {}) }, styleDNA: { ...s.profile.styleDNA, ...(src.profile?.styleDNA || {}) } },
      settings: { ...s.settings, ...(src.settings || {}) },
      wardrobe: Array.isArray(src.wardrobe) ? src.wardrobe.filter(w => w && w.id && w.name) : [],
      sets: Array.isArray(src.sets) ? src.sets : [], worn: Array.isArray(src.worn) ? src.worn : [],
      looks: Array.isArray(src.looks) ? src.looks : [], sessions: Array.isArray(src.sessions) ? src.sessions : [], aiInbox: Array.isArray(src.aiInbox) ? src.aiInbox : [], handoffs: Array.isArray(src.handoffs) ? src.handoffs : [],
      codeSeq: src.codeSeq && typeof src.codeSeq === 'object' ? src.codeSeq : {}
    });
    out.profile.styleDNA = cleanDNA(out.profile.styleDNA);
    return out;
  }
  // Older builds (v1-v5): {profile:{name, city, clothingSet, topSize..., defaultAI, styleNotes}, wardrobe:[{id,name,category,color,details}], worn:[{date,id}], journeys:[...]}
  const p = raw.profile || {};
  s.profile.name = String(p.name || '').slice(0, 40);
  s.profile.adultConfirmed = !!p.adultConfirmed;
  s.profile.onboarded = false; // ask once again for the new setup
  if (p.city) s.profile.city = (Number.isFinite(p.latitude) && Number.isFinite(p.longitude)) ? { name: p.city, lat: p.latitude, lon: p.longitude } : null;
  s.profile.sizes = { top: p.topSize || '', bottom: p.bottomSize || '', shoe: p.shoeSize || '' };
  s.profile.clothing = /^menswear/i.test(p.clothingSet || '') ? 'menswear' : /^womenswear/i.test(p.clothingSet || '') ? 'womenswear' : /^both/i.test(p.clothingSet || '') ? 'both' : 'auto';
  s.profile.defaultAI = p.defaultAI === 'chatgpt' ? 'chatgpt' : 'gemini';
  s.profile.styleNotes = p.styleNotes || '';
  const idMap = new Map();
  for (const w of (Array.isArray(raw.wardrobe) ? raw.wardrobe : [])) {
    if (!w || !w.name) continue;
    const colourName = guessColourWord(w.color || '') || guessColourWord(w.name);
    const it = newItem(s, { name: String(w.name), category: guessCategory(`${w.category || ''} ${w.name}`), colourName, notes: w.details || '' });
    if (w.lastWorn) it.lastWorn = w.lastWorn;
    s.wardrobe.push(it); idMap.set(w.id, it.id);
  }
  const byDate = new Map();
  for (const x of (Array.isArray(raw.worn) ? raw.worn : [])) {
    const nid = idMap.get(x.id); if (!nid || !x.date) continue;
    if (!byDate.has(x.date)) byDate.set(x.date, []);
    byDate.get(x.date).push(nid);
  }
  for (const [date, itemIds] of byDate) s.worn.push({ id: uid('n-'), date, itemIds, baseIds: itemIds, rating: null, audience: null, mainId: itemIds[0] });
  for (const j of (Array.isArray(raw.journeys) ? raw.journeys : [])) {
    if (!j || !j.selectedLookText || j.status === 'abandoned') continue;
    s.looks.push({
      id: uid('l-'), source: 'occasion', title: (j.selectedLookText.match(/^Name:\s*(.+)$/im) || [])[1] || `Look ${j.selectedLookNumber || ''}`.trim(),
      occasion: j.occasion?.occasion || '', date: j.occasion?.date || '', items: [], text: j.selectedLookText, pictures: {}, rating: j.feedback || null, createdAt: j.createdAt || new Date().toISOString()
    });
  }
  return s;
}
Object.defineProperty(exports,'STATE_VERSION',{enumerable:true,get:()=>STATE_VERSION});
Object.defineProperty(exports,'EXPORT_SCHEMA',{enumerable:true,get:()=>EXPORT_SCHEMA});
Object.defineProperty(exports,'defaultState',{enumerable:true,get:()=>defaultState});
Object.defineProperty(exports,'nextCode',{enumerable:true,get:()=>nextCode});
Object.defineProperty(exports,'newItem',{enumerable:true,get:()=>newItem});
Object.defineProperty(exports,'guessColourWord',{enumerable:true,get:()=>guessColourWord});
Object.defineProperty(exports,'singular',{enumerable:true,get:()=>singular});
Object.defineProperty(exports,'splitBulk',{enumerable:true,get:()=>splitBulk});
Object.defineProperty(exports,'cleanDNA',{enumerable:true,get:()=>cleanDNA});
Object.defineProperty(exports,'migrate',{enumerable:true,get:()=>migrate});
};
__mods['js/store.js'] = function(require,exports,module){
// Persistence: state JSON + pictures in IndexedDB; falls back to memory when storage is blocked.
const { defaultState, migrate } = require('js/state.js');

const DB = 'styleyou'; const VER = 1;
let db = null;
let mode = 'idb'; // 'idb' | 'memory'
let photosEphemeral = false; // iPhone Safari tab: keep pictures in memory only
const mem = { state: null, images: new Map(), inbox: [] };
const urls = new Map();

function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

async function open() {
  try {
    if (!globalThis.indexedDB) throw new Error('no idb');
    db = await new Promise((res, rej) => {
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('images')) d.createObjectStore('images', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('inbox')) d.createObjectStore('inbox', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('blocked'));
    });
    mode = 'idb';
  } catch { db = null; mode = 'memory'; }
  return mode;
}
function setPhotosEphemeral(v) { photosEphemeral = !!v; }

function tx(store, rw = 'readonly') { return db.transaction(store, rw).objectStore(store); }

async function loadState() {
  let raw = null;
  if (db) { try { raw = await req(tx('kv').get('state')); } catch { raw = null; } }
  else raw = mem.state;
  if (!raw) {
    // Bring over data from earlier builds (localStorage).
    try { const old = globalThis.localStorage?.getItem('styleyou-state'); if (old) { const st = migrate(JSON.parse(old)); st.settings.migratedFromV5 = true; return st; } } catch { /* ignore */ }
    return defaultState();
  }
  return migrate(raw);
}

let saving = Promise.resolve(); let lastError = null;
function saveState(state) {
  const copy = JSON.parse(JSON.stringify(state));
  saving = saving.then(async () => {
    if (!db) { mem.state = copy; return; }
    try { await req(tx('kv', 'readwrite').put(copy, 'state')); lastError = null; }
    catch (e) { lastError = e; throw e; }
  }).catch(e => { lastError = e; globalThis.dispatchEvent?.(new CustomEvent('sy-save-error', { detail: String(e?.name || e) })); });
  return saving;
}
function flush() { return saving; }
function saveError() { return lastError; }

function newId() { return 'img-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); }

async function putImage(blob, kind, meta = {}) {
  const rec = { id: newId(), blob, kind, bytes: blob.size || 0, w: meta.w || 0, h: meta.h || 0, createdAt: Date.now(), ephemeral: photosEphemeral || !db };
  if (!db || photosEphemeral) { mem.images.set(rec.id, rec); return rec.id; }
  await req(tx('images', 'readwrite').put(rec));
  return rec.id;
}
// Temporary personal photos are memory-only even when IndexedDB is available.
// They disappear on reload and can also be deleted explicitly when an AI helper closes.
async function putTemporaryImage(blob, kind = 'temp', meta = {}) {
  const rec = { id: newId(), blob, kind, bytes: blob.size || 0, w: meta.w || 0, h: meta.h || 0, createdAt: Date.now(), ephemeral: true };
  mem.images.set(rec.id, rec);
  return rec.id;
}
async function getImageRec(id) {
  if (!id) return null;
  if (mem.images.has(id)) return mem.images.get(id);
  if (!db) return null;
  try { return (await req(tx('images').get(id))) || null; } catch { return null; }
}
// 'yes' | 'no' | 'unknown' (storage error) — callers must not forget a photo on 'unknown'.
async function imageExists(id) {
  if (!id) return 'no';
  if (mem.images.has(id)) return 'yes';
  if (!db) return 'no';
  try { return (await req(tx('images').getKey(id))) !== undefined ? 'yes' : 'no'; } catch { return 'unknown'; }
}
async function getImage(id) { const r = await getImageRec(id); return r ? r.blob : null; }
async function imageURL(id) {
  if (!id) return '';
  if (urls.has(id)) return urls.get(id);
  const b = await getImage(id); if (!b) return '';
  const u = URL.createObjectURL(b); urls.set(id, u); return u;
}
async function deleteImage(id) {
  if (!id) return;
  if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
  mem.images.delete(id);
  if (db) { try { await req(tx('images', 'readwrite').delete(id)); } catch { /* ignore */ } }
}
async function allImageMeta() {
  const out = [...mem.images.values()].map(({ id, kind, bytes, createdAt, ephemeral }) => ({ id, kind, bytes, createdAt, ephemeral }));
  if (db) {
    const all = await req(tx('images').getAll());
    for (const r of all) out.push({ id: r.id, kind: r.kind, bytes: r.bytes || r.blob?.size || 0, createdAt: r.createdAt });
  }
  return out;
}
async function putImageWithId(id, blob, kind, meta = {}) {
  const rec = { id, blob, kind, bytes: blob.size || 0, w: meta.w || 0, h: meta.h || 0, createdAt: meta.createdAt || Date.now() };
  if (!db) { mem.images.set(id, rec); return id; }
  await req(tx('images', 'readwrite').put(rec)); return id;
}

async function clearAll() {
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear(); mem.images.clear(); mem.state = null;
  if (db) {
    await req(tx('kv', 'readwrite').clear());
    await req(tx('images', 'readwrite').clear());
    await req(tx('inbox', 'readwrite').clear());
  }
  try { globalThis.localStorage?.removeItem('styleyou-state'); globalThis.localStorage?.removeItem('sy-ui'); } catch { /* ignore */ }
}

// Android share target drops items here (from the service worker).
async function peekInbox() {
  if (!db) return [];
  const all = await req(tx('inbox').getAll());
  return all.sort((a, b) => a.at - b.at);
}
async function removeInbox(id) { if (db) await req(tx('inbox', 'readwrite').delete(id)); }

async function persist() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch { /* ignore */ }
  return false;
}
async function estimate() {
  try { if (navigator.storage?.estimate) return await navigator.storage.estimate(); } catch { /* ignore */ }
  return null;
}
Object.defineProperty(exports,'mode',{enumerable:true,get:()=>mode});
Object.defineProperty(exports,'photosEphemeral',{enumerable:true,get:()=>photosEphemeral});
Object.defineProperty(exports,'open',{enumerable:true,get:()=>open});
Object.defineProperty(exports,'setPhotosEphemeral',{enumerable:true,get:()=>setPhotosEphemeral});
Object.defineProperty(exports,'loadState',{enumerable:true,get:()=>loadState});
Object.defineProperty(exports,'saveState',{enumerable:true,get:()=>saveState});
Object.defineProperty(exports,'flush',{enumerable:true,get:()=>flush});
Object.defineProperty(exports,'saveError',{enumerable:true,get:()=>saveError});
Object.defineProperty(exports,'putImage',{enumerable:true,get:()=>putImage});
Object.defineProperty(exports,'putTemporaryImage',{enumerable:true,get:()=>putTemporaryImage});
Object.defineProperty(exports,'getImageRec',{enumerable:true,get:()=>getImageRec});
Object.defineProperty(exports,'imageExists',{enumerable:true,get:()=>imageExists});
Object.defineProperty(exports,'getImage',{enumerable:true,get:()=>getImage});
Object.defineProperty(exports,'imageURL',{enumerable:true,get:()=>imageURL});
Object.defineProperty(exports,'deleteImage',{enumerable:true,get:()=>deleteImage});
Object.defineProperty(exports,'allImageMeta',{enumerable:true,get:()=>allImageMeta});
Object.defineProperty(exports,'putImageWithId',{enumerable:true,get:()=>putImageWithId});
Object.defineProperty(exports,'clearAll',{enumerable:true,get:()=>clearAll});
Object.defineProperty(exports,'peekInbox',{enumerable:true,get:()=>peekInbox});
Object.defineProperty(exports,'removeInbox',{enumerable:true,get:()=>removeInbox});
Object.defineProperty(exports,'persist',{enumerable:true,get:()=>persist});
Object.defineProperty(exports,'estimate',{enumerable:true,get:()=>estimate});
};
__mods['js/ui.js'] = function(require,exports,module){
// Screen helpers: platform, icons, toasts with Undo, sheets (closable by button, backdrop, Esc and Back), clipboard, sharing, file picking.
const { esc } = require('js/util.js');

// ---------- platform ----------
const ua = navigator.userAgent || '';
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(ua);
const isStandalone = () => (window.matchMedia?.('(display-mode: standalone)').matches) || navigator.standalone === true;
function detectedLook() { return isIOS ? 'ios' : isAndroid ? 'android' : 'desktop'; }
function applyLook(pref = 'auto') {
  const look = pref === 'auto' ? detectedLook() : pref;
  const root = document.documentElement;
  root.classList.remove('plat-ios', 'plat-android', 'plat-desktop');
  root.classList.add(`plat-${look}`);
  root.dataset.look = look;
  return look;
}
function look() { return document.documentElement.dataset.look || 'ios'; }

// ---------- tiny DOM ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
function html(strings, ...vals) {
  return strings.reduce((out, s, i) => out + s + (i < vals.length ? (vals[i] && vals[i].__raw !== undefined ? vals[i].__raw : Array.isArray(vals[i]) ? vals[i].map(v => v && v.__raw !== undefined ? v.__raw : esc(v)).join('') : esc(vals[i])) : ''), '');
}
const raw = s => ({ __raw: String(s ?? '') });

// ---------- icons (simple stroke icons drawn for this app) ----------
const P = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5v-5h4v5"/>',
  hanger: '<path d="M12 7.5a2 2 0 1 1 2-2"/><path d="M12 7.5v1.2L3.5 15a1.6 1.6 0 0 0 1 2.9h15a1.6 1.6 0 0 0 1-2.9L12 8.7"/>',
  shuffle: '<path d="M3 7h3.5c4 0 6 10 10 10H21"/><path d="M3 17h3.5c1.6 0 2.8-1.4 3.8-3.2"/><path d="M13.7 10.2C14.7 8.4 15.9 7 17.5 7H21"/><path d="m18 4 3 3-3 3"/><path d="m18 14 3 3-3 3"/>',
  bookmark: '<path d="M6.5 3.5h11v17l-5.5-4-5.5 4z"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  camera: '<path d="M4 8h3l1.8-2.5h6.4L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m4 17 5-4.5 4 3.5 3-2.5 4.5 3.5"/>',
  paste: '<rect x="6" y="4.5" width="12" height="16" rx="2"/><path d="M9.5 4.5V3h5v1.5"/><path d="M9 11h6M9 15h4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  share: '<path d="M12 15V3.5"/><path d="m7.5 8 4.5-4.5L16.5 8"/><path d="M5 12v7.5h14V12"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5.5H4.5V6H10"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 13h9l1-13"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  star: '<path d="m12 3.8 2.5 5.2 5.6.7-4.1 3.9 1 5.6-5-2.7-5 2.7 1-5.6-4.1-3.9 5.6-.7z"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  pin: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  sparkle: '<path d="M12 3.5 13.8 10l6.2 2-6.2 2L12 20.5 10.2 14 4 12l6.2-2z"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
  more: '<circle cx="5.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.5" cy="12" r="1.4"/>',
  crop: '<path d="M7 3v14h14"/><path d="M3 7h14v14"/>',
  wand: '<path d="m4 20 11-11"/><path d="m14 5 1-2 1 2 2 1-2 1-1 2-1-2-2-1z"/><path d="M19 12.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/>',
  download: '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/>',
  upload: '<path d="M12 15V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M5 19.5h14"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.4"/>',
  warn: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v4.5M12 17v.4"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/>',
  layers: '<path d="m12 4 8.5 4.5L12 13 3.5 8.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5"/><path d="m3.5 16.5 8.5 4.5 8.5-4.5"/>',
  slider: '<path d="M12 3v18"/><path d="m8 9-3 3 3 3M16 9l3 3-3 3"/>',
  user: '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20.5c1.2-4 4-5.8 7.5-5.8s6.3 1.8 7.5 5.8"/>',
  bag: '<path d="M5 8h14l-1 12.5H6z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
  shield: '<path d="M12 3.5 19 6v5.5c0 4.3-3 7.5-7 9-4-1.5-7-4.7-7-9V6z"/>',
  refresh: '<path d="M19.5 8A8 8 0 1 0 20 13"/><path d="M20 4v4.5h-4.5"/>'
};
function icon(name, cls = '') {
  return raw(`<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${P[name] || P.info}</svg>`);
}

// ---------- toasts ----------
let toastTimer = null; let pendingUndo = null;
function toast(msg, { undo = null, action = null, ms = 6000, onExpire = null } = {}) {
  if (pendingUndo) { const p = pendingUndo; pendingUndo = null; try { p.onExpire?.(); } catch (e) { console.error(e); } } // the previous change becomes final
  const host = $('#toast');
  host.innerHTML = html`<div class="toast-in" role="status"><span>${msg}</span>${undo ? raw(`<button class="toast-btn" data-t="undo">${icon('undo').__raw}Undo</button>`) : ''}${action ? raw(`<button class="toast-btn" data-t="act">${esc(action.label)}</button>`) : ''}</div>`;
  // Informational toasts must not block taps on the app behind them. Only toasts with Undo/action are interactive.
  host.classList.toggle('interactive', Boolean(undo || action));
  host.classList.add('show');
  pendingUndo = undo || onExpire ? { undo, onExpire } : null;
  host.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.t === 'undo' && pendingUndo?.undo) { const u = pendingUndo.undo; pendingUndo = null; hideToast(); u(); }
    if (b.dataset.t === 'act' && action) { hideToast(); action.run(); }
  };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { hideToast(); finishUndo(); }, ms);
}
function hideToast() { const h = $('#toast'); if (h) { h.classList.remove('show'); h.classList.remove('interactive'); } clearTimeout(toastTimer); }
function finishUndo() {
  if (pendingUndo) {
    const p = pendingUndo; pendingUndo = null;
    if (p.undo) hideToast(); // the Undo button would no longer work
    try { p.onExpire?.(); } catch (e) { console.error(e); }
  }
}

// ---------- sheets ----------
const stack = []; let ignorePop = 0; let popWaiters = [];
function openSheet(content, { title = '', onClose = null, wide = false, full = false, label = '' } = {}) {
  const el = document.createElement('div');
  el.className = `sheet-wrap${full ? ' full' : ''}`;
  el.innerHTML = `<div class="sheet-backdrop" data-close="1"></div>
    <section class="sheet${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title || label || 'Panel')}">
      <header class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn sheet-x" data-close="1" aria-label="Close">${icon('close').__raw}</button></header>
      <div class="sheet-body"></div></section>`;
  const body = el.querySelector('.sheet-body');
  if (typeof content === 'string') body.innerHTML = content; else if (content) body.append(content);
  document.body.append(el);
  const entry = { el, onClose, prevFocus: document.activeElement };
  stack.push(entry);
  for (const bg of document.querySelectorAll('#view, #nav')) bg.inert = true;
  el.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(entry); });
  history.pushState({ sySheet: stack.length }, '', location.href);
  requestAnimationFrame(() => { el.classList.add('open'); const f = el.querySelector('[autofocus]') || el.querySelector('.sheet-x'); f?.focus({ preventScroll: true }); });
  document.body.classList.add('sheet-open');
  return { el, body, close: () => closeSheet(entry) };
}
function removeSheet(entry) {
  const i = stack.indexOf(entry); if (i < 0) return;
  stack.splice(i, 1);
  entry.el.classList.remove('open');
  entry.el.classList.add('closing');
  setTimeout(() => entry.el.remove(), 220);
  if (!stack.length) { document.body.classList.remove('sheet-open'); for (const bg of document.querySelectorAll('#view, #nav')) bg.inert = false; }
  try { entry.onClose?.(); } catch (e) { console.error(e); }
  try { entry.prevFocus?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
}
function closeSheet(entry = stack[stack.length - 1]) {
  if (!entry || !stack.includes(entry)) return Promise.resolve();
  removeSheet(entry);
  ignorePop++;
  return new Promise(res => { popWaiters.push(res); history.back(); setTimeout(() => { if (popWaiters.includes(res)) { popWaiters = popWaiters.filter(r => r !== res); ignorePop = Math.max(0, ignorePop - 1); res(); } }, 400); });
}
async function closeAllSheets() { while (stack.length) await closeSheet(); }
function sheetsOpen() { return stack.length; }
// The screen changed underneath (a link or app navigation): remove sheets without touching history.
function dropAllSheets() { while (stack.length) removeSheet(stack[stack.length - 1]); }
function hasPendingUndo() { return !!pendingUndo?.undo; }
// Called from the app's popstate handler. Returns true if the pop was used by a sheet.
function handlePop() {
  if (ignorePop > 0) { ignorePop--; const w = popWaiters.shift(); w?.(); return true; }
  if (stack.length) { removeSheet(stack[stack.length - 1]); return true; }
  return false;
}
document.addEventListener('keydown', e => {
  if (!stack.length) return;
  if (e.key === 'Escape') { closeSheet(); return; }
  if (e.key === 'Tab') {
    const top = stack[stack.length - 1]?.el;
    const focusable = top ? [...top.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(x => !x.hidden && x.offsetParent !== null) : [];
    if (!focusable.length) { e.preventDefault(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

// Confirm dialog as a sheet. Resolves true/false.
function confirmSheet({ title, text, ok = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise(resolve => {
    let done = false;
    const s = openSheet(html`<p class="lead">${text}</p><div class="btn-col"><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${ok}</button><button class="btn ghost" data-close="1">${cancel}</button></div>`,
      { title, onClose: () => { if (!done) { done = true; resolve(false); } } });
    s.body.querySelector('[data-ok]').onclick = async () => { done = true; await s.close(); resolve(true); };
  });
}

// ---------- clipboard ----------
async function copyText(text) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall back */ }
  try {
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.append(ta); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}
async function readClipboardText() {
  if (!navigator.clipboard?.readText) return { ok: false, reason: 'unsupported' };
  try { const t = await navigator.clipboard.readText(); return { ok: true, text: t || '' }; }
  catch (e) { return { ok: false, reason: e?.name === 'NotAllowedError' ? 'denied' : 'failed' }; }
}
async function readClipboardImage() {
  if (!navigator.clipboard?.read) return { ok: false, reason: 'unsupported' };
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) { const t = it.types.find(x => x.startsWith('image/')); if (t) return { ok: true, blob: await it.getType(t) }; }
    return { ok: false, reason: 'empty' };
  } catch (e) { return { ok: false, reason: e?.name === 'NotAllowedError' ? 'denied' : 'failed' }; }
}

// ---------- sharing out ----------
function canShareFiles(files) { try { return !!(navigator.canShare && navigator.share && navigator.canShare({ files })); } catch { return false; } }
async function shareFiles({ files = [], text = '', title = '' }) {
  if (files.length && canShareFiles(files)) {
    try { await navigator.share({ files, text, title }); return 'shared'; } catch (e) { return e?.name === 'AbortError' ? 'cancelled' : 'failed'; }
  }
  if (!files.length && navigator.share) { try { await navigator.share({ text, title }); return 'shared'; } catch (e) { return e?.name === 'AbortError' ? 'cancelled' : 'failed'; } }
  return 'unsupported';
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

// ---------- picking files ----------
function pickFiles({ accept = 'image/*', multiple = false, capture = null } = {}) {
  return new Promise(resolve => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = accept; inp.multiple = multiple;
    if (capture) inp.setAttribute('capture', capture);
    inp.style.cssText = 'position:fixed;left:-9999px;';
    let settled = false;
    inp.onchange = () => { settled = true; resolve([...(inp.files || [])]); inp.remove(); };
    inp.addEventListener('cancel', () => { if (!settled) { settled = true; resolve([]); inp.remove(); } });
    document.body.append(inp); inp.click();
  });
}

// ---------- AI apps ----------
const AI = {
  gemini: { name: 'Gemini', url: 'https://gemini.google.com/app' },
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/' }
};
function openAI(which) {
  const a = AI[which] || AI.gemini;
  // Note: window.open(..., 'noopener') always returns null, so detach the opener by hand instead.
  const w = window.open(a.url, '_blank');
  if (w) { try { w.opener = null; } catch { /* ignore */ } }
  else location.href = a.url; // pop-up blocked: open in the same tab (state is saved)
}

function vibrate(ms = 10) { try { navigator.vibrate?.(ms); } catch { /* ignore */ } }

// Share a file; if the phone refuses because time passed since the tap, show it with a fresh Share button.
async function shareOrOffer(file, text = '', title = 'Share') {
  if (canShareFiles([file])) {
    try { await navigator.share({ files: [file], text }); return 'shared'; }
    catch (e) { if (e?.name === 'AbortError') return 'cancelled'; }
  } else { download(file, file.name); toast('Saved to your downloads.', { ms: 3000 }); return 'downloaded'; }
  const url = URL.createObjectURL(file);
  const s = openSheet(`<img class="share-prev" src="${url}" alt="Preview"><div class="btn-col"><button class="btn primary" data-sh>Share</button><button class="btn secondary" data-dl>Save to phone</button></div>`, { title, onClose: () => URL.revokeObjectURL(url) });
  s.body.querySelector('[data-sh]').onclick = () => { navigator.share({ files: [file], text }).then(() => s.close(), e => { if (e?.name !== 'AbortError') toast('Sharing did not work. Use Save to phone.', { ms: 4000 }); }); };
  s.body.querySelector('[data-dl]').onclick = () => { download(file, file.name); s.close(); };
  return 'offered';
}
Object.defineProperty(exports,'isIOS',{enumerable:true,get:()=>isIOS});
Object.defineProperty(exports,'isAndroid',{enumerable:true,get:()=>isAndroid});
Object.defineProperty(exports,'isStandalone',{enumerable:true,get:()=>isStandalone});
Object.defineProperty(exports,'detectedLook',{enumerable:true,get:()=>detectedLook});
Object.defineProperty(exports,'applyLook',{enumerable:true,get:()=>applyLook});
Object.defineProperty(exports,'look',{enumerable:true,get:()=>look});
Object.defineProperty(exports,'$',{enumerable:true,get:()=>$});
Object.defineProperty(exports,'$$',{enumerable:true,get:()=>$$});
Object.defineProperty(exports,'html',{enumerable:true,get:()=>html});
Object.defineProperty(exports,'raw',{enumerable:true,get:()=>raw});
Object.defineProperty(exports,'icon',{enumerable:true,get:()=>icon});
Object.defineProperty(exports,'toast',{enumerable:true,get:()=>toast});
Object.defineProperty(exports,'finishUndo',{enumerable:true,get:()=>finishUndo});
Object.defineProperty(exports,'openSheet',{enumerable:true,get:()=>openSheet});
Object.defineProperty(exports,'closeSheet',{enumerable:true,get:()=>closeSheet});
Object.defineProperty(exports,'closeAllSheets',{enumerable:true,get:()=>closeAllSheets});
Object.defineProperty(exports,'sheetsOpen',{enumerable:true,get:()=>sheetsOpen});
Object.defineProperty(exports,'dropAllSheets',{enumerable:true,get:()=>dropAllSheets});
Object.defineProperty(exports,'hasPendingUndo',{enumerable:true,get:()=>hasPendingUndo});
Object.defineProperty(exports,'handlePop',{enumerable:true,get:()=>handlePop});
Object.defineProperty(exports,'confirmSheet',{enumerable:true,get:()=>confirmSheet});
Object.defineProperty(exports,'copyText',{enumerable:true,get:()=>copyText});
Object.defineProperty(exports,'readClipboardText',{enumerable:true,get:()=>readClipboardText});
Object.defineProperty(exports,'readClipboardImage',{enumerable:true,get:()=>readClipboardImage});
Object.defineProperty(exports,'canShareFiles',{enumerable:true,get:()=>canShareFiles});
Object.defineProperty(exports,'shareFiles',{enumerable:true,get:()=>shareFiles});
Object.defineProperty(exports,'download',{enumerable:true,get:()=>download});
Object.defineProperty(exports,'pickFiles',{enumerable:true,get:()=>pickFiles});
Object.defineProperty(exports,'AI',{enumerable:true,get:()=>AI});
Object.defineProperty(exports,'openAI',{enumerable:true,get:()=>openAI});
Object.defineProperty(exports,'vibrate',{enumerable:true,get:()=>vibrate});
Object.defineProperty(exports,'shareOrOffer',{enumerable:true,get:()=>shareOrOffer});
};
__mods['js/util.js'] = function(require,exports,module){
// Small shared helpers. Pure functions only (safe to import in Node tests).

function esc(v = '') {
  return String(v ?? '').replace(/[&<>'"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[m]));
}

function uid(prefix = '') {
  const r = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix + r;
}

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

// Local calendar date (not UTC) as YYYY-MM-DD.
function localISO(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Whole days from date string a to date string b (local, noon-anchored to dodge DST).
function daysBetween(a, b) {
  const da = new Date(`${a}T12:00:00`), db = new Date(`${b}T12:00:00`);
  return Math.round((db - da) / 864e5);
}

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localISO(d);
}

function prettyDate(iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  if (!iso) return '';
  try { return new Date(`${iso}T12:00:00`).toLocaleDateString('en-IN', opts); } catch { return iso; }
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 KB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function fmtINR(n) {
  if (!Number.isFinite(n)) return '';
  return '₹' + Math.round(n).toLocaleString('en-IN');
}

// Parse a price string like "₹1,299" or "Rs. 1299.00" -> 1299
function parsePrice(s) {
  if (s == null) return NaN;
  const m = String(s).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : NaN;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function greeting(h = new Date().getHours()) {
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function normalise(s = '') {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function plural(n, word, pluralWord) {
  return `${n} ${n === 1 ? word : (pluralWord || word + 's')}`;
}
Object.defineProperty(exports,'esc',{enumerable:true,get:()=>esc});
Object.defineProperty(exports,'uid',{enumerable:true,get:()=>uid});
Object.defineProperty(exports,'clone',{enumerable:true,get:()=>clone});
Object.defineProperty(exports,'localISO',{enumerable:true,get:()=>localISO});
Object.defineProperty(exports,'daysBetween',{enumerable:true,get:()=>daysBetween});
Object.defineProperty(exports,'addDays',{enumerable:true,get:()=>addDays});
Object.defineProperty(exports,'prettyDate',{enumerable:true,get:()=>prettyDate});
Object.defineProperty(exports,'fmtBytes',{enumerable:true,get:()=>fmtBytes});
Object.defineProperty(exports,'fmtINR',{enumerable:true,get:()=>fmtINR});
Object.defineProperty(exports,'parsePrice',{enumerable:true,get:()=>parsePrice});
Object.defineProperty(exports,'clamp',{enumerable:true,get:()=>clamp});
Object.defineProperty(exports,'greeting',{enumerable:true,get:()=>greeting});
Object.defineProperty(exports,'normalise',{enumerable:true,get:()=>normalise});
Object.defineProperty(exports,'plural',{enumerable:true,get:()=>plural});
};
__mods['js/views/aiflows.js'] = function(require,exports,module){
// Optional AI helpers around the wardrobe: improve today's outfit, judge 3 outfits, See it on me, label clothes, my colours.
const { state, save, mutate, go, today, itemById, availableNow, aiName, ui, isImageUsed } = require('js/app.js');
const store = require('js/store.js');
const { $, $$, html, raw, icon, toast, openSheet, pickFiles } = require('js/ui.js');
const { uid, plural } = require('js/util.js');
const { CAT, guessCategory, PATTERNS, FABRICS, PALETTE } = require('js/catalog.js');
const { dailyRequest, judgeRequest, seeItOnMeRequest, labelsRequest, coloursRequest, fixFormatRequest } = require('js/prompts.js');
const { wardrobeLines } = require('js/prompts.js');
const { parseCodeOutfits, parseLabels, parseColours } = require('js/parse.js');
const { contactSheet, shrink } = require('js/images.js');
const { guidedPhoto } = require('js/views/camera.js');
const { handoffHTML, wireHandoff, pasteHTML, wirePaste, pictureReturnHTML, wirePictureReturn, keepPicture, board, hydrate, woreThis, copyNow } = require('js/parts.js');

// ---------- looks made from wardrobe items ----------
function piecesFromIds(ids) {
  return ids.map(itemById).filter(Boolean).map(i => ({ name: i.name, category: CAT[i.category]?.label || '', owned: true, wardrobeId: i.id, code: i.code, hex: i.colour?.hex, thumb: i.photo?.thumb || null }));
}
function newLook(fields) {
  return { id: uid('l-'), source: 'mix', title: 'Look', occasion: '', sub: '', date: today(), number: null, why: '', pieces: [], products: [], pictures: {}, rating: null, starred: false, wornOn: null, createdAt: new Date().toISOString(), ...fields };
}
function saveMixAsLook(o, ctx = {}) {
  const look = newLook({ source: 'mix', title: o.title, why: o.why, occasion: ctx.label || '', pieces: piecesFromIds(o.ids) });
  mutate(s => { s.looks.unshift(look); }, { undo: 'Saved to My Looks' });
}

function recentText() {
  const d = new Set(); const out = [];
  for (const w of state.worn.slice().reverse()) { if (out.length > 12) break; if (Date.parse(w.date) >= Date.parse(today()) - 3 * 864e5) for (const id of w.itemIds || []) { const it = itemById(id); if (it && !d.has(id)) { d.add(id); out.push(it.code); } } }
  return out.join(', ');
}

// Shows the AI's code-based outfits with Wore this / Save buttons.
function codeOutfitsHTML(list, kind) {
  return raw(html`${list.map((o, i) => raw(html`<article class="outfit" data-i="${i}">${board(o.ids)}
    <h3>${kind === 'DAY' ? o.key : `Outfit ${i + 1}`}</h3>${o.why ? raw(html`<p>${o.why}</p>`) : ''}
    ${o.missing && !/^none\.?$/i.test(o.missing) ? raw(html`<p class="opt">Missing: ${o.missing}</p>`) : ''}
    ${o.unknown.length ? raw(html`<p class="warn">Ignored codes not in your wardrobe: ${o.unknown.join(', ')}</p>`) : ''}
    <div class="row"><button class="btn primary" data-wore ${raw(o.ids.length ? '' : 'disabled')}>${icon('check')}<span>Wore this</span></button><button class="btn secondary" data-save ${raw(o.ids.length ? '' : 'disabled')}>${icon('bookmark')}<span>Save</span></button></div></article>`))}`);
}
function wireCodeOutfits(root, list, label) {
  $$('.outfit', root).forEach(a => {
    const o = list[+a.dataset.i];
    $('[data-wore]', a).onclick = () => woreThis(o.ids, { baseIds: o.ids.filter(id => ['top', 'bottom', 'one'].includes(CAT[itemById(id)?.category]?.group)), mainId: o.ids[0] });
    $('[data-save]', a).onclick = () => saveMixAsLook({ ids: o.ids, title: `${label} ${o.key}`.trim(), why: o.why }, { label });
  });
  hydrate(root);
}

// ---------- Ask AI to improve today's outfit ----------
function askAIImprove(ctx, which = state.profile.defaultAI) {
  const avail = state.wardrobe.filter(w => w.status !== 'Archived' && availableNow(w));
  const text = dailyRequest({ label: ctx.label || ctx.dayType || 'Everyday', temp: ctx.temp, extras: ctx.extras }, state.profile, wardrobeLines(avail), recentText());
  const s = openSheet(html`<p class="lead">${aiName(which)} suggests 2 outfits using only your clothes.</p>
    ${handoffHTML({ text, which, after: ['Copy the reply and come back here.'] })}
    <hr>${pasteHTML({ label: 'Paste the reply' })}<div class="results"></div>`, { title: 'Ask AI to improve', full: true });
  wireHandoff(s.body, { text, onSwitch: w => { s.close().then(() => askAIImprove(ctx, w)); } });
  wirePaste(s.body, t => {
    const list = parseCodeOutfits(t, state.wardrobe, 'OUTFIT');
    const res = $('.results', s.body);
    if (!list.length) { res.innerHTML = html`<div class="card warn-card"><p>Couldn't find outfits in that text.</p><button class="btn secondary" data-fix>${icon('copy')}<span>Copy "please repeat in the right format"</span></button></div>`; $('[data-fix]', res).onclick = () => copyNow(fixFormatRequest('OUTFIT')).then(() => toast('Copied. Paste it in the same chat.', { ms: 3000 })); return; }
    res.innerHTML = codeOutfitsHTML(list, 'OUTFIT').__raw;
    wireCodeOutfits(res, list, 'AI outfit');
    res.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// ---------- my photo (for See it on me and My colours) ----------
async function myPhotoFile() {
  const id = state.profile.myPhoto || ui.tempMyPhoto || null;
  if (!id) return null;
  const b = await store.getImage(id);
  return b ? new File([b], 'my-photo.jpg', { type: b.type || 'image/jpeg' }) : null;
}
async function clearTempMyPhoto() {
  const id = ui.tempMyPhoto;
  ui.tempMyPhoto = null;
  if (id && id !== state.profile.myPhoto && !isImageUsed(id)) await store.deleteImage(id);
}
async function setMyPhoto(file) {
  const { blob, w, h } = await shrink(file, 1080, 0.85);
  const oldSaved = state.profile.myPhoto;
  const oldTemp = ui.tempMyPhoto;
  const id = state.profile.keepPhotos ? await store.putImage(blob, 'me', { w, h }) : await store.putTemporaryImage(blob, 'me-temp', { w, h });
  state.profile.myPhoto = state.profile.keepPhotos ? id : null;
  ui.tempMyPhoto = state.profile.keepPhotos ? null : id;
  save();
  for (const old of [oldSaved, oldTemp]) if (old && old !== id) setTimeout(() => { if (!isImageUsed(old)) store.deleteImage(old); }, 0);
  return id;
}
function photoStepHTML(have) {
  return raw(html`<div class="photo-step">${have ? raw(html`<div class="me-row"><img data-img="${have}" alt="Your photo" class="me-thumb"><div><b>Your full-length photo</b><button class="linkish" data-newphoto>Use a different photo</button></div></div>`)
    : raw(html`<p>Add a clear, full-length photo of yourself: standing, good light, plain background.</p><div class="btn-col"><button class="btn primary" data-newphoto>${icon('image')}<span>Choose a photo</span></button><button class="btn secondary" data-camera>${icon('camera')}<span>Take a guided photo</span></button></div>`)}</div>`);
}

function wirePhotoStep(s, reopen) {
  const use = async f => { if (!f) return; try { await setMyPhoto(f); } catch (e) { toast(e.message, { ms: 4000 }); return; } await s.close(); reopen(); };
  $('[data-newphoto]', s.body)?.addEventListener('click', async () => { const [f] = await pickFiles({ accept: 'image/*' }); use(f); });
  $('[data-camera]', s.body)?.addEventListener('click', async () => { const b = await guidedPhoto(); if (b) use(b); });
}

// ---------- See it on me (your photo + your exact clothes) ----------
// onPicture: when given, the picture is handed back (e.g. to fill a saved look) instead of making a new look.
async function seeItOnMe(ids, which = state.profile.defaultAI, { onPicture = null } = {}) {
  const items = ids.map(itemById).filter(Boolean).slice(0, 12);
  const entries = await Promise.all(items.map(async i => ({ code: i.code, name: i.name, hex: i.colour?.hex, blob: i.photo?.full ? await store.getImage(i.photo.full) : null })));
  const sheetBlob = await contactSheet(entries);
  const sheetFile = new File([sheetBlob], 'my-clothes.jpg', { type: 'image/jpeg' });
  const meFile = await myPhotoFile();
  const meId = meFile ? (state.profile.myPhoto || ui.tempMyPhoto) : null;
  const text = seeItOnMeRequest(items);
  const files = meFile ? [{ file: meFile, label: 'your photo' }, { file: sheetFile, label: 'the clothes sheet' }] : null;
  const s = openSheet(html`<p class="lead">${aiName(which)} edits your photo so you're wearing these exact clothes.</p>
    ${board(items.map(i => i.id))}
    <h3 class="step-h">1. Your photo</h3>${photoStepHTML(meId)}
    <h3 class="step-h">2. Send</h3>
    ${meFile ? handoffHTML({ text, which, files, sendLabel: `Send both pictures to ${aiName(which)}`, after: [`${aiName(which)} edits your photo. Bring the picture back below.`] }) : raw('<p class="muted">Add your photo first.</p>')}
    <h3 class="step-h">3. Bring the picture back</h3>${pictureReturnHTML(which)}`, { title: 'See it on me', full: true });
  hydrate(s.body);
  wirePhotoStep(s, () => seeItOnMe(ids, which, { onPicture }));
  wireHandoff(s.body, { text, files, onSwitch: w => s.close().then(() => seeItOnMe(ids, w, { onPicture })) });
  wirePictureReturn(s.body, async blob => {
    if (onPicture) { await s.close(); await clearTempMyPhoto(); onPicture(blob); return; }
    try {
      const pic = await keepPicture(blob, 'look');
      const look = newLook({ source: 'seeme', title: 'On me: ' + items.slice(0, 2).map(i => i.name).join(' + '), pieces: piecesFromIds(items.map(i => i.id)), pictures: { before: state.profile.myPhoto || null, after: pic.full, afterThumb: pic.thumb } });
      state.looks.unshift(look); save();
      await s.close(); await clearTempMyPhoto(); go(`look/${look.id}`);
      toast('Saved to My Looks', { ms: 2500 });
    } catch (e) { toast('That picture could not be used: ' + e.message, { ms: 5000 }); }
  });
}

// ---------- Ask AI to judge 3 outfits ----------
async function judgeThree(outfits, which = state.profile.defaultAI) {
  const ids = [...new Set(outfits.flatMap(o => o.ids))];
  const items = ids.map(itemById).filter(Boolean).slice(0, 12);
  const entries = await Promise.all(items.map(async i => ({ code: i.code, name: i.name, hex: i.colour?.hex, blob: i.photo?.full ? await store.getImage(i.photo.full) : null })));
  const sheetBlob = await contactSheet(entries);
  const files = [{ file: new File([sheetBlob], 'my-clothes.jpg', { type: 'image/jpeg' }), label: 'the clothes sheet' }];
  const text = judgeRequest(outfits.map(o => ({ codes: o.ids.map(id => itemById(id)?.code).filter(Boolean) })), state.profile);
  const s = openSheet(html`<p class="lead">${aiName(which)} looks at a picture of your clothes and picks the best outfit.</p>
    ${ids.length > 12 ? raw('<p class="warn">Only the first 12 pieces fit on one sheet.</p>') : ''}
    ${handoffHTML({ text, which, files, sendLabel: `Send to ${aiName(which)}`, after: ['Copy the reply and come back here.'] })}
    <hr>${pasteHTML()}<div class="results"></div>`, { title: 'Ask AI to judge', full: true });
  wireHandoff(s.body, { text, files, onSwitch: w => s.close().then(() => judgeThree(outfits, w)) });
  wirePaste(s.body, t => {
    const list = parseCodeOutfits(t, state.wardrobe, 'OUTFIT');
    const res = $('.results', s.body);
    if (!list.length) { res.innerHTML = '<div class="card warn-card"><p>Couldn\'t find outfits in that text. Ask the AI to repeat them in the STYLEYOU format.</p></div>'; return; }
    res.innerHTML = html`<p class="muted">Ranked by ${aiName(which)}, best first.</p>${codeOutfitsHTML(list, 'OUTFIT')}`;
    wireCodeOutfits(res, list, 'Judged');
  });
}

// ---------- Label clothes with AI (contact sheets of up to 12) ----------
async function labelWithAI(allIds, which = state.profile.defaultAI, part = 0) {
  const chunks = []; for (let i = 0; i < allIds.length; i += 12) chunks.push(allIds.slice(i, i + 12));
  if (!chunks.length) { toast('Choose some clothes first', { ms: 2500 }); return; }
  const ids = chunks[part]; const items = ids.map(itemById).filter(Boolean);
  const entries = await Promise.all(items.map(async i => ({ code: i.code, name: i.name, hex: i.colour?.hex, blob: i.photo?.full ? await store.getImage(i.photo.full) : null })));
  const sheetBlob = await contactSheet(entries);
  const files = [{ file: new File([sheetBlob], `style-you-sheet-${part + 1}.jpg`, { type: 'image/jpeg' }), label: 'the clothes sheet' }];
  const text = labelsRequest(items.map(i => i.code));
  const s = openSheet(html`${chunks.length > 1 ? raw(html`<p class="eyebrow">Sheet ${part + 1} of ${chunks.length}</p>`) : ''}
    <p class="lead">${aiName(which)} reads a picture of ${plural(items.length, 'piece')} and suggests category, pattern, fabric and formality. You review before anything changes.</p>
    <div class="sheet-prev"><img alt="Clothes sheet" class="sheetimg"></div>
    ${handoffHTML({ text, which, files, sendLabel: `Send sheet to ${aiName(which)}`, after: ['Copy the reply and come back here.'] })}
    <hr>${pasteHTML()}<div class="results"></div>`, { title: 'Label with AI', full: true });
  const u = URL.createObjectURL(sheetBlob); $('.sheetimg', s.body).src = u;
  wireHandoff(s.body, { text, files, onSwitch: w => s.close().then(() => labelWithAI(allIds, w, part)) });
  wirePaste(s.body, t => {
    const { labels, unknown } = parseLabels(t, items);
    const res = $('.results', s.body);
    if (!labels.length) { res.innerHTML = '<div class="card warn-card"><p>No labels found for these codes. Make sure you pasted the reply for this sheet.</p></div>'; return; }
    res.innerHTML = html`<h3>Review</h3>${unknown.length ? raw(html`<p class="warn">Ignored codes not on this sheet: ${unknown.join(', ')}</p>`) : ''}
      <ul class="review">${labels.map((l, i) => { const it = itemById(l.id); const cat = guessCategory(l.category); return raw(html`<li><label class="check"><input type="checkbox" data-l="${i}" checked><span><b>${it.code}</b> ${it.name}</span></label>
        <p class="muted">${[cat !== 'other' ? CAT[cat].label : l.category, l.colour, l.pattern, l.fabric !== 'Unknown' ? l.fabric : '', l.formality ? `formality ${l.formality}/5` : ''].filter(Boolean).join(' · ')}</p></li>`); })}</ul>
      <button class="btn primary big" data-apply>Apply ticked labels</button>`;
    $('[data-apply]', res).onclick = async () => {
      const pick = $$('[data-l]', res).filter(c => c.checked).map(c => labels[+c.dataset.l]);
      mutate(st => {
        for (const l of pick) {
          const it = st.wardrobe.find(w => w.id === l.id); if (!it) continue;
          const cat = guessCategory(l.category); if (cat !== 'other') it.category = cat;
          const pc = PALETTE.find(([n]) => n.toLowerCase() === String(l.colour).trim().toLowerCase());
          if (pc && it.colour?.source !== 'user') it.colour = { hex: pc[1], name: pc[0], source: 'ai' };
          const pat = PATTERNS.find(p => p.toLowerCase() === String(l.pattern).toLowerCase()); if (pat) it.pattern = pat;
          const fw = String(l.fabric || '').trim().toLowerCase().split(/[ /]/)[0];
          const fab = fw && fw !== 'unknown' ? FABRICS.find(f => f.toLowerCase().split(/[ /]/).includes(fw) || f.toLowerCase().startsWith(fw)) : null; if (fab) it.fabric = fab;
          if (l.formality) it.formality = l.formality;
          if (l.occasions?.length) it.occasions = l.occasions.slice(0, 8);
        }
      }, { undo: `Labels applied to ${plural(pick.length, 'piece')}` });
      await s.close(); URL.revokeObjectURL(u);
      if (part + 1 < chunks.length) labelWithAI(allIds, which, part + 1);
    };
  });
}

// ---------- My colours ----------
async function myColours(which = state.profile.defaultAI) {
  const meFile = await myPhotoFile();
  const meId = meFile ? (state.profile.myPhoto || ui.tempMyPhoto) : null;
  const text = coloursRequest(state.profile);
  const files = meFile ? [{ file: meFile, label: 'your photo' }] : null;
  const c = state.profile.colours;
  const s = openSheet(html`<p class="lead">A one-time list of colours that suit you, reused in every request. Nothing is said about your skin tone.</p>
    ${c ? raw(html`<p><b>Good:</b> ${c.good.join(', ')}</p><p><b>Use carefully:</b> ${c.careful.join(', ')}</p>`) : ''}
    <h3 class="step-h">1. Your photo</h3>${photoStepHTML(meId)}
    ${meFile ? raw(html`<h3 class="step-h">2. Send</h3>${handoffHTML({ text, which, files, sendLabel: `Send photo to ${aiName(which)}`, after: ['Copy the reply and come back here.'] })}<hr>${pasteHTML()}`) : ''}
    ${c ? raw('<button class="btn ghost danger-text" data-clear>Remove my colours</button>') : ''}`, { title: 'My colours', full: true });
  hydrate(s.body);
  wirePhotoStep(s, () => myColours(which));
  wireHandoff(s.body, { text, files, onSwitch: w => s.close().then(() => myColours(w)) });
  wirePaste(s.body, async t => {
    const r = parseColours(t);
    if (!r) { toast('Couldn\'t find the colour list. Ask the AI to repeat it in the STYLEYOU format.', { ms: 5000 }); return; }
    mutate(st => { st.profile.colours = r; }, { undo: 'My colours saved' });
    await s.close();
    await clearTempMyPhoto();
  });
  $('[data-clear]', s.body)?.addEventListener('click', async () => { mutate(st => { st.profile.colours = null; }, { undo: 'My colours removed' }); await s.close(); await clearTempMyPhoto(); });
}
Object.defineProperty(exports,'piecesFromIds',{enumerable:true,get:()=>piecesFromIds});
Object.defineProperty(exports,'newLook',{enumerable:true,get:()=>newLook});
Object.defineProperty(exports,'saveMixAsLook',{enumerable:true,get:()=>saveMixAsLook});
Object.defineProperty(exports,'askAIImprove',{enumerable:true,get:()=>askAIImprove});
Object.defineProperty(exports,'myPhotoFile',{enumerable:true,get:()=>myPhotoFile});
Object.defineProperty(exports,'setMyPhoto',{enumerable:true,get:()=>setMyPhoto});
Object.defineProperty(exports,'clearTempMyPhoto',{enumerable:true,get:()=>clearTempMyPhoto});
Object.defineProperty(exports,'seeItOnMe',{enumerable:true,get:()=>seeItOnMe});
Object.defineProperty(exports,'judgeThree',{enumerable:true,get:()=>judgeThree});
Object.defineProperty(exports,'labelWithAI',{enumerable:true,get:()=>labelWithAI});
Object.defineProperty(exports,'myColours',{enumerable:true,get:()=>myColours});
};
__mods['js/views/camera.js'] = function(require,exports,module){
// Guided full-length photo: camera with a body outline and a self-timer. Falls back to the phone's own camera picker.
const { $, html, raw, icon, openSheet, pickFiles } = require('js/ui.js');
const { toBlob } = require('js/images.js');

const OUTLINE = `<svg class="outline" viewBox="0 0 100 200" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
  <g fill="none" stroke="#fff" stroke-width="1.2" stroke-dasharray="3 2" opacity=".9">
  <ellipse cx="50" cy="24" rx="10" ry="12"/><path d="M38 40c-8 2-13 6-14 14l-4 46M62 40c8 2 13 6 14 14l4 46M38 40h24M36 56l-2 50h32l-2-50M40 106l-3 86M60 106l3 86M50 112v80"/></g>
  <rect x="2" y="2" width="96" height="196" rx="4" fill="none" stroke="#fff" stroke-opacity=".35"/></svg>`;

function guidedPhoto() {
  return new Promise(async resolve => {
    if (!navigator.mediaDevices?.getUserMedia) { const [f] = await pickFiles({ accept: 'image/*', capture: 'user' }); return resolve(f || null); }
    let stream = null, facing = 'user', done = false, timer = null;
    const s = openSheet(html`<div class="cam">
      <div class="cam-stage"><video playsinline muted autoplay></video>${raw(OUTLINE)}<div class="cam-count" hidden></div><img class="cam-shot" alt="Your photo" hidden></div>
      <p class="muted center cam-tip">Stand back so your whole body fits the outline. Good light, plain background.</p>
      <div class="row center cam-ctl">
        <button class="btn secondary" data-flip aria-label="Switch camera">${icon('refresh')}<span>Flip</span></button>
        <button class="btn primary big" data-snap data-sec="3">${icon('camera')}<span>3-second timer</span></button>
        <button class="btn secondary" data-snap data-sec="10"><span>10 s</span></button></div>
      <div class="row center cam-after" hidden><button class="btn secondary" data-retake>Retake</button><button class="btn primary" data-use>${icon('check')}<span>Use photo</span></button></div>
    </div>`, { title: 'Guided photo', full: true, onClose: () => { stop(); clearInterval(timer); if (!done) { done = true; resolve(null); } } });
    const v = $('video', s.body), shot = $('.cam-shot', s.body), cnt = $('.cam-count', s.body);
    let blob = null;
    function stop() { stream?.getTracks().forEach(t => t.stop()); stream = null; }
    async function start() {
      stop();
      try {
        const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        if (done) { st.getTracks().forEach(t => t.stop()); return; } // the sheet was closed while asking for permission
        stream = st;
        v.srcObject = stream; await v.play().catch(() => {});
      } catch (e) {
        // A new tap is needed to open the phone's own camera, so offer a button.
        $('.cam', s.body).innerHTML = html`<div class="card warn-card"><p>${e?.name === 'NotAllowedError' ? 'Camera permission was declined.' : 'The camera is not available here.'} You can use your phone's own camera instead.</p>
          <button class="btn primary" data-native>${icon('camera')}<span>Open phone camera</span></button></div>`;
        $('[data-native]', s.body).onclick = async () => { const [f] = await pickFiles({ accept: 'image/*', capture: 'user' }); if (!f) return; done = true; await s.close(); resolve(f); };
      }
    }
    await start();
    if (!stream) return;
    $('[data-flip]', s.body).onclick = () => { facing = facing === 'user' ? 'environment' : 'user'; start(); };
    s.body.querySelectorAll('[data-snap]').forEach(b => b.onclick = () => {
      let n = +b.dataset.sec; cnt.hidden = false; cnt.textContent = n;
      clearInterval(timer);
      timer = setInterval(async () => {
        n--; cnt.textContent = n;
        if (n > 0) return;
        clearInterval(timer); cnt.hidden = true;
        const cv = document.createElement('canvas'); cv.width = v.videoWidth || 1080; cv.height = v.videoHeight || 1920;
        const ctx = cv.getContext('2d');
        if (facing === 'user') { ctx.translate(cv.width, 0); ctx.scale(-1, 1); }
        ctx.drawImage(v, 0, 0, cv.width, cv.height);
        blob = await toBlob(cv, 'image/jpeg', 0.9);
        shot.src = URL.createObjectURL(blob); shot.hidden = false;
        $('.cam-ctl', s.body).hidden = true; $('.cam-after', s.body).hidden = false;
      }, 1000);
    });
    $('[data-retake]', s.body).onclick = () => { shot.hidden = true; URL.revokeObjectURL(shot.src); blob = null; $('.cam-ctl', s.body).hidden = false; $('.cam-after', s.body).hidden = true; };
    $('[data-use]', s.body).onclick = async () => { done = true; const b = blob; await s.close(); resolve(b); };
  });
}
Object.defineProperty(exports,'guidedPhoto',{enumerable:true,get:()=>guidedPhoto});
};
__mods['js/views/common.js'] = function(require,exports,module){
// Pieces shared by several screens: page header, city search, weather.
const { state, save, today } = require('js/app.js');
const { $, $$, html, raw, icon, toast } = require('js/ui.js');
const { searchPlaces, forecastFor, currentPosition } = require('js/weather.js');
const { TEMPS, EXTRAS } = require('js/catalog.js');

function pageHead(title, { back = null, sub = '', actions = '' } = {}) {
  return raw(html`<header class="page-head">
    ${back ? raw(html`<a class="back" href="${back}" aria-label="Back">${icon('back')}<span>Back</span></a>`) : ''}
    <div class="ph-row"><h1>${title}</h1><div class="ph-act">${raw(actions)}<a class="icon-btn settings-link" href="#/settings" aria-label="Settings">${icon('gear')}</a></div></div>
    ${sub ? raw(html`<p class="sub">${sub}</p>`) : ''}</header>`);
}

// ---------- city search ----------
function citySearchHTML(city) {
  return raw(html`<div class="city">
    <div class="city-chosen" ${raw(city ? '' : 'hidden')}>${icon('pin')}<span class="city-name">${city?.name || ''}</span><button type="button" class="linkish" data-change>Change</button></div>
    <div class="city-find" ${raw(city ? 'hidden' : '')}>
      <label class="field"><span>Search for your city</span><input type="search" class="city-q" autocomplete="off" placeholder="e.g. Navi Mumbai" maxlength="60"></label>
      <div class="city-res" role="listbox" aria-label="Places"></div>
      <button type="button" class="btn secondary" data-here>${icon('pin')}<span>Use my current location</span></button>
    </div></div>`);
}
function wireCitySearch(root, onPick) {
  const c = $('.city', root); if (!c) return;
  const q = $('.city-q', c), res = $('.city-res', c), chosen = $('.city-chosen', c), find = $('.city-find', c);
  let t = null, seq = 0;
  const pick = city => {
    $('.city-name', c).textContent = city.name; chosen.hidden = false; find.hidden = true; res.innerHTML = '';
    onPick(city);
  };
  $('[data-change]', c).onclick = () => { chosen.hidden = true; find.hidden = false; q.value = ''; q.focus(); onPick(null); };
  q.addEventListener('input', () => {
    clearTimeout(t);
    const v = q.value.trim();
    if (v.length < 2) { res.innerHTML = ''; return; }
    t = setTimeout(async () => {
      const my = ++seq;
      res.innerHTML = '<p class="muted">Searching…</p>';
      try {
        const list = await searchPlaces(v);
        if (my !== seq) return;
        res.innerHTML = list.length ? list.map((p, i) => html`<button type="button" class="city-opt" role="option" data-i="${i}">${icon('pin')}<span>${p.name}</span></button>`).join('')
          : '<p class="muted">No place found with that name. Check the spelling.</p>';
        $$('.city-opt', res).forEach(b => b.onclick = () => { const p = list[+b.dataset.i]; pick({ name: p.name, short: p.short, lat: p.lat, lon: p.lon }); });
      } catch {
        if (my === seq) res.innerHTML = `<p class="muted">Couldn't search right now${navigator.onLine === false ? ' — you seem to be offline' : ''}. Try again, or skip for now.</p>`;
      }
    }, 350);
  });
  $('[data-here]', c).onclick = async () => {
    const b = $('[data-here]', c); b.disabled = true; b.querySelector('span').textContent = 'Finding you…';
    try { const pos = await currentPosition(); pick({ name: 'My current location', short: 'My location', lat: Math.round(pos.lat * 100) / 100, lon: Math.round(pos.lon * 100) / 100 }); }
    catch (e) { toast(e?.code === 1 ? 'Location permission was declined. Search for your city instead.' : 'Could not find your location. Search for your city instead.', { ms: 5000 }); }
    finally { b.disabled = false; b.querySelector('span').textContent = 'Use my current location'; }
  };
}

// ---------- weather ----------
// Today's weather for the saved city: cached for 3 hours, manual choice wins for the day.
async function todayWeather({ force = false } = {}) {
  const st = state.settings; const d = today();
  if (st.manualWeather?.date === d) return { ...st.manualWeather, status: 'manual', summary: 'Chosen by you' };
  const c = state.profile.city;
  if (!c) return { status: 'none' };
  const key = `${c.lat},${c.lon},${d}`;
  if (!force && st.weather?.key === key && Date.now() - st.weather.at < 3 * 3600e3) return st.weather.data;
  try {
    const data = await forecastFor(c.lat, c.lon, d);
    st.weather = { key, at: Date.now(), data }; save();
    return data;
  } catch {
    if (st.weather?.key === key) return { ...st.weather.data, stale: true };
    return { status: 'error' };
  }
}
function weatherLabel(w) {
  if (!w || ['none', 'error', 'far', 'past'].includes(w.status)) return '';
  return [w.temp, ...(w.extras || [])].filter(Boolean).join(' · ');
}

// Multi-select conditions: one temperature + any extras.
function weatherPickerHTML(sel = {}) {
  return raw(html`<div class="wpick">
    <div class="chips" role="group" aria-label="Temperature">${TEMPS.map(t => raw(html`<button class="chip${sel.temp === t ? ' on' : ''}" aria-pressed="${sel.temp === t}" data-temp="${t}">${t}</button>`))}</div>
    <div class="chips" role="group" aria-label="Also">${EXTRAS.map(t => raw(html`<button class="chip${(sel.extras || []).includes(t) ? ' on' : ''}" aria-pressed="${(sel.extras || []).includes(t)}" data-extra="${t}">${t}</button>`))}</div></div>`);
}
function wireWeatherPicker(root, sel, onChange) {
  const w = $('.wpick', root); if (!w) return;
  w.addEventListener('click', e => {
    const t = e.target.closest('[data-temp]'), x = e.target.closest('[data-extra]');
    if (t) { sel.temp = sel.temp === t.dataset.temp ? null : t.dataset.temp; }
    if (x) { const v = x.dataset.extra; sel.extras = (sel.extras || []).includes(v) ? sel.extras.filter(z => z !== v) : [...(sel.extras || []), v]; }
    if (!t && !x) return;
    $$('[data-temp]', w).forEach(b => { const on = b.dataset.temp === sel.temp; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    $$('[data-extra]', w).forEach(b => { const on = (sel.extras || []).includes(b.dataset.extra); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    onChange({ temp: sel.temp, extras: sel.extras || [] });
  });
}

const CREDIT = raw('<a class="credit" href="https://open-meteo.com/" target="_blank" rel="noopener">Weather data by Open-Meteo.com</a>');
Object.defineProperty(exports,'pageHead',{enumerable:true,get:()=>pageHead});
Object.defineProperty(exports,'citySearchHTML',{enumerable:true,get:()=>citySearchHTML});
Object.defineProperty(exports,'wireCitySearch',{enumerable:true,get:()=>wireCitySearch});
Object.defineProperty(exports,'todayWeather',{enumerable:true,get:()=>todayWeather});
Object.defineProperty(exports,'weatherLabel',{enumerable:true,get:()=>weatherLabel});
Object.defineProperty(exports,'weatherPickerHTML',{enumerable:true,get:()=>weatherPickerHTML});
Object.defineProperty(exports,'wireWeatherPicker',{enumerable:true,get:()=>wireWeatherPicker});
Object.defineProperty(exports,'CREDIT',{enumerable:true,get:()=>CREDIT});
};
__mods['js/views/create.js'] = function(require,exports,module){
// Create hub: one deliberate place to start a new styling task on every platform.
const { route } = require('js/app.js');
const { html, icon } = require('js/ui.js');
const { pageHead } = require('js/views/common.js');

route('create', el => {
  el.innerHTML = html`<div class="page create-hub">${pageHead('Create', { sub: 'Choose what you want Style You to do.' })}
    <div class="create-choices">
      <a class="create-choice primary-choice" href="#/session/new">${icon('sparkle')}<div><b>Style me for an occasion</b><span>Build 3 looks, resolve missing pieces, then create an AI styled preview.</span></div>${icon('chevron')}</a>
      <a class="create-choice" href="#/mix">${icon('shuffle')}<div><b>Create from my wardrobe</b><span>Smart combinations from the clothes you already own — works offline.</span></div>${icon('chevron')}</a>
      <a class="create-choice" href="#/week">${icon('calendar')}<div><b>Plan my week</b><span>Build a practical week of outfits with repeat control.</span></div>${icon('chevron')}</a>
    </div>
    <p class="muted small create-note">AI is optional for wardrobe combinations. Occasion previews use your own Gemini or ChatGPT.</p>
  </div>`;
});

};
__mods['js/views/home.js'] = function(require,exports,module){
// Today: weather, today's outfits from the user's own wardrobe, Continue, and starting points.
const { state, save, route, go, ui, today, itemsActive, activeSessions, backupDue, photosAtRisk } = require('js/app.js');
const store = require('js/store.js');
const { $, $$, html, raw, icon, toast, openSheet } = require('js/ui.js');
const { greeting, prettyDate, addDays } = require('js/util.js');
const { suggest, wardrobeReady } = require('js/engine.js');
const { DAY_TYPES } = require('js/catalog.js');
const { board, hydrate, woreThis, empty } = require('js/parts.js');
const { todayWeather, weatherLabel, weatherPickerHTML, wireWeatherPicker, CREDIT } = require('js/views/common.js');
const { askAIImprove, seeItOnMe, saveMixAsLook } = require('js/views/aiflows.js');
const { exportBackup } = require('js/views/settings.js');
const { laundryBack } = require('js/views/wardrobe.js');

function defaultDayType() {
  const d = new Date().getDay();
  return state.settings.dayTypeFor?.[today()] || (d === 0 || d === 6 ? 'casual' : 'work');
}

route('home', async el => {
  const p = state.profile;
  const name = p.name ? `, ${p.name}` : '';
  const sessions = activeSessions();
  const items = itemsActive();
  const ready = wardrobeReady(items, today());
  const dayType = defaultDayType();
  const loggedToday = state.worn.filter(w => w.date === today());
  const inLaundry = state.wardrobe.filter(w => w.status === 'Laundry').length;

  el.innerHTML = html`<div class="page home">
    <header class="page-head home-head">
      <div class="ph-row"><div><p class="eyebrow">${prettyDate(today(), { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      <h1>${greeting()}${name}</h1></div></div>
      <button class="weather-line" data-weather aria-label="Weather — tap to change">${icon('sun')}<span class="wl-text">${p.city ? p.city.short || p.city.name : 'Set your city for weather'}</span></button>
      <nav class="quick-links" aria-label="Shortcuts"><a class="quick" href="#/mix">${icon('shuffle')}<span>Mix &amp; Match</span></a><a class="quick" href="#/week">${icon('calendar')}<span>Plan my week</span></a></nav>
    </header>
    ${backupDue() ? raw(html`<div class="card tip-card">${icon('shield')}<div><b>Time for a backup</b><p>Saves your clothes, photos and looks to one file you can keep in Files, iCloud Drive or another secure location.</p><div class="row"><button class="btn small primary" data-backup>Back up now</button><button class="btn small ghost" data-snooze>Later</button></div></div></div>`) : ''}
    ${sessions.map(s => raw(html`<a class="card continue" href="#/session/${s.id}"><div class="ring" style="--p:${Math.round(100 * (s.stepIndex || 0) / 6)}"><span>${(s.stepIndex || 0) + 1}/7</span></div><div><b>Continue: ${s.title || 'Occasion'}</b><p>Next: ${s.nextLabel || 'carry on'}</p></div>${icon('chevron')}</a>`))}

    <section class="card today" aria-labelledby="today-h">
      <div class="card-head"><h2 id="today-h">Today's outfit</h2><span class="muted">from your wardrobe</span></div>
      <div class="chips scroll" role="group" aria-label="Kind of day">${DAY_TYPES.map(d => raw(html`<button class="chip${d.id === dayType ? ' on' : ''}" aria-pressed="${d.id === dayType}" data-day="${d.id}">${d.label}</button>`))}</div>
      <div class="today-body">${ready ? raw('<div class="skeleton board-sk"></div>') : empty(items.length ? 'Almost there' : 'Add a few clothes first', items.length ? 'Add at least one top and one bottom, or one full outfit like a dress or kurta set.' : 'Add the 15 things you wear most and Style You will put outfits together every day — even offline.', html`<a class="btn primary" href="#/add">${icon('plus')}<span>Add clothes</span></a>`)}</div>
      ${loggedToday.length ? raw(html`<p class="muted small">Logged today: ${loggedToday.length === 1 ? 'one outfit' : loggedToday.length + ' outfits'}.</p>`) : ''}
      ${inLaundry ? raw(html`<div class="laundry-bar inline"><span class="muted small">${inLaundry === 1 ? '1 piece is' : `${inLaundry} pieces are`} in the laundry</span><button class="btn small secondary" data-laundryback>Laundry's back (${inLaundry})</button></div>`) : ''}
    </section>
    ${photosAtRisk() && !state.settings.homeScreenTipDismissed ? raw(html`<div class="card tip-card">${icon('phone')}<div><b>Keep your wardrobe safer</b><p>Add Style You to your Home Screen for more durable photo storage on iPhone.</p><button class="linkish" data-howto>Show me how</button></div><button class="icon-btn" data-dismiss aria-label="Hide">${icon('close')}</button></div>`) : ''}

    <p class="eyebrow">For an event or occasion</p>
    <div class="starts home-occasion">
      <a class="start" href="#/session/new">${icon('sparkle')}<div><b>Style me for an occasion</b><span>3 looks, missing products when needed, then your AI styled preview</span></div>${icon('chevron')}</a>
    </div>
    <p class="foot">${CREDIT}</p>
  </div>`;

  $('[data-dismiss]', el)?.addEventListener('click', () => { state.settings.homeScreenTipDismissed = true; save(); go('home'); });
  $('[data-howto]', el)?.addEventListener('click', () => openSheet(html`<ol class="steps"><li>Tap the <b>Share</b> button at the bottom of Safari.</li><li>Scroll and tap <b>Add to Home Screen</b>, then <b>Add</b>.</li><li>Open Style You from the new icon. It keeps its own storage, separate from Safari. Everything still lives only on this phone, so keep a backup too.</li></ol>`, { title: 'Add to Home Screen' }));
  $('[data-backup]', el)?.addEventListener('click', () => exportBackup());
  $('[data-laundryback]', el)?.addEventListener('click', () => laundryBack());
  $('[data-snooze]', el)?.addEventListener('click', () => { state.settings.backupSnoozeUntil = addDays(today(), 3); save(); go('home'); });
  $$('[data-day]', el).forEach(b => b.addEventListener('click', () => {
    state.settings.dayTypeFor = { [today()]: b.dataset.day }; save(); ui.todayPage = 0; go('home');
  }));

  // Weather (may be slow or offline) then outfits.
  const seq = ui.seq;
  const w = await todayWeather();
  if (seq !== ui.seq) return;
  const wl = $('.wl-text', el);
  const lbl = weatherLabel(w);
  if (wl) {
    if (w.status === 'ok' || w.status === 'manual') wl.textContent = `${p.city ? (p.city.short || p.city.name) + ' · ' : ''}${w.maxT != null && w.status === 'ok' ? Math.round(w.maxT) + '° · ' : ''}${lbl}${w.stale ? ' (earlier today)' : ''}`;
    else if (w.status === 'error') wl.textContent = 'Weather unavailable — tap to choose';
  }
  $('[data-weather]', el).onclick = () => weatherSheet(w);
  if (ready) renderToday(el, w, dayType);
});

function renderToday(el, w, dayType) {
  const box = $('.today-body', el); if (!box) return;
  const ctx = { dayType, temp: w?.temp || null, extras: w?.extras || [], avoidColours: state.profile.avoidColours, count: 12, style: state.settings.mixStyle || 'fusion' };
  const t0 = performance.now();
  const r = suggest(state.wardrobe, state.worn, state.sets, ctx, today());
  ui.lastTodayMs = performance.now() - t0;
  const n = r.outfits.length;
  if (!n) { box.innerHTML = empty('No outfit fits today', r.notes.join(' ') || 'Everything suitable is in the laundry or marked unavailable. Try another kind of day.').__raw; return; }
  const page = (ui.todayPage || 0) % Math.max(1, Math.ceil(n / 2));
  const shown = r.outfits.slice(page * 2, page * 2 + 2);
  box.innerHTML = html`${shown.map((o, i) => raw(html`<article class="outfit" data-i="${i}">
      ${board(o.ids, { missing: o.missing })}
      <h3>${o.title}</h3><p>${o.why}${o.recent ? ' Worn recently — there were no other options.' : ''}</p>
      <p class="opt">${o.coverage}</p>
      <div class="row"><button class="btn primary" data-wore>${icon('check')}<span>Wore this</span></button><button class="btn secondary" data-more aria-label="More options">${icon('more')}</button></div>
    </article>`))}
    <p class="opt">Optimising for: ${r.optimisingFor}</p>
    <div class="row center"><button class="btn ghost" data-another>${icon('refresh')}<span>Another</span></button></div>`;
  hydrate(box);
  $$('.outfit', box).forEach(a => {
    const o = shown[+a.dataset.i];
    $('[data-wore]', a).onclick = () => woreThis(o.ids, { baseIds: o.baseIds, mainId: o.mainId });
    $('[data-more]', a).onclick = () => outfitMenu(o, ctx);
  });
  $('[data-another]', box).onclick = () => {
    ui.todayPage = page + 1;
    if ((page + 1) * 2 >= n) { ui.todayPage = 0; toast('Those are all the good options for today — starting again.', { ms: 3000 }); }
    renderToday(el, w, dayType);
  };
}

function outfitMenu(o, ctx) {
  const s = openSheet(html`<div class="menu">
    <button data-a="improve">${icon('wand')}<span>Ask AI to improve</span></button>
    <button data-a="seeme">${icon('user')}<span>See it on me</span></button>
    <button data-a="save">${icon('bookmark')}<span>Save as a look</span></button>
    <button data-a="mix">${icon('shuffle')}<span>Open in Mix & Match</span></button></div>`, { title: o.title });
  s.body.addEventListener('click', async e => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    await s.close();
    if (a === 'improve') askAIImprove(ctx);
    if (a === 'seeme') seeItOnMe(o.ids);
    if (a === 'save') saveMixAsLook(o, ctx);
    if (a === 'mix') go(`mix/around/${o.mainId}`);
  });
}

function weatherSheet(w) {
  const sel = { temp: state.settings.manualWeather?.date === today() ? state.settings.manualWeather.temp : w?.temp || null, extras: state.settings.manualWeather?.date === today() ? [...state.settings.manualWeather.extras] : [...(w?.extras || [])] };
  const s = openSheet(html`${w?.status === 'ok' ? raw(html`<p class="lead">Forecast: ${w.summary}</p>`) : w?.status === 'none' ? raw(html`<p class="lead">No city set. <a href="#/settings/profile">Set your city</a> for automatic weather.</p>`) : raw('<p class="lead">Choose today\'s conditions.</p>')}
    <p class="muted">Change if it feels different. You can choose more than one.</p>
    ${weatherPickerHTML(sel)}
    <div class="btn-col"><button class="btn primary" data-ok>Use these</button>
    ${state.settings.manualWeather?.date === today() ? raw('<button class="btn secondary" data-auto>Use the forecast again</button>') : ''}
    <button class="btn ghost" data-close="1">Cancel</button></div>${CREDIT}`, { title: 'Today\'s weather' });
  wireWeatherPicker(s.body, sel, () => {});
  $('[data-ok]', s.body).onclick = async () => { state.settings.manualWeather = { date: today(), temp: sel.temp, extras: sel.extras || [] }; save(); await s.close(); go('home'); };
  $('[data-auto]', s.body)?.addEventListener('click', async () => { state.settings.manualWeather = null; save(); await s.close(); go('home'); });
}
Object.defineProperty(exports,'outfitMenu',{enumerable:true,get:()=>outfitMenu});
};
__mods['js/views/looks.js'] = function(require,exports,module){
// My Looks: saved occasion looks, saved outfits and See-it-on-me pictures; before/after compare; products; sharing.
const { state, save, mutate, route, go, ui, itemById, today, isImageUsed } = require('js/app.js');
const store = require('js/store.js');
const { $, $$, html, raw, icon, toast, openSheet, shareOrOffer } = require('js/ui.js');
const { prettyDate, fmtINR, uid } = require('js/util.js');
const { shareCard } = require('js/images.js');
const { pageHead } = require('js/views/common.js');
const { hydrate, img, swatch, empty, compareHTML, wireCompare, pictureReturnHTML, wirePictureReturn, keepPicture, woreThis } = require('js/parts.js');
const { newItem, guessColourWord } = require('js/state.js');
const { guessCategory, hexForName } = require('js/catalog.js');
const { seeItOnMe } = require('js/views/aiflows.js');

const FILTERS = [['all', 'All'], ['occasion', 'Occasions'], ['mix', 'Outfits'], ['starred', 'Starred']];

function lookThumb(l) {
  if (l.pictures?.afterThumb || l.pictures?.after) return img(l.pictures.afterThumb || l.pictures.after, { alt: l.title });
  const sw = (l.pieces || []).slice(0, 4).map(p => p.thumb ? img(p.thumb, { alt: '' }).__raw : swatch(p.hex, 'big').__raw).join('');
  return raw(`<div class="mini">${sw}</div>`);
}

route('looks', el => {
  const f = ui.lFilter || 'all'; const sel = ui.lSelect || null;
  let list = state.looks.slice();
  if (f === 'occasion') list = list.filter(l => l.source === 'occasion');
  if (f === 'mix') list = list.filter(l => l.source !== 'occasion');
  if (f === 'starred') list = list.filter(l => l.starred);
  el.innerHTML = html`<div class="page looks">${pageHead('My Looks', { actions: html`<div class="row"><a class="btn small ghost" href="#/import-look">${icon('image')}<span>Import styled image</span></a>${state.looks.length > 1 ? raw(html`<button class="btn small ${sel ? 'primary' : 'ghost'}" data-select>${sel ? 'Cancel' : 'Ask family'}</button>`) : ''}</div>` })}
    ${sel ? raw(html`<p class="lead">Pick 2 or 3 looks to ask “Which one should I wear?”</p>`) : ''}
    ${state.looks.length ? raw(html`<div class="chips scroll" role="group" aria-label="Filter">${FILTERS.map(([k, l]) => raw(html`<button class="chip${f === k ? ' on' : ''}" aria-pressed="${f === k}" data-f="${k}">${l}</button>`))}</div>`) : ''}
    ${!state.looks.length ? empty('No looks yet', 'Looks from occasions, outfits you save, imported AI transformations and See-it-on-me pictures appear here.', html`<div class="btn-col"><a class="btn primary" href="#/session/new">${icon('sparkle')}<span>Style me for an occasion</span></a><a class="btn secondary" href="#/import-look">${icon('image')}<span>Import an AI styled image</span></a></div>`)
    : !list.length ? empty('Nothing here yet', 'Try another filter.') : raw(html`<div class="look-grid">${list.map(l => raw(html`<a class="look-card${sel?.has(l.id) ? ' sel' : ''}" href="#/look/${l.id}" data-id="${l.id}">
        <div class="lc-pic">${lookThumb(l)}${l.starred ? raw(`<span class="star">${icon('star').__raw}</span>`) : ''}${sel ? raw(`<span class="tick">${icon('check').__raw}</span>`) : ''}</div>
        <b>${l.title}</b><span class="muted">${[l.occasion, l.date ? prettyDate(l.date) : ''].filter(Boolean).join(' · ')}</span>
        ${l.rating ? raw(html`<span class="pill">${l.rating}</span>`) : ''}</a>`))}</div>`)}
    ${sel ? raw(html`<div class="selbar"><span class="selcount">${sel.size} chosen</span><button class="btn primary" data-ask ${raw(sel.size >= 2 && sel.size <= 3 ? '' : 'disabled')}>${icon('share')}<span>Share</span></button></div>`) : ''}
  </div>`;
  hydrate(el);
  $$('[data-f]', el).forEach(b => b.onclick = () => { ui.lFilter = b.dataset.f; go('looks'); });
  $('[data-select]', el)?.addEventListener('click', () => { ui.lSelect = sel ? null : new Set(); go('looks'); });
  if (sel) $$('.look-card', el).forEach(a => a.addEventListener('click', e => {
    e.preventDefault(); const id = a.dataset.id;
    if (sel.has(id)) sel.delete(id); else if (sel.size < 3) sel.add(id); else toast('Up to 3 looks', { ms: 2000 });
    go('looks');
  }));
  $('[data-ask]', el)?.addEventListener('click', () => { const ids = [...sel]; ui.lSelect = null; shareLooks(ids.map(id => state.looks.find(l => l.id === id)), true); go('looks'); });
});

// The pictures of a look. With both an AI picture and a photo of what was really worn, they are shown side by side
// (or with a slider) so the two can be compared. With one of them, the other is offered.
function picturesHTML(l, owned) {
  const pc = l.pictures || {};
  const aiActions = raw(html`<div class="row center wrap pic-actions"><span class="muted small">AI picture:</span><button class="btn small ghost" data-replace>${icon('image')}<span>Replace</span></button><button class="btn small ghost" data-savepic>${icon('download')}<span>Save</span></button><button class="btn small ghost" data-rmpic>Remove</button></div>`);
  const actualActions = raw(html`<div class="row center wrap pic-actions"><span class="muted small">What I wore:</span><button class="btn small ghost" data-actual-replace>Replace</button><button class="btn small ghost" data-actual-save>${icon('download')}<span>Save</span></button><button class="btn small ghost" data-actual-rm>Remove</button></div>`);
  if (pc.after && pc.actual) return raw(html`<h2 class="section-h">AI suggestion and what I wore</h2>
    ${compareHTML(pc.after, pc.actual, { labelA: 'AI suggestion', labelB: 'What I wore', cls: 'cmp-actual' })}${aiActions}${actualActions}
    ${pc.before ? raw(html`<details class="card more-cmp"><summary>Compare with your original photo</summary>${compareHTML(pc.before, pc.after)}</details>`) : ''}`);
  if (pc.after) return raw(html`${compareHTML(pc.before, pc.after)}${aiActions}
    <h2 class="section-h">What I actually wore</h2>
    <div class="card subtle add-actual"><p class="muted">After the occasion, add a photo of what you really wore to see it beside the AI suggestion.</p><button class="btn secondary" data-actual-add>${icon('image')}<span>Add a photo of what you wore</span></button></div>`);
  if (pc.actual) return raw(html`<h2 class="section-h">What I actually wore</h2>
    <figure class="pic-solo">${img(pc.actual, { alt: 'What I wore' })}<figcaption>What I wore</figcaption></figure>${actualActions}
    <div class="card subtle add-ai"><p class="muted">Add the AI picture of this look to see the two side by side.</p><div class="btn-col">${owned.length ? raw(html`<button class="btn secondary" data-seeme>${icon('user')}<span>See it on me</span></button>`) : ''}<button class="btn ${owned.length ? 'ghost' : 'secondary'}" data-addpic>${icon('image')}<span>Add the AI picture</span></button></div></div>`);
  return raw(html`<details class="card addpic"><summary>${icon('image')}<span>Add the styled picture</span></summary>${pictureReturnHTML()}</details>
    <h2 class="section-h">What I actually wore</h2>
    <div class="card subtle add-actual"><p class="muted">After the occasion, add a photo of what you really wore. Style You keeps it separate from the AI picture.</p><button class="btn secondary" data-actual-add>${icon('image')}<span>Add a photo of what you wore</span></button></div>`);
}

// "I bought this": the piece joins the wardrobe, filled in from the look, and the look counts it as owned.
function boughtIt(lookId, key, name) {
  const l = state.looks.find(x => x.id === lookId); if (!l) return;
  const p = (l.pieces || []).find(x => (key && x.key === key) || (!key && x.name === name));
  if (!p || p.owned) return;
  const pr = (l.products || []).find(x => x.found && ((p.key && x.pieceKey === p.key) || (x.piece || '').toLowerCase() === (p.name || '').toLowerCase()));
  let itemId = null;
  mutate(s => {
    const look = s.looks.find(x => x.id === lookId); const piece = look && (look.pieces || []).find(x => x === p || (key && x.key === key) || (!key && x.name === name));
    if (!piece || piece.owned) return;
    const cn = guessColourWord(piece.name);
    const cat = guessCategory(`${piece.category || ''} ${piece.name}`);
    const it = newItem(s, { name: piece.name, category: cat, colourName: hexForName(cn) ? cn : undefined, colourHex: hexForName(cn) || undefined, notes: pr ? [pr.brand, pr.product, pr.retailer].filter(Boolean).join(' · ') : '' });
    s.wardrobe.push(it); itemId = it.id;
    Object.assign(piece, { owned: true, wardrobeId: it.id, code: it.code, hex: it.colour?.unknown ? null : it.colour.hex, thumb: null });
  }, { undo: `${name} added to your wardrobe. Add a photo so it shows in outfits.`, rerender: false });
  if (itemId) go(`item/${itemId}`);
}

route('look', (el, [id]) => {
  const l = state.looks.find(x => x.id === id);
  if (!l) { el.innerHTML = html`<div class="page">${pageHead('Look not found', { back: '#/looks' })}${empty('This look was deleted', '', '<a class="btn primary" href="#/looks">Back to My Looks</a>')}</div>`; return; }
  const sess = l.sessionId ? state.sessions.find(s => s.id === l.sessionId && s.status === 'active') : null;
  const prods = l.products || [];
  const total = prods.filter(p => p.found && Number.isFinite(p.price)).reduce((a, p) => a + p.price, 0);
  const budget = l.budget || null;
  const owned = (l.pieces || []).filter(p => p.owned && p.wardrobeId && itemById(p.wardrobeId));
  el.innerHTML = html`<div class="page look">${pageHead(l.title, { back: '#/looks', sub: [l.occasion, l.sub, l.date ? prettyDate(l.date, { weekday: 'short', day: 'numeric', month: 'short' }) : ''].filter(Boolean).join(' · ') })}
    ${sess ? raw(html`<a class="card continue" href="#/session/${sess.id}"><div><b>Continue this occasion</b><p>Next: ${sess.nextLabel || ''}</p></div>${icon('chevron')}</a>`) : ''}
    ${picturesHTML(l, owned)}
    ${l.source === 'imported' ? raw(html`<div class="row wrap"><span class="pill">Imported AI visualisation${l.importSource ? ` · ${l.importSource}` : ''}</span></div>`) : ''}
    ${l.why ? raw(html`<p class="lead">${l.why}</p>`) : ''}
    <h2 class="section-h">Pieces</h2>
    ${(l.pieces || []).length ? raw(html`<ul class="pieces">${(l.pieces || []).map(p => { const pr = prods.find(x => x.piece && p.name && x.pieceKey === p.key) || prods.find(x => x.piece && x.piece.toLowerCase() === (p.name || '').toLowerCase()); return raw(html`<li class="piece">
      <span class="pc-pic">${p.thumb ? img(p.thumb, { alt: '' }) : swatch(p.hex || '#C9CACE')}</span>
      <div class="pc-txt"><b>${p.name}</b><span class="muted">${p.category || ''}${p.owned ? ` · ${p.code || ''} · in your wardrobe` : ''}</span>
        ${!p.owned && pr ? raw(pr.found ? html`<span class="muted">${[pr.brand, pr.retailer, pr.priceText ? `${pr.priceText} when checked` : ''].filter(Boolean).join(' · ')}</span>` : html`<span class="muted">${pr.reason || 'No exact product found'}</span>`) : ''}</div>
      ${p.owned ? raw('<span class="pill ok">You own this</span>') : raw(html`<div class="pc-act">${pr?.found ? raw(html`<a class="btn small primary" href="${pr.url}" target="_blank" rel="noopener noreferrer">${icon('external')}<span>Open on ${pr.retailer}</span></a>`) : raw(`<span class="pill">${prods.length ? 'No exact product found' : 'To buy'}</span>`)}<button class="btn small secondary" data-bought="${p.key || ''}" data-name="${p.name}">${icon('check')}<span>I bought this</span></button></div>`)}</li>`); })}</ul>`) : raw(html`<div class="card subtle"><p class="muted">No garment details were attached to this imported image. You can still keep, rate and share the visualisation.</p></div>`)}
    ${prods.length ? raw(html`<div class="card budget"><div class="row between"><span>New items${budget ? ' vs budget' : ''}</span><b>${fmtINR(total) || '₹0'}${budget ? ` of ${fmtINR(budget)}` : ''}</b></div>${budget && total > budget ? raw('<p class="warn small">Over budget</p>') : ''}<p class="muted small">Check size, price and stock on the shop's page before buying. Prices are as the AI saw them.</p></div>`) : ''}
    <h2 class="section-h">How did you like it?</h2>
    <div class="rate-row">${['Love it', 'Fine', 'Not for me'].map(r => raw(html`<button class="btn rate${l.rating === r ? ' on' : ''}" data-rate="${r}" aria-pressed="${l.rating === r}">${r}</button>`))}</div>
    <div class="btn-col">
      ${owned.length ? raw(html`<button class="btn secondary" data-wore>${icon('check')}<span>Wore this${l.wornOn ? ` (last ${prettyDate(l.wornOn)})` : ''}</span></button>`) : ''}
      <button class="btn secondary" data-share>${icon('share')}<span>Share on WhatsApp</span></button>
      <button class="btn ghost" data-star>${icon('star')}<span>${l.starred ? 'Starred' : 'Star this look'}</span></button>
      <button class="btn ghost danger-text" data-del>${icon('trash')}<span>Delete look</span></button></div>
  </div>`;
  hydrate(el); wireCompare(el);
  $$('[data-bought]', el).forEach(b => b.addEventListener('click', () => { if (b.disabled) return; b.disabled = true; boughtIt(id, b.dataset.bought, b.dataset.name); }));
  // The AI picture made here belongs to this look, so the two can be compared.
  $('[data-seeme]', el)?.addEventListener('click', () => seeItOnMe(owned.map(p => p.wardrobeId), undefined, { onPicture: blob => setPic(blob) }));
  $('[data-addpic]', el)?.addEventListener('click', () => { const sh = openSheet(pictureReturnHTML().__raw, { title: 'Add the AI picture' }); wirePictureReturn(sh.body, async b => { await sh.close(); setPic(b); }); });
  $$('[data-rate]', el).forEach(b => b.onclick = () => mutate(s => { const x = s.looks.find(y => y.id === id); x.rating = x.rating === b.dataset.rate ? null : b.dataset.rate; }, { toastMsg: 'Saved' }));
  $('[data-star]', el).onclick = () => mutate(s => { const x = s.looks.find(y => y.id === id); x.starred = !x.starred; });
  $('[data-wore]', el)?.addEventListener('click', () => woreThis(owned.map(p => p.wardrobeId), { lookId: id }));
  $('[data-share]', el).onclick = () => shareLooks([l], false);
  $('[data-del]', el).onclick = () => {
    const drop = [l.pictures?.after, l.pictures?.afterThumb, l.pictures?.actual, l.pictures?.actualThumb].filter(Boolean);
    go('looks');
    mutate(s => { s.looks = s.looks.filter(x => x.id !== id); }, { undo: 'Look deleted', dropImages: drop });
  };
  $('[data-rmpic]', el)?.addEventListener('click', () => {
    const drop = [l.pictures.after, l.pictures.afterThumb].filter(Boolean);
    mutate(s => { const x = s.looks.find(y => y.id === id); x.pictures = { ...x.pictures, after: null, afterThumb: null }; }, { undo: 'Picture removed (details kept)', dropImages: drop });
  });
  $('[data-savepic]', el)?.addEventListener('click', async () => {
    const b = await store.getImage(l.pictures.after); if (!b) return;
    const f = new File([b], `${l.title.replace(/[^\w ]+/g, '').slice(0, 30) || 'look'}.jpg`, { type: 'image/jpeg' });
    shareOrOffer(f, '', 'Save picture');
  });
  const setPic = async blob => {
    try {
      const p = await keepPicture(blob, 'look');
      const drop = [l.pictures?.after, l.pictures?.afterThumb].filter(Boolean);
      mutate(s => { const x = s.looks.find(y => y.id === id); x.pictures = { ...x.pictures, after: p.full, afterThumb: p.thumb }; s.settings.photosSinceBackup = (s.settings.photosSinceBackup || 0) + 1; }, { undo: 'Picture added', dropImages: drop });
    } catch (e) { toast('That picture could not be used: ' + e.message, { ms: 5000 }); }
  };
  wirePictureReturn(el, setPic);
  $('[data-replace]', el)?.addEventListener('click', () => {
    const s = openSheet(pictureReturnHTML().__raw, { title: 'Replace picture' });
    wirePictureReturn(s.body, async b => { await s.close(); setPic(b); });
  });
  const setActual = async blob => {
    try {
      const p = await keepPicture(blob, 'look-actual');
      const drop = [l.pictures?.actual, l.pictures?.actualThumb].filter(Boolean);
      mutate(s => { const x = s.looks.find(y => y.id === id); x.pictures = { ...x.pictures, actual: p.full, actualThumb: p.thumb }; s.settings.photosSinceBackup = (s.settings.photosSinceBackup || 0) + 1; }, { undo: 'Actual outfit photo added', dropImages: drop });
    } catch (e) { toast('That picture could not be used: ' + e.message, { ms: 5000 }); }
  };
  const actualChooser = () => { const sh = openSheet(pictureReturnHTML().__raw, { title: 'Add what you actually wore' }); wirePictureReturn(sh.body, async b => { await sh.close(); setActual(b); }); };
  $('[data-actual-add]', el)?.addEventListener('click', actualChooser);
  $('[data-actual-replace]', el)?.addEventListener('click', actualChooser);
  $('[data-actual-rm]', el)?.addEventListener('click', () => { const drop = [l.pictures?.actual, l.pictures?.actualThumb].filter(Boolean); mutate(s => { const x = s.looks.find(y => y.id === id); x.pictures = { ...x.pictures, actual: null, actualThumb: null }; }, { undo: 'Actual outfit photo removed', dropImages: drop }); });
  $('[data-actual-save]', el)?.addEventListener('click', async () => { const b = await store.getImage(l.pictures.actual); if (!b) return; shareOrOffer(new File([b], `${l.title.replace(/[^\w ]+/g, '').slice(0, 30) || 'actual-outfit'}-actual.jpg`, { type: 'image/jpeg' }), '', 'Save picture'); });
});

// ---------- import an AI transformation made outside an active Style You session ----------
function importDraft() {
  if (!ui.importLook) ui.importLook = { after: null, afterThumb: null, before: null, title: 'AI styled look', occasion: '', date: today(), provider: state.profile.defaultAI === 'chatgpt' ? 'ChatGPT' : 'Gemini', notes: '' };
  return ui.importLook;
}
async function setImportImage(kind, blob) {
  const d = importDraft();
  if (kind === 'after') {
    const p = await keepPicture(blob, 'look-import');
    const old = [d.after, d.afterThumb].filter(Boolean);
    d.after = p.full; d.afterThumb = p.thumb;
    for (const id of old) if (!isImageUsed(id)) store.deleteImage(id);
  } else {
    const p = await keepPicture(blob, 'look-before');
    const old = [d.before].filter(Boolean);
    d.before = p.full;
    // The original is only for comparison; it does not need a separate thumbnail.
    if (p.thumb) store.deleteImage(p.thumb);
    for (const id of old) if (!isImageUsed(id)) store.deleteImage(id);
  }
  ui.keepImages = [...new Set([...(ui.keepImages || []), d.after, d.afterThumb, d.before].filter(Boolean))];
}
function importChooser(title, kind, done) {
  const sh = openSheet(pictureReturnHTML(state.profile.defaultAI).__raw, { title });
  wirePictureReturn(sh.body, async blob => {
    try { await setImportImage(kind, blob); await sh.close(); done?.(); }
    catch (e) { toast('That picture could not be used: ' + (e?.message || e), { ms: 5000 }); }
  });
}
function wireDrop(zone, kind, rerender) {
  if (!zone) return;
  const enter = e => { e.preventDefault(); zone.classList.add('drag'); };
  zone.addEventListener('dragenter', enter); zone.addEventListener('dragover', enter);
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', async e => {
    e.preventDefault(); zone.classList.remove('drag');
    const f = [...(e.dataTransfer?.files || [])].find(x => /^image\//.test(x.type));
    if (!f) return toast('Drop an image file here.', { ms: 2500 });
    try { await setImportImage(kind, f); rerender(); } catch (er) { toast('That picture could not be used: ' + (er?.message || er), { ms: 5000 }); }
  });
}

route('import-look', async el => {
  const d = importDraft();
  // Android share target can hand a picture here even when no occasion is active.
  if (ui.pendingImportBlob) {
    const b = ui.pendingImportBlob; ui.pendingImportBlob = null;
    if (!d.after) { try { await setImportImage('after', b); } catch (e) { toast('The shared picture could not be used.', { ms: 4000 }); } }
  }
  const rerender = () => go('import-look');
  el.innerHTML = html`<div class="page import-look">${pageHead('Import styled image', { back: '#/looks', sub: 'Bring an AI transformation into your Style You history.' })}
    <div class="card import-panel">
      <div class="row between"><div><p class="eyebrow">Styled image</p><h2>${d.after ? 'Ready to import' : 'Add the transformed image'}</h2></div>${d.after ? raw(`<span class="pill ok">Added</span>`) : ''}</div>
      ${d.after ? raw(html`<div class="import-preview">${img(d.after, { alt: 'Imported styled image' })}</div><div class="row center wrap"><button class="btn small secondary" data-after>Replace</button><button class="btn small ghost" data-rmafter>Remove</button></div>`) : raw(html`<div class="drop-zone" data-drop-after tabindex="0"><span>${icon('image')}</span><b>Paste, choose or drop the styled image</b><em>On desktop, drag an image here.</em></div><button class="btn primary" data-after>Add styled image</button>`)}
    </div>
    <div class="card import-panel">
      <div><p class="eyebrow">Original photo · optional</p><h2>${d.before ? 'Before photo added' : 'Add the original for comparison'}</h2></div>
      ${d.before ? raw(html`<div class="import-preview small">${img(d.before, { alt: 'Original photo' })}</div><div class="row center wrap"><button class="btn small secondary" data-before>Replace</button><button class="btn small ghost" data-rmbefore>Remove</button></div>`) : raw(html`<div class="drop-zone compact" data-drop-before tabindex="0"><span>${icon('user')}</span><b>Optional before photo</b><em>It is saved only because you explicitly add it to this Look.</em></div><button class="btn secondary" data-before>Add original photo</button>`)}
    </div>
    ${d.after ? compareHTML(d.before, d.after, { labelA: 'Original', labelB: 'Styled preview' }) : ''}
    <form class="form import-meta" autocomplete="off">
      <label class="field"><span>Look name <em class="req-tag">Required</em></span><input name="title" maxlength="60" required value="${d.title}"></label>
      <div class="grid2"><label class="field"><span>Made with</span><select name="provider">${['Gemini','ChatGPT','Other'].map(x => raw(html`<option ${raw(d.provider === x ? 'selected' : '')}>${x}</option>`))}</select></label>
      <label class="field"><span>Date</span><input type="date" name="date" value="${d.date || today()}"></label></div>
      <label class="field"><span>Occasion / context (optional)</span><input name="occasion" maxlength="80" placeholder="e.g. Wedding guest, casual lunch" value="${d.occasion}"></label>
      <label class="field"><span>Notes (optional)</span><textarea name="notes" rows="2" maxlength="300" placeholder="What did you like or want to remember?">${d.notes}</textarea></label>
      <p class="muted small">AI style visualisation. Fit and fine details may differ from real garments.</p>
      <div class="sticky-save"><button class="btn primary big" type="submit" ${raw(d.after ? '' : 'disabled')}>Save to My Looks</button><a class="btn ghost" href="#/looks">Cancel</a></div>
    </form></div>`;
  hydrate(el); wireCompare(el);
  $('[data-after]', el)?.addEventListener('click', () => importChooser('Add styled image', 'after', rerender));
  $('[data-before]', el)?.addEventListener('click', () => importChooser('Add original photo', 'before', rerender));
  $('[data-rmafter]', el)?.addEventListener('click', () => { const old=[d.after,d.afterThumb].filter(Boolean); d.after=d.afterThumb=null; old.forEach(id=>{ if(!isImageUsed(id)) store.deleteImage(id); }); rerender(); });
  $('[data-rmbefore]', el)?.addEventListener('click', () => { const old=d.before; d.before=null; if(old && !isImageUsed(old)) store.deleteImage(old); rerender(); });
  wireDrop($('[data-drop-after]', el), 'after', rerender); wireDrop($('[data-drop-before]', el), 'before', rerender);
  $('.import-meta', el).addEventListener('input', e => { if (e.target.name) d[e.target.name] = e.target.value; });
  $('.import-meta', el).addEventListener('submit', e => {
    e.preventDefault();
    const f=e.currentTarget, title=f.title.value.trim().slice(0,60);
    if (!d.after) return toast('Add the styled image first.', { ms: 2500 });
    if (!title) { toast('Please name this Look.', { ms: 2500 }); f.title.focus(); return; }
    const look = {
      id: uid('l-'), source: 'imported', importSource: f.provider.value, title,
      occasion: f.occasion.value.trim().slice(0,80), sub: '', date: f.date.value || today(), number: null,
      why: f.notes.value.trim().slice(0,300), pieces: [], products: [],
      pictures: { before: d.before || null, after: d.after, afterThumb: d.afterThumb || null },
      rating: null, starred: false, wornOn: null, createdAt: new Date().toISOString()
    };
    state.looks.unshift(look); state.settings.photosSinceBackup=(state.settings.photosSinceBackup||0)+1; save();
    ui.importLook = null; ui.keepImages = [];
    go(`look/${look.id}`); toast('Styled image saved to My Looks', { ms: 3000 });
  });
});

// WhatsApp card: one look, or "Which one should I wear?" with 2–3.
async function shareLooks(looks, ask) {
  looks = looks.filter(Boolean);
  const data = await Promise.all(looks.map(async l => ({
    title: l.title,
    lines: (l.pieces || []).slice(0, 6).map(p => p.name),
    pictureBlob: l.pictures?.after ? await store.getImage(l.pictures.after) : null,
    swatches: (l.pieces || []).map(p => p.hex).filter(Boolean).slice(0, 5)
  })));
  const heading = ask ? 'Which one should I wear?' : (looks[0].occasion || 'My look');
  const blob = await shareCard({ heading, looks: data });
  const file = new File([blob], 'style-you-look.jpg', { type: 'image/jpeg' });
  const text = ask ? `Which one should I wear? ${looks.map((l, i) => `${i + 1}) ${l.title}`).join('  ')}` : `${looks[0].title}${looks[0].occasion ? ' for ' + looks[0].occasion : ''}`;
  shareOrOffer(file, text, ask ? 'Ask family' : 'Share look');
}
Object.defineProperty(exports,'shareLooks',{enumerable:true,get:()=>shareLooks});
};
__mods['js/views/mix.js'] = function(require,exports,module){
// Mix & Match: complete outfits from owned clothes, on the phone, offline.
const { state, save, mutate, route, go, ui, today, itemById } = require('js/app.js');
const { $, $$, html, raw, icon, toast, openSheet } = require('js/ui.js');
const { DAY_TYPES } = require('js/catalog.js');
const { suggest, capsule, wardrobeReady, groupOf } = require('js/engine.js');
const { plural } = require('js/util.js');
const { board, hydrate, woreThis, empty, tile, AUDIENCES } = require('js/parts.js');
const { pageHead, todayWeather } = require('js/views/common.js');
const { seeItOnMe, saveMixAsLook, judgeThree, askAIImprove } = require('js/views/aiflows.js');

const MAIN_CHIPS = [['occasionSafe', 'Occasion-safe'], ['pop', 'Colour pop'], ['tonal', 'Tonal'], ['rarely', 'Rarely worn'], ['favourites', 'Favourites']];
const MORE_CHIPS = [['comfort', 'Comfort'], ['adventurous', 'Adventurous'], ['minimal', 'Minimal pieces']];
const STYLES = [['fusion', 'Any style'], ['indian', 'Indian'], ['western', 'Western']];

function mixState() {
  if (!ui.mix) ui.mix = { dayType: state.settings.lastMixDay || 'casual', chips: {}, page: 0, audience: null };
  return ui.mix;
}

route('mix', async (el, [mode, arg]) => {
  const m = mixState();
  if (mode === 'around' && arg && itemById(arg)) { m.chips = { around: arg }; m.page = 0; history.replaceState(null, '', '#/mix'); }
  const style = state.settings.mixStyle || 'fusion';
  const anyChip = Object.keys(m.chips).some(k => m.chips[k]);
  const ready = wardrobeReady(state.wardrobe.filter(w => w.status !== 'Archived'), today());
  const around = m.chips.around ? itemById(m.chips.around) : null;
  const moreOn = MORE_CHIPS.filter(([k]) => m.chips[k]);

  el.innerHTML = html`<div class="page mix">${pageHead('Mix & Match')}
    ${!ready ? empty('Add a few more clothes', 'Mix & Match needs at least one top and one bottom, or one full outfit like a dress or kurta set.', html`<a class="btn primary" href="#/add">${icon('plus')}<span>Add clothes</span></a>`) : raw(html`
    <div class="chips scroll" role="group" aria-label="Kind of day">${DAY_TYPES.map(d => raw(html`<button class="chip${m.dayType === d.id ? ' on' : ''}" aria-pressed="${m.dayType === d.id}" data-day="${d.id}">${d.label}</button>`))}</div>
    <div class="seg small" role="radiogroup" aria-label="Style">${STYLES.map(([k, l]) => raw(html`<button role="radio" aria-checked="${style === k}" data-style="${k}">${l}</button>`))}</div>
    <div class="chips scroll prio" role="group" aria-label="What matters">
      <button class="chip${anyChip ? '' : ' on'}" aria-pressed="${!anyChip}" data-auto>Auto</button>
      ${MAIN_CHIPS.map(([k, l]) => raw(html`<button class="chip${m.chips[k] ? ' on' : ''}" aria-pressed="${!!m.chips[k]}" data-chip="${k}">${l}</button>`))}
      <button class="chip${moreOn.length || around ? ' on' : ''}" data-more>More${moreOn.length || around ? ` (${moreOn.length + (around ? 1 : 0)})` : ''} ▾</button></div>
    ${around ? raw(html`<div class="around">${tile(around, { small: true })}<span>Building around <b>${around.name}</b></span><button class="icon-btn" data-noaround aria-label="Stop building around this">${icon('close')}</button></div>`) : ''}
    ${m.audience ? raw(html`<p class="muted small">Not repeating outfits already worn in front of: <b>${m.audience}</b> <button class="linkish" data-noaud>Clear</button></p>`) : ''}
    <div class="mix-res"><div class="skeleton board-sk"></div></div>`)}
  </div>`;
  if (!ready) return;

  $$('[data-day]', el).forEach(b => b.onclick = () => { m.dayType = b.dataset.day; state.settings.lastMixDay = m.dayType; save(); m.page = 0; go('mix'); });
  $$('[data-style]', el).forEach(b => b.onclick = () => { state.settings.mixStyle = b.dataset.style; save(); m.page = 0; go('mix'); });
  $('[data-auto]', el).onclick = () => { m.chips = {}; m.page = 0; go('mix'); };
  $$('[data-chip]', el).forEach(b => b.onclick = () => {
    const k = b.dataset.chip; m.chips[k] = !m.chips[k];
    if (k === 'pop' && m.chips.pop) m.chips.tonal = false;
    if (k === 'tonal' && m.chips.tonal) m.chips.pop = false;
    m.page = 0; go('mix');
  });
  $('[data-more]', el).onclick = () => moreSheet(m);
  $('[data-noaround]', el)?.addEventListener('click', () => { delete m.chips.around; m.page = 0; go('mix'); });
  $('[data-noaud]', el)?.addEventListener('click', () => { m.audience = null; m.page = 0; go('mix'); });

  const seq = ui.seq;
  const w = await todayWeather();
  if (seq !== ui.seq) return;
  const ctx = { dayType: m.dayType, temp: w?.temp || null, extras: w?.extras || [], chips: m.chips, style, audience: m.audience, avoidColours: state.profile.avoidColours, count: 30 };
  const t0 = performance.now();
  const r = suggest(state.wardrobe, state.worn, state.sets, ctx, today());
  ui.lastMixMs = performance.now() - t0;
  const box = $('.mix-res', el);
  if (!r.outfits.length) {
    box.innerHTML = empty('No outfit fits these choices', (r.notes.join(' ') || 'Everything suitable may be in the laundry, too formal or too casual for this kind of day.') + ' Try Auto or another kind of day.', '<button class="btn secondary" data-auto2>Back to Auto</button>').__raw;
    $('[data-auto2]', box)?.addEventListener('click', () => { m.chips = {}; go('mix'); });
    return;
  }
  const pages = Math.ceil(r.outfits.length / 3);
  const page = m.page % pages;
  const shown = r.outfits.slice(page * 3, page * 3 + 3);
  box.innerHTML = html`<p class="opt">Optimising for: ${r.optimisingFor}${w?.status === 'ok' || w?.status === 'manual' ? '' : ' · weather not known'}</p>
    ${r.notes.length ? raw(html`<p class="warn small">${r.notes.join(' ')}</p>`) : ''}
    ${shown.map((o, i) => raw(html`<article class="outfit${i === 0 ? ' first' : ''}" data-i="${i}">${board(o.ids, { missing: o.missing })}
      <div class="row between"><h3>${o.title}</h3><span class="pill${o.allOwned ? ' ok' : ''}">${o.allOwned ? 'All owned' : o.coverage}</span></div>
      <p>${o.why}${o.recent ? ' Includes something worn recently.' : ''}</p>
      <div class="row"><button class="btn primary" data-wore>${icon('check')}<span>Wore this</span></button><button class="btn secondary" data-save>${icon('bookmark')}<span>Save</span></button><button class="btn secondary" data-more2 aria-label="More options for this outfit">${icon('more')}</button></div></article>`))}
    <div class="row center wrap">${pages > 1 ? raw(html`<button class="btn ghost" data-another>${icon('refresh')}<span>Another ${Math.min(3, r.outfits.length)}</span></button>`) : ''}
      <button class="btn ghost" data-judge>${icon('wand')}<span>Ask AI to judge these</span></button></div>
    <p class="muted center small">${pages > 1 ? `Set ${page + 1} of ${pages}` : 'These are all the outfits that fit right now.'}</p>`;
  hydrate(box);
  $$('.outfit', box).forEach(a => {
    const o = shown[+a.dataset.i];
    $('[data-wore]', a).onclick = () => woreThis(o.ids, { baseIds: o.baseIds, mainId: o.mainId, audience: m.audience });
    $('[data-save]', a).onclick = () => saveMixAsLook(o, { label: DAY_TYPES.find(d => d.id === m.dayType)?.label });
    $('[data-more2]', a).onclick = () => {
      const s = openSheet(html`<div class="menu"><button data-a="seeme">${icon('user')}<span>See it on me</span></button><button data-a="improve">${icon('wand')}<span>Ask AI to improve</span></button><button data-a="around">${icon('shuffle')}<span>More outfits with the ${itemById(o.mainId)?.name || 'main piece'}</span></button></div>`, { title: o.title });
      s.body.addEventListener('click', async e => { const k = e.target.closest('[data-a]')?.dataset.a; if (!k) return; await s.close(); if (k === 'seeme') seeItOnMe(o.ids); if (k === 'improve') askAIImprove({ ...ctx, label: DAY_TYPES.find(d => d.id === m.dayType)?.label }); if (k === 'around') { m.chips = { around: o.mainId }; m.page = 0; go('mix'); } });
    };
  });
  $('[data-another]', box)?.addEventListener('click', () => { m.page = page + 1; if (m.page >= pages) { m.page = 0; toast('Back to the first set', { ms: 2000 }); } go('mix'); });
  $('[data-judge]', box).onclick = () => judgeThree(shown);
});

function moreSheet(m) {
  const s = openSheet(html`<div class="chips wrap">${MORE_CHIPS.map(([k, l]) => raw(html`<button class="chip${m.chips[k] ? ' on' : ''}" aria-pressed="${!!m.chips[k]}" data-chip="${k}">${l}</button>`))}</div>
    <p class="eyebrow">Avoid repeats in front of</p><div class="chips wrap">${AUDIENCES.map(a => raw(html`<button class="chip${m.audience === a ? ' on' : ''}" aria-pressed="${m.audience === a}" data-aud="${a}">${a}</button>`))}</div>
    <div class="menu"><button data-a="around">${icon('shuffle')}<span>Build around this item…</span></button><button data-a="capsule">${icon('bag')}<span>Travel capsule…</span></button></div>
    <div class="btn-col"><button class="btn primary" data-close="1">Done</button></div>`, { title: 'More choices', onClose: () => { m.page = 0; if (ui.route === 'mix') go('mix'); } });
  s.body.addEventListener('click', async e => {
    const c = e.target.closest('[data-chip]'), a = e.target.closest('[data-aud]'), act = e.target.closest('[data-a]')?.dataset.a;
    if (c) { const k = c.dataset.chip; m.chips[k] = !m.chips[k]; c.classList.toggle('on', !!m.chips[k]); c.setAttribute('aria-pressed', !!m.chips[k]); }
    if (a) { m.audience = m.audience === a.dataset.aud ? null : a.dataset.aud; $$('[data-aud]', s.body).forEach(b => { const on = b.dataset.aud === m.audience; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }); }
    if (act === 'around') { await s.close(); pickItem(id => { m.chips.around = id; m.page = 0; go('mix'); }); }
    if (act === 'capsule') { await s.close(); capsuleSheet(m); }
  });
}

function pickItem(onPick, title = 'Build around this item') {
  const items = state.wardrobe.filter(w => w.status !== 'Archived');
  const s = openSheet(html`<div class="grid">${items.map(w => tile(w))}</div>`, { title, full: true });
  hydrate(s.body);
  s.body.addEventListener('click', async e => { const t = e.target.closest('.tile'); if (!t) return; await s.close(); onPick(t.dataset.id); });
}

function capsuleSheet(m) {
  let days = 3;
  const draw = () => {
    const r = capsule(state.wardrobe, state.worn, state.sets, { dayType: 'travel', avoidColours: state.profile.avoidColours, style: state.settings.mixStyle || 'fusion' }, days, today());
    const items = r.packIds.map(itemById).filter(Boolean);
    const clothes = items.filter(i => ['top', 'bottom', 'one', 'layer'].includes(groupOf(i)));
    return html`<div class="row center stepper"><button class="icon-btn" data-d="-1" aria-label="Fewer days">−</button><b>${plural(days, 'day')}</b><button class="icon-btn" data-d="1" aria-label="More days">+</button></div>
      ${r.outfits.length ? raw(html`<p class="lead">${plural(clothes.length, 'piece')} of clothing make ${plural(r.outfits.length, 'different outfit')}.</p>
      <h3>Pack</h3><div class="grid small">${items.map(i => tile(i, { small: true }))}</div>
      ${r.short ? raw(html`<p class="warn small">Only ${plural(r.outfits.length, 'outfit')} possible — add more travel-friendly clothes.</p>`) : ''}
      ${r.outfits.map((o, i) => raw(html`<h3>Day ${i + 1}: ${o.title}</h3>${board(o.ids)}`))}
      <div class="btn-col"><button class="btn primary" data-pack>Mark these as Packed</button></div>`) : empty('No travel outfits yet', 'Add some comfortable tops and bottoms.').__raw}`;
  };
  const s = openSheet(draw(), { title: 'Travel capsule', full: true });
  const wire = () => {
    hydrate(s.body);
    $$('[data-d]', s.body).forEach(b => b.onclick = () => { days = Math.min(10, Math.max(1, days + +b.dataset.d)); s.body.innerHTML = draw(); wire(); });
    $('[data-pack]', s.body)?.addEventListener('click', async () => {
      const r = capsule(state.wardrobe, state.worn, state.sets, { dayType: 'travel', avoidColours: state.profile.avoidColours, style: state.settings.mixStyle || 'fusion' }, days, today());
      await s.close();
      mutate(st => { for (const id of r.packIds) { const w = st.wardrobe.find(x => x.id === id); if (w) { w.status = 'Packed'; w.statusSince = today(); } } }, { undo: `${plural(r.packIds.length, 'piece')} marked Packed. Set them back to Available in Wardrobe after the trip.` });
    });
  };
  wire();
}
Object.defineProperty(exports,'pickItem',{enumerable:true,get:()=>pickItem});
};
__mods['js/views/onboarding.js'] = function(require,exports,module){
// First run: about a minute. Every step except the adults-only check can be skipped or changed later.
const { state, save, route, go, ui } = require('js/app.js');
const { $, $$, html, raw, icon, toast, isIOS, isAndroid, isStandalone } = require('js/ui.js');
const { citySearchHTML, wireCitySearch } = require('js/views/common.js');

const STEPS = ['welcome', 'city', 'sizes', 'clothing', 'ai', 'install', 'start'];

route('onboarding', (el, [stepName]) => {
  const i = Math.max(0, STEPS.indexOf(stepName || 'welcome'));
  const p = state.profile;
  const step = STEPS[i];
  if (i > 0 && !p.adultConfirmed) { location.replace('#/onboarding/welcome'); return; }
  if (p.onboarded && !stepName) { location.replace('#/home'); return; }
  const next = () => go(`onboarding/${STEPS[i + 1]}`);
  const dots = raw(html`<div class="dots" role="img" aria-label="Step ${i + 1} of ${STEPS.length}">${STEPS.map((_, k) => raw(`<span class="${k <= i ? 'on' : ''}"></span>`))}</div>`);
  const back = i > 0 ? raw(html`<a class="icon-btn" href="#/onboarding/${STEPS[i - 1]}" aria-label="Back">${icon('back')}</a>`) : raw('<span></span>');
  const head = raw(html`<div class="ob-head">${back}${dots}${i > 0 && step !== 'start' ? raw(html`<button class="linkish" data-skip>Skip</button>`) : raw('<span></span>')}</div>`);
  let body = '';

  if (step === 'welcome') body = html`
    <div class="ob-hero"><img class="logo-big" src="icon.svg" alt="" width="76" height="76">
    <h1>Style You</h1><p class="lead">Outfits from your own wardrobe every day, and full looks for big occasions — styled by your own Gemini or ChatGPT.</p></div>
    <label class="field"><span>Your name <em class="opt-tag">Optional</em></span><input id="ob-name" type="text" autocomplete="given-name" maxlength="40" value="${p.name}"></label>
    <label class="check"><input id="ob-adult" type="checkbox" ${raw(p.adultConfirmed ? 'checked' : '')}><span>I am 18 or older</span></label>
    <p class="muted">Saved on this device.</p>
    <button class="btn primary big" id="ob-go" ${raw(p.adultConfirmed ? '' : 'disabled')}>Get started</button>`;

  if (step === 'city') body = html`<h1>Where are you usually?</h1><p class="lead">For the weather in your daily outfits.</p>
    ${citySearchHTML(p.city)}
    <button class="btn primary big" id="ob-go" ${raw(p.city ? '' : 'disabled')}>Continue</button>`;

  if (step === 'sizes') body = html`<h1>Your sizes</h1><p class="lead">Used when the AI finds products. Skip if you like.</p>
    <div class="grid3">
      <label class="field"><span>Top</span><input id="sz-top" maxlength="12" placeholder="M / 40" value="${p.sizes.top}"></label>
      <label class="field"><span>Bottom</span><input id="sz-bottom" maxlength="12" placeholder="32 / M" value="${p.sizes.bottom}"></label>
      <label class="field"><span>Shoes</span><input id="sz-shoe" maxlength="12" placeholder="UK 8" value="${p.sizes.shoe}"></label></div>
    <button class="btn primary big" id="ob-go">Continue</button>`;

  if (step === 'clothing') body = html`<h1>Clothing</h1><p class="lead">Choose the clothing direction you want. Both / Any follows your brief and wardrobe.</p>
    <div class="choice-list" role="radiogroup" aria-label="Clothing">${[['auto', 'Both / Any — follow my brief', 'Recommended'], ['menswear', 'Menswear', ''], ['womenswear', 'Womenswear', ''], ['both', 'Both', '']].map(([v, l, n]) =>
      raw(html`<label class="choice"><input type="radio" name="cl" value="${v}" ${raw(p.clothing === v ? 'checked' : '')}><span>${l}</span>${n ? raw(`<em>${n}</em>`) : ''}</label>`))}</div>
    <button class="btn primary big" id="ob-go">Continue</button>`;

  if (step === 'ai') body = html`<h1>Your AI app</h1><p class="lead">Style You prepares the requests; your own app does the styling and pictures. You can switch any time.</p>
    <div class="choice-list" role="radiogroup" aria-label="AI app">${[['gemini', 'Gemini', 'Recommended'], ['chatgpt', 'ChatGPT', '']].map(([v, l, n]) =>
      raw(html`<label class="choice"><input type="radio" name="ai" value="${v}" ${raw(p.defaultAI === v ? 'checked' : '')}><span>${l}</span>${n ? raw(`<em>${n}</em>`) : ''}</label>`))}</div>
    <p class="muted">You'll need to be signed in to it. Picture editing limits depend on your plan with Google or OpenAI.</p>
    <button class="btn primary big" id="ob-go">Continue</button>`;

  if (step === 'install') {
    const already = isStandalone();
    const steps = isIOS ? ['Tap the <b>Share</b> button in Safari', 'Choose <b>Add to Home Screen</b>', 'Open Style You from the new icon']
      : isAndroid ? ['Tap the <b>⋮</b> menu in Chrome', 'Choose <b>Add to Home screen</b> or <b>Install app</b>', 'Open Style You from the new icon']
        : ['Click the install icon in the address bar, or the browser menu', 'Choose <b>Install Style You</b>'];
    body = html`<h1>Add to your home screen</h1>
      ${already ? raw(html`<div class="card ok-card">${icon('check')}<p>Done — you're using the home-screen app.</p></div>`) : raw(html`
      <p class="lead">${isIOS ? 'Important on iPhone: in a Safari tab, saved clothes and photos can be cleared after 7 days without a visit. The Home Screen app keeps its own storage, separate from Safari. Everything still lives only on this phone, so keep a backup too.' : 'Opens like an app and keeps your data safer.'}</p>
      ${ui.installPrompt ? raw(html`<button class="btn secondary" id="ob-install">${icon('download')}<span>Install now</span></button>`) : ''}
      <ol class="steps">${steps.map(s => raw(`<li>${s}</li>`))}</ol>`)}
      <button class="btn primary big" id="ob-go">${already ? 'Continue' : 'I’ll do it — continue'}</button>`;
  }

  if (step === 'start') body = html`<h1>Start your wardrobe</h1><p class="lead">Add the 15 things you wear most. You can add more any time.</p>
    <div class="btn-col">
      <button class="btn primary big" data-start="photos">${icon('image')}<span>From photos</span></button>
      <button class="btn secondary" data-start="list">${icon('paste')}<span>Type a list</span></button>
      <button class="btn ghost" data-start="later">Later</button></div>`;

  el.innerHTML = html`<div class="page onboarding">${head}${raw(body)}</div>`;

  $('[data-skip]', el)?.addEventListener('click', next);
  if (step === 'welcome') {
    const cb = $('#ob-adult', el), name = $('#ob-name', el), goBtn = $('#ob-go', el);
    const valid = () => { goBtn.disabled = !cb.checked; };
    cb.addEventListener('change', valid);
    name.addEventListener('input', valid);
    valid();
    goBtn.addEventListener('click', () => {
      const n = name.value.trim().slice(0, 40);
      if (!cb.checked) { toast('Please confirm you are 18 or older.', { ms: 3000 }); return; }
      p.adultConfirmed = true; p.name = n; save(); next();
    });
  }
  if (step === 'city') wireCitySearch(el, city => { p.city = city; save(); $('#ob-go', el).disabled = !city; }, () => next());
  if (step === 'city') $('#ob-go', el).addEventListener('click', next);
  if (step === 'sizes') $('#ob-go', el).addEventListener('click', () => { p.sizes = { top: $('#sz-top', el).value.trim(), bottom: $('#sz-bottom', el).value.trim(), shoe: $('#sz-shoe', el).value.trim() }; save(); next(); });
  if (step === 'clothing') $('#ob-go', el).addEventListener('click', () => { p.clothing = $('input[name=cl]:checked', el)?.value || 'auto'; save(); next(); });
  if (step === 'ai') $('#ob-go', el).addEventListener('click', () => { p.defaultAI = $('input[name=ai]:checked', el)?.value || 'gemini'; save(); next(); });
  if (step === 'install') {
    $('#ob-install', el)?.addEventListener('click', async () => { const e = ui.installPrompt; ui.installPrompt = null; if (!e) return; e.prompt(); await e.userChoice.catch(() => null); go('onboarding/install'); });
    $('#ob-go', el).addEventListener('click', next);
  }
  if (step === 'start') $$('[data-start]', el).forEach(b => b.addEventListener('click', () => {
    p.onboarded = true; save();
    const k = b.dataset.start;
    go(k === 'photos' ? 'add/photos' : k === 'list' ? 'add/list' : 'home');
  }));
});

};
__mods['js/views/session.js'] = function(require,exports,module){
// Occasion session: brief → send with photo → 3 looks → choose → products when needed → picture → compare → saved.
// Resumes where it was left. The styled picture is required before the session counts as complete.
const { state, save, mutate, route, go, ui, today, itemById, availableNow, aiName, aiForStage, onInbox, activeSessions, isImageUsed, render, recordAIInbox } = require('js/app.js');
const store = require('js/store.js');
const { $, $$, html, raw, icon, toast, openSheet, pickFiles, isAndroid, shareOrOffer, confirmSheet } = require('js/ui.js');
const { OCCASIONS, OCC, CAT } = require('js/catalog.js');
const { uid, prettyDate, plural, fmtINR, normalise, daysBetween } = require('js/util.js');
const { occasionRequest, pictureRequest, correctionRequest, productsRequest, fixFormatRequest, wardrobeLines } = require('js/prompts.js');
const { parseLooks, parseProducts, readSessionId } = require('js/parse.js');
const { forecastFor } = require('js/weather.js');
const { shrink, contactSheet } = require('js/images.js');
const { handoffHTML, wireHandoff, pasteHTML, wirePaste, pictureReturnHTML, wirePictureReturn, keepPicture, compareHTML, wireCompare, hydrate, img, copyNow, AUDIENCES } = require('js/parts.js');
const { citySearchHTML, wireCitySearch, weatherPickerHTML, wireWeatherPicker, CREDIT } = require('js/views/common.js');
const { guidedPhoto } = require('js/views/camera.js');
const { newLook } = require('js/views/aiflows.js');

const STEPS = [
  { id: 'brief', rail: 0, next: 'answer a few questions' },
  { id: 'send', rail: 1, next: 'send your photo and bring back 3 looks' },
  { id: 'choose', rail: 1, next: 'pick one of your 3 looks' },
  { id: 'products', rail: 2, next: 'find products for any missing pieces' },
  { id: 'picture', rail: 3, next: 'get the styled preview' },
  { id: 'compare', rail: 3, next: 'check the styled preview' },
  { id: 'done', rail: 4, next: 'done' }
];
const RAIL = ['Brief', 'Looks', 'Shop', 'Preview', 'Saved'];
const RAIL_STAGE = [null, 'looks', 'shopping', 'preview', null];
const STAGES = [['looks', 'Looks'], ['shopping', 'Shopping'], ['preview', 'Styled preview']];
const STYLE_DIR = ['Indian', 'Western', 'Indo-Western', 'Surprise me'];
const DAYPARTS = ['Morning', 'Afternoon', 'Evening', 'Night'];
const SETTINGS = ['Indoors', 'Outdoors', 'Both'];
const FOLLOW_UPS = ['Try another colour', 'More formal', 'More relaxed', 'Warmer', 'Cooler', 'Change the shoes'];

const sess = id => state.sessions.find(s => s.id === id);
function setStep(s, id) {
  const i = STEPS.findIndex(x => x.id === id);
  s.step = id; s.stepIndex = i; s.nextLabel = STEPS[i].next; s.updatedAt = new Date().toISOString();
  if (id === 'done') s.status = s.pictures?.after ? 'complete' : 'active';
  save();
}
function titleFor(o) { return o.description?.trim().slice(0, 40) || o.sub || OCC[o.occasionId]?.label || 'Occasion'; }
const chosenLook = s => s.looks?.find(l => l.number === s.chosen) || null;
const savedLook = s => state.looks.find(l => l.id === s.lookId) || null;

function newSession() {
  const c = state.profile.city;
  const s = {
    id: uid('s-'), status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ai: state.profile.defaultAI,
    occasion: { occasionId: null, sub: '', description: '', date: '', daypart: '', place: c ? (c.short || c.name) : '', placeCoords: c ? { lat: c.lat, lon: c.lon } : null, setting: '', weatherTemp: null, weatherExtras: [], weatherSummary: '', weatherStatus: '', style: '', vibes: [], budget: '', notes: '', audience: null },
    photoId: null, looks: [], chosen: null, lookId: null, pictures: {}, shopStatus: 'pending', title: 'Occasion', bridge: { preferred: state.profile.defaultAI, lastMethod: '', lastSentAt: null }
  };
  setStep(s, 'brief');
  return s;
}

// ---------- entry ----------
route('session', (el, [id]) => {
  if (id === 'new' || !id) {
    const act = activeSessions();
    if (act.length && ui.params[1] !== 'fresh') {
      el.innerHTML = html`<div class="page">${shellHead('Style me for an occasion', '#/home')}
        <p class="lead">You have an occasion in progress.</p>
        ${act.map(s => raw(html`<div class="card continue-row"><a href="#/session/${s.id}"><b>Continue: ${s.title}</b><span class="muted">Next: ${s.nextLabel}</span></a><button class="icon-btn" data-discard="${s.id}" aria-label="Discard ${s.title}">${icon('trash')}</button></div>`))}
        <a class="btn primary big" href="#/session/new/fresh">${icon('plus')}<span>Start a new occasion</span></a></div>`;
      $$('[data-discard]', el).forEach(b => b.onclick = () => discard(b.dataset.discard, () => {}, true));
      return;
    }
    const s = newSession();
    state.sessions.unshift(s); save();
    location.replace(`#/session/${s.id}`);
    return;
  }
  const s = sess(id);
  if (!s) { el.innerHTML = html`<div class="page">${shellHead('Occasion not on this browser', '#/home')}<p class="lead">This occasion isn't saved in this browser.</p><p class="muted">Style You keeps everything on the phone and browser where you started. If you started it in the Style You app on your Home Screen, open it there and paste the reply. If you discarded it, start a new one.</p><div class="btn-col"><a class="btn primary" href="#/home">Go to Today</a><a class="btn secondary" href="#/session/new">Start a new occasion</a></div></div>`; return; }
  const view = ui.params[1] && STEPS.some(x => x.id === ui.params[1]) && STEPS.findIndex(x => x.id === ui.params[1]) <= s.stepIndex ? ui.params[1] : s.step;
  const fn = { brief, send, choose, picture, compare, products, done }[view];
  el.innerHTML = html`<div class="page session">${shellHead(s.title, '#/home', s)}${rail(s, view)}<div class="step"></div></div>`;
  $('[data-exit]', el)?.addEventListener('click', () => { save(); go('home'); toast('Saved. Continue any time from Today.', { ms: 3000 }); });
  $('[data-smenu]', el)?.addEventListener('click', () => sessionMenu(s));
  $('[data-aisheet]', el)?.addEventListener('click', () => aiSheet(s));
  $$('.rail [data-go]', el).forEach(b => b.onclick = () => go(`session/${s.id}/${b.dataset.go}`));
  return fn(s, $('.step', el));
});

function shellHead(title, back, s = null) {
  return raw(html`<header class="page-head"><div class="ph-row">
    <a class="back" href="${back}" aria-label="Back to Today">${icon('back')}<span>Today</span></a>
    ${s ? raw(html`<div class="ph-act"><button class="btn small ghost" data-exit>Save &amp; exit</button><button class="icon-btn" data-smenu aria-label="More">${icon('more')}</button></div>`) : ''}</div>
    <h1>${title}</h1>${s?.occasion?.date ? raw(html`<p class="sub">${[prettyDate(s.occasion.date), s.occasion.place, s.occasion.setting, [s.occasion.weatherTemp, ...(s.occasion.weatherExtras || [])].filter(Boolean).join(' + ')].filter(Boolean).join(' · ')}</p>`) : ''}</header>`);
}
function rail(s, view) {
  const cur = STEPS.find(x => x.id === view).rail;
  const reached = STEPS[s.stepIndex].rail;
  const firstStepOf = r => STEPS.find(x => x.rail === r).id;
  const apps = RAIL.map((_, i) => RAIL_STAGE[i] && !(RAIL_STAGE[i] === 'shopping' && s.occasion?.noShopping) ? aiName(aiForStage(RAIL_STAGE[i], s)) : '');
  const noShop = !!s.occasion?.noShopping || s.shopStatus === 'not-needed';
  return raw(html`<ol class="rail" aria-label="Progress">${RAIL.map((l, i) => raw(html`<li class="${i < reached ? 'done' : ''}${i === cur ? ' cur' : ''}">${i <= reached && i !== cur && i < 4 && !(i === 2 && noShop) ? raw(html`<button data-go="${firstStepOf(i)}">${l}</button>`) : raw(`<span ${i === cur ? 'aria-current="step"' : ''}>${l}</span>`)}</li>`))}</ol>
    <button class="rail-apps" data-aisheet aria-label="AI app for each step: ${RAIL.map((l, i) => apps[i] ? `${l} ${apps[i]}` : '').filter(Boolean).join(', ')}. Tap to change.">${apps.map(a => raw(html`<span>${a}</span>`))}</button>`);
}
function sessionMenu(s) {
  const m = openSheet(html`<div class="menu">
    <button data-a="ai">${icon('refresh')}<span>AI for this occasion</span></button>
    <button data-a="brief">${icon('paste')}<span>Change the answers</span></button>
    <button data-a="discard" class="danger-text">${icon('trash')}<span>Discard this occasion</span></button></div>`, { title: s.title });
  m.body.addEventListener('click', async e => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    await m.close();
    if (a === 'ai') aiSheet(s);
    if (a === 'brief') go(`session/${s.id}/brief`);
    if (a === 'discard') discard(s.id, () => go('home'));
  });
}
// One place to choose the AI app for each step of this occasion. It writes the occasion's own choice per step,
// which always wins over the routing in Settings, so what it shows is what each step will open.
function setStageAI(s, key, w) { s.bridge = { ...(s.bridge || {}), stageAI: { ...(s.bridge?.stageAI || {}), [key]: w }, preferred: w }; s.updatedAt = new Date().toISOString(); save(); }
function aiSheet(s) {
  const body = () => html`<p class="muted">Choose the app for each step. Style You resends everything a step needs, so you can switch at any point.</p>
    <div class="ai-steps">${STAGES.map(([k, l]) => { const cur = aiForStage(k, s); return raw(html`<div class="route-row"><span>${l}</span><div class="seg" role="radiogroup" aria-label="${l}">${['gemini', 'chatgpt'].map(w => raw(html`<button role="radio" aria-checked="${cur === w}" data-stage="${k}" data-w="${w}">${aiName(w)}</button>`))}</div></div>`); })}</div>
    <div class="btn-col"><button class="btn secondary" data-all="gemini">Use Gemini for every step</button><button class="btn secondary" data-all="chatgpt">Use ChatGPT for every step</button><button class="btn primary" data-close="1">Done</button></div>`;
  const m = openSheet(body(), { title: 'AI for this occasion', onClose: () => { if (ui.route === 'session') render(); } });
  m.body.addEventListener('click', e => {
    const b = e.target.closest('[data-stage]'), all = e.target.closest('[data-all]');
    if (b) setStageAI(s, b.dataset.stage, b.dataset.w);
    if (all) for (const [k] of STAGES) setStageAI(s, k, all.dataset.all);
    if (b || all) {
      for (const x of $$('[data-stage]', m.body)) x.setAttribute('aria-checked', String(aiForStage(x.dataset.stage, s) === x.dataset.w));
      if (all) toast(`${aiName(all.dataset.all)} for every step`, { ms: 2000 });
    }
  });
}
function discard(id, then, fromList = false) {
  const s = sess(id); if (!s) return;
  const drop = [s.photoId].filter(Boolean);
  then();
  mutate(st => { st.sessions = st.sessions.filter(x => x.id !== id); }, { undo: `“${s.title}” discarded`, dropImages: drop, rerender: false });
  if (fromList) { if (activeSessions().length) render(); else go('home'); }
}

// ---------- 1. brief ----------
function brief(s, el) {
  const o = s.occasion;
  const occ = OCC[o.occasionId];
  const minDate = today();
  el.innerHTML = html`<h2 class="step-h">Tell us about it</h2>
    <div class="field"><span>Occasion</span><div class="chips wrap" role="radiogroup" aria-label="Occasion">${OCCASIONS.map(x => raw(html`<button class="chip${o.occasionId === x.id ? ' on' : ''}" aria-pressed="${o.occasionId === x.id}" data-occ="${x.id}">${x.label}</button>`))}</div></div>
    ${occ?.subs?.length ? raw(html`<div class="field"><span>Which part?</span><div class="chips wrap">${occ.subs.map(x => raw(html`<button class="chip${o.sub === x ? ' on' : ''}" aria-pressed="${o.sub === x}" data-sub="${x}">${x}</button>`))}</div></div>`) : ''}
    <label class="field"><span>Describe it ${o.occasionId === 'other' ? '' : '(optional)'}</span><input name="description" maxlength="120" placeholder="e.g. Cousin's haldi in a garden" value="${o.description}"></label>
    <div class="grid2"><label class="field"><span>Date</span><input type="date" name="date" min="${minDate}" value="${o.date}"></label>
      <div class="field"><span>Time of day</span><div class="chips">${DAYPARTS.map(x => raw(html`<button class="chip${o.daypart === x ? ' on' : ''}" aria-pressed="${o.daypart === x}" data-daypart="${x}">${x}</button>`))}</div></div></div>
    <div class="field"><span>Place</span><button class="colour-btn" data-place>${icon('pin')}<span>${o.place || 'Choose place'}</span>${icon('chevron')}</button></div>
    <div class="field"><span>Mostly</span><div class="chips">${SETTINGS.map(x => raw(html`<button class="chip${o.setting === x ? ' on' : ''}" aria-pressed="${o.setting === x}" data-setting="${x}">${x}</button>`))}</div></div>
    <div class="field wfield">${weatherField(o)}</div>
    <div class="field"><span>Style</span><div class="chips">${STYLE_DIR.map(x => raw(html`<button class="chip${o.style === x ? ' on' : ''}" aria-pressed="${o.style === x}" data-style="${x}">${x}</button>`))}</div></div>
    <label class="check switch-row"><input type="checkbox" name="noShopping" ${raw(o.noShopping ? 'checked' : '')}><span><b>Use only my wardrobe</b><em class="muted">No shopping: the looks use only clothes you already own.</em></span></label>
    ${o.noShopping ? '' : raw(html`<label class="field"><span>Budget for anything new (₹, optional)</span><input name="budget" inputmode="numeric" maxlength="7" placeholder="e.g. 5000" value="${o.budget}"></label>`)}
    <details class="more"${raw(o.notes || o.audience ? ' open' : '')}><summary>Customs, comfort, who'll be there (optional)</summary>
      <label class="field"><span>Customs, comfort or things to avoid</span><textarea name="notes" rows="2" maxlength="300" placeholder="e.g. no black; must walk a lot; covered shoulders">${o.notes}</textarea></label>
      <div class="field"><span>Avoid repeating what I wore in front of</span><div class="chips">${AUDIENCES.map(x => raw(html`<button class="chip${o.audience === x ? ' on' : ''}" aria-pressed="${o.audience === x}" data-aud="${x}">${x}</button>`))}</div></div></details>
    <div class="sticky-save"><button class="btn primary big" data-next>Continue</button></div>`;

  const upd = () => { s.title = titleFor(o); save(); };
  const toggle = (attr, key) => $$(`[data-${attr}]`, el).forEach(b => b.onclick = () => {
    o[key] = o[key] === b.dataset[attr] ? (key === 'occasionId' ? o[key] : '') : b.dataset[attr];
    if (key === 'occasionId') o.sub = '';
    if (key === 'audience' && !o.audience) o.audience = null;
    upd(); brief(s, el);
  });
  toggle('occ', 'occasionId'); toggle('sub', 'sub'); toggle('daypart', 'daypart'); toggle('setting', 'setting'); toggle('style', 'style'); toggle('aud', 'audience');
  $('[name=description]', el).oninput = e => { o.description = e.target.value; upd(); };
  $('[name=notes]', el).oninput = e => { o.notes = e.target.value; save(); };
  const bud = $('[name=budget]', el); if (bud) bud.oninput = e => { const v = e.target.value.replace(/[^\d]/g, ''); e.target.value = v; o.budget = v; save(); };
  $('[name=noShopping]', el).onchange = e => { o.noShopping = e.target.checked; if (o.noShopping) o.budget = ''; save(); brief(s, el); };
  $('[name=date]', el).onchange = e => { o.date = e.target.value; o.weatherSummary = ''; o.weatherStatus = ''; save(); fetchWeather(s, el); };
  wireWeatherField(s, el);
  $('[data-place]', el).onclick = () => {
    const m = openSheet(citySearchHTML(null).__raw, { title: 'Where is it?' });
    wireCitySearch(m.body, async c => { if (!c) return; o.place = c.short || c.name; o.placeCoords = { lat: c.lat, lon: c.lon }; o.weatherSummary = ''; o.weatherStatus = ''; save(); await m.close(); brief(s, el); fetchWeather(s, el); });
  };
  $('[data-next]', el).onclick = () => {
    if (!o.occasionId) { toast('Choose the occasion first', { ms: 2500 }); $('[data-occ]', el).focus(); return; }
    if (o.occasionId === 'other' && !o.description.trim()) { toast('Describe the occasion in a few words', { ms: 2500 }); $('[name=description]', el).focus(); return; }
    if (o.date && daysBetween(today(), o.date) < 0) { toast('That date has passed. Choose today or later.', { ms: 3000 }); return; }
    s.title = titleFor(o);
    if (s.stepIndex < 1) setStep(s, 'send'); else save();
    go(`session/${s.id}`);
  };
  if (o.date && !o.weatherStatus) fetchWeather(s, el);
}
function weatherField(o) {
  return raw(html`<span>Weather</span><p class="muted small wsum">${o.weatherSummary || (o.date ? '' : 'Pick a date to get the forecast.')}</p>${weatherPickerHTML({ temp: o.weatherTemp, extras: o.weatherExtras })}${CREDIT}`);
}
function wireWeatherField(s, el) {
  const o = s.occasion;
  wireWeatherPicker($('.wfield', el), { temp: o.weatherTemp, extras: [...(o.weatherExtras || [])] }, v => { o.weatherTemp = v.temp; o.weatherExtras = v.extras; o.weatherStatus = o.weatherStatus === 'ok' ? 'edited' : o.weatherStatus || 'manual'; save(); });
}
async function fetchWeather(s, el) {
  const o = s.occasion;
  const sum = $('.wsum', el); if (!sum) return;
  if (!o.date) return;
  if (!o.placeCoords) { sum.textContent = 'Choose the place to get the forecast, or pick the conditions.'; return; }
  sum.textContent = 'Getting the forecast…';
  try {
    const w = await forecastFor(o.placeCoords.lat, o.placeCoords.lon, o.date);
    o.weatherStatus = w.status; o.weatherSummary = w.summary;
    if (w.status === 'ok') { o.weatherTemp = w.temp; o.weatherExtras = w.extras; }
    save();
    const f = $('.wfield', el);
    if (f && document.contains(f)) { f.innerHTML = weatherField(o).__raw; wireWeatherField(s, el); }
  } catch {
    sum.textContent = 'Forecast unavailable right now — pick the conditions.';
  }
}

// ---------- 2. send photo + brief, bring back 3 looks ----------
async function send(s, el) {
  const photoBlob = s.photoId ? await store.getImage(s.photoId) : null;
  if (s.photoId && !photoBlob && (await store.imageExists(s.photoId)) === 'no') { s.photoId = null; save(); }
  const file = photoBlob ? new File([photoBlob], 'my-photo.jpg', { type: 'image/jpeg' }) : null;
  let wardrobeFile = null;
  try {
    const visual = state.wardrobe.filter(w => w.status !== 'Archived' && availableNow(w) && (w.photo?.full || w.photo?.thumb)).slice(0, 12);
    if (visual.length >= 2) {
      const entries = [];
      // The sheet's tiles are 520 px wide, so they are drawn from the 800 px photos (the 200 px thumbnails would blur).
      for (const w of visual) entries.push({ code: w.code, name: w.name, hex: w.colour?.hex, blob: (w.photo.full && await store.getImage(w.photo.full)) || (w.photo.thumb && await store.getImage(w.photo.thumb)) || null });
      const sheet = await contactSheet(entries);
      wardrobeFile = new File([sheet], `style-you-wardrobe-${s.id}.jpg`, { type: 'image/jpeg' });
    }
  } catch { wardrobeFile = null; }
  // Your photo always goes first: the request calls it Image 1.
  const sendFiles = file ? [{ file, label: 'your photo' }, wardrobeFile && { file: wardrobeFile, label: 'the wardrobe sheet' }].filter(Boolean) : [];
  const text = () => occasionRequest({ ...s, occasion: { ...s.occasion, alreadyWorn: alreadyWorn(s.occasion.audience) } }, state.profile, wardrobeLines(state.wardrobe.filter(w => w.status !== 'Archived'), availableNow), { sheet: !!wardrobeFile });
  const provider = aiForStage('looks', s);
  const name = aiName(provider);
  el.innerHTML = html`<h2 class="step-h">1. Your photo</h2>
    ${photoBlob ? raw(html`<div class="me-row"><img data-img="${s.photoId}" alt="Your photo" class="me-thumb"><div><b>Full-length photo ready</b><button class="linkish" data-photo>Use a different photo</button>${s.photoFromCamera ? raw('<button class="linkish" data-savephoto>Save it to your phone</button>') : ''}</div></div>`)
    : raw(html`<p>A clear, full-length photo of just you: standing, good light, plain background. It stays on this device and goes only to ${name} when you send it.</p>
      <div class="btn-col"><button class="btn primary" data-photo>${icon('image')}<span>Choose a photo</span></button><button class="btn secondary" data-camera>${icon('camera')}<span>Take a guided photo</span></button></div>`)}
    <h2 class="step-h">2. Send it to ${name}</h2>
    ${file ? handoffHTML({ text: text(), which: provider, files: sendFiles, sendLabel: `Send to ${name}`, sessionId: s.id, stage: 'looks', after: [`${name} replies with 3 looks in text.`] }) : raw('<p class="muted">Add your photo first.</p>')}
    <h2 class="step-h">3. Bring the 3 looks back</h2>
    <p class="muted">In ${name}, tap <b>Copy</b> under the reply${isAndroid ? ', or Share it to Style You' : ''}, then come back.</p>
    ${pasteHTML({ label: 'Paste the reply' })}<div class="parse-msg"></div>`;
  hydrate(el);
  const usePhoto = async (f, cam = false) => {
    if (!f) return;
    try {
      const { blob, w, h } = await shrink(f, 1080, 0.85);
      const id = await store.putImage(blob, 'me', { w, h });
      const old = s.photoId; s.photoId = id; s.photoFromCamera = cam;
      if (state.profile.keepPhotos && !state.profile.myPhoto) state.profile.myPhoto = id;
      save(); if (old && !isImageUsed(old)) store.deleteImage(old);
      send(s, el);
    } catch (e) { toast(e.message, { ms: 4000 }); }
  };
  $('[data-photo]', el)?.addEventListener('click', async () => { const [f] = await pickFiles({ accept: 'image/*' }); usePhoto(f); });
  $('[data-camera]', el)?.addEventListener('click', async () => usePhoto(await guidedPhoto(), true));
  $('[data-savephoto]', el)?.addEventListener('click', () => shareOrOffer(file, '', 'Save your photo'));
  wireHandoff(el, { text, files: sendFiles, onSent: (method) => { s.sentAt = new Date().toISOString(); s.bridge = { ...(s.bridge || {}), lastMethod: method, lastSentAt: s.sentAt, preferred: provider }; save(); }, onSwitch: w => { setStageAI(s, 'looks', w); render(); } });
  wirePaste(el, t => receiveLooks(s, t, el));
}
function alreadyWorn(aud) {
  if (!aud) return '';
  const codes = new Set();
  for (const w of state.worn) if (w.audience === aud) for (const id of (w.baseIds || [])) { const it = itemById(id); if (it) codes.add(it.code); }
  return [...codes].slice(0, 30).join(', ');
}
// A pasted reply that names a different open occasion is not used here; the user can move it there.
function wrongSession(s, text, el, receive) {
  const sid = readSessionId(text);
  if (!sid || sid === s.id) return false;
  const other = sess(sid);
  const msg = el ? $('.parse-msg', el) : null;
  if (!other) {
    // Written for an occasion this browser doesn't have (another browser, or one that was discarded): ask, don't guess.
    if (!msg || ui.useHere === text) { ui.useHere = null; return false; }
    msg.innerHTML = html`<div class="card warn-card"><b>This reply was written for a different occasion</b><p>That occasion isn't saved in this browser. If you started it in the Style You app on your Home Screen, paste the reply there. Or use it for “${s.title}”.</p><button class="btn secondary" data-usehere>Use it for “${s.title}”</button></div>`;
    $('[data-usehere]', msg).addEventListener('click', () => { ui.useHere = text; receive(s, text, el); });
    msg.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  }
  if (!msg) return true;
  // Only offer the move when that occasion is waiting for this kind of reply; never roll back one that moved on.
  const waiting = other.status === 'active' && (receive === receiveLooks ? LOOK_STEPS : PRODUCT_STEPS).includes(other.step);
  msg.innerHTML = html`<div class="card warn-card"><b>This reply is for “${other.title}”</b><p>It was written for another occasion${other.status !== 'active' ? ' that is already finished' : waiting ? '' : ', which has moved past this step'}.</p>${waiting ? raw(html`<button class="btn secondary" data-move>Use it for “${other.title}”</button>`) : ''}</div>`;
  $('[data-move]', msg)?.addEventListener('click', () => receive(other, text, null));
  msg.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}
function receiveLooks(s, text, el) {
  if (wrongSession(s, text, el, receiveLooks)) return false;
  const looks = parseLooks(text, state.wardrobe);
  const msg = el ? $('.parse-msg', el) : null;
  const ai = aiName(aiForStage('looks', s));
  if (!looks.length) {
    const photoProblem = /full[- ]length|clear(er)? photo|one (adult )?person|can(no|')t see|not (a )?clear|another photo|different photo|upload a photo|attach (a|your) photo/i.test(text);
    const html2 = photoProblem
      ? html`<div class="card warn-card"><b>${ai} asked for a better photo</b><p>Use a clear, full-length photo of just you, then send again.</p></div>`
      : html`<div class="card warn-card"><b>Couldn't find the 3 looks in that text</b><p>Make sure you copied the whole reply. Or ask ${ai} to repeat it in the right format:</p><button class="btn secondary" data-fix>${icon('copy')}<span>Copy “please repeat in the right format”</span></button></div>`;
    if (msg) { msg.innerHTML = html2; $('[data-fix]', msg)?.addEventListener('click', () => copyNow(fixFormatRequest('LOOK')).then(() => toast(`Copied. Paste it in the same ${ai} chat.`, { ms: 3500 }))); msg.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    else toast('Couldn\'t find the 3 looks in what was shared.', { ms: 4000 });
    return false;
  }
  const old = savedLook(s);
  if (old) { if (old.pictures?.after || old.products?.length) s.lookId = null; else { state.looks = state.looks.filter(l => l.id !== old.id); s.lookId = null; } }
  s.looksText = text.slice(0, 20000); s.looks = looks; s.chosen = null; s.pictures = {};
  setStep(s, 'choose');
  go(`session/${s.id}/choose`);
  if (!el) toast(`3 looks received for “${s.title}”`, { ms: 3000 });
  recordAIInbox({ sessionId: s.id, provider: aiForStage('looks', s), type: 'looks', title: '3-look reply received', detail: `${looks.length} look${looks.length === 1 ? '' : 's'} attached to ${s.title}`, route: `session/${s.id}/choose` });
  if (looks.length < 3) toast(`Found ${plural(looks.length, 'look')}.`, { ms: 3000 });
  return true;
}

// ---------- 3. choose ----------
function choose(s, el) {
  const name = aiName(aiForStage('looks', s));
  const noShop = !!s.occasion?.noShopping;
  el.innerHTML = html`<h2 class="step-h">Pick a look</h2><p class="muted">${noShop ? `You asked for your own clothes only. ${aiName(aiForStage('preview', s))} then makes your styled preview.` : `If anything is missing, find the actual products first. Then ${aiName(aiForStage('preview', s))} makes your styled preview.`}</p>
    <div class="look-choices" role="radiogroup" aria-label="Looks">${s.looks.map(l => { const own = l.pieces.filter(p => p.owned).length; return raw(html`<button class="look-choice${s.chosen === l.number ? ' on' : ''}" role="radio" aria-checked="${s.chosen === l.number}" data-n="${l.number}">
      <div class="row between"><b>Look ${l.number} · ${l.name}</b><span class="pill${own === l.pieces.length ? ' ok' : ''}">${own} of ${l.pieces.length} owned</span></div>
      ${l.why ? raw(html`<p>${l.why}</p>`) : ''}
      <ul class="mini-pieces">${l.pieces.map(p => raw(html`<li>${p.owned ? raw(`<span class="own">${icon('check').__raw}</span>`) : raw('<span class="buy">+</span>')}<span>${p.name}</span>${p.owned && p.code ? raw(html`<em>${p.code}</em>`) : ''}</li>`))}</ul>
      ${l.pieces.some(p => p.warning) ? raw(html`<p class="warn small">${l.pieces.filter(p => p.warning).map(p => p.warning).join(' ')}</p>`) : ''}
      ${noShop && l.pieces.some(p => !p.owned) ? raw(html`<p class="warn small nonowned">Has ${l.pieces.filter(p => !p.owned).length === 1 ? 'a piece' : 'pieces'} you don't own, even though you asked for your own clothes only.</p>`) : ''}
    </button>`); })}</div>
    <details class="more"><summary>None of these? Ask for changes</summary><div class="chips wrap">${FOLLOW_UPS.map(f => raw(html`<button class="chip" data-fu="${f}">${f}</button>`))}<button class="chip" data-fu="3 different looks">3 different looks</button></div>
      <p class="muted small">Copies the request. Paste it in the same chat, then bring the new reply back here.</p>${pasteHTML({ label: 'Paste the new reply' })}<div class="parse-msg"></div></details>
    <div class="sticky-save"><button class="btn primary big" data-next ${raw(s.chosen ? '' : 'disabled')}>${s.chosen && !noShop && chosenLook(s)?.pieces?.some(p => !p.owned) ? 'Next: find missing pieces' : 'Next: styled preview'}</button></div>`;
  $$('[data-n]', el).forEach(b => b.onclick = async () => {
    const n = +b.dataset.n;
    if (n === s.chosen) return;
    const old = savedLook(s);
    const hadWork = !!(s.pictures?.after || old?.products?.length);
    if (hadWork && !(await confirmSheet({ title: `Switch to Look ${n}?`, text: `Look ${s.chosen} keeps its picture and products in My Looks. This occasion carries on with Look ${n}, so you'll get a new picture for it.`, ok: `Switch to Look ${n}` }))) return;
    mutate(() => {
      if (hadWork) {
        // keep the finished look as it is (save it first if it was never saved)
        if (!old) { const pics = { ...s.pictures }; syncLook(s); const l = savedLook(s); if (l) l.pictures = { before: state.profile.keepPhotos ? s.photoId : null, ...pics }; }
        s.lookId = null; s.pictures = {};
      }
      s.chosen = n; syncLook(s);
      if (s.stepIndex > 2) setStep(s, 'choose');
    }, { undo: `Look ${n} chosen` });
  });
  $$('[data-fu]', el).forEach(b => b.onclick = () => {
    const t = b.dataset.fu === '3 different looks' ? `Please give me 3 different looks in exactly the same STYLEYOU format, text only.` : `${b.dataset.fu}, please. Give me 3 updated looks in exactly the same STYLEYOU format, text only.`;
    copyNow(`${t}\nStart your reply with the line STYLEYOU_SESSION: ${s.id} exactly as written.`).then(ok => toast(ok ? `Copied. Paste it in the same ${name} chat.` : 'Copy did not work', { ms: 3500 }));
  });
  wirePaste(el, t => receiveLooks(s, t, el));
  $('[data-next]', el).onclick = async () => {
    if (!s.chosen) return;
    const l = chosenLook(s);
    const unowned = (l?.pieces || []).filter(p => !p.owned).length;
    if (!s.occasion?.noShopping && unowned) { setStep(s, 'products'); go(`session/${s.id}/products`); return; }
    if (s.occasion?.noShopping && unowned && !(await confirmSheet({ title: 'Some pieces are not yours', text: `Look ${l.number} has ${unowned === 1 ? 'a piece' : `${unowned} pieces`} you don't own, although you asked for your own clothes only. You can carry on (the styled preview will show ${unowned === 1 ? 'it' : 'them'}), or pick another look.`, ok: 'Carry on with this look', cancel: 'Pick another look' }))) return;
    s.shopStatus = s.occasion?.noShopping ? 'skipped' : 'not-needed'; setStep(s, 'picture'); go(`session/${s.id}/picture`);
  };
}
// The chosen look is saved to My Looks straight away and kept in step with the session.
function syncLook(s) {
  const l = chosenLook(s);
  const o = s.occasion;
  if (!l) { if (s.lookId) { state.looks = state.looks.filter(x => x.id !== s.lookId); s.lookId = null; } return; }
  const pieces = l.pieces.map((p, i) => { const w = p.wardrobeId ? itemById(p.wardrobeId) : null; return { key: `p${i}`, name: p.name, category: p.category || (CAT[p.guess]?.label ?? ''), owned: !!w, wardrobeId: w?.id || null, code: w?.code || '', hex: w?.colour?.hex || null, thumb: w?.photo?.thumb || null }; });
  let look = savedLook(s);
  if (!look) { look = newLook({ source: 'occasion', sessionId: s.id }); state.looks.unshift(look); s.lookId = look.id; }
  Object.assign(look, { title: `Look ${l.number} · ${l.name}`, number: l.number, why: l.why, occasion: OCC[o.occasionId]?.label || '', sub: o.sub || o.description || '', date: o.date || today(), budget: o.budget ? +o.budget : null, pieces, products: [], pictures: { before: state.profile.keepPhotos ? s.photoId : null } });
  s.pictures = {}; s.shopStatus = l.pieces.some(p => !p.owned) ? 'pending' : 'not-needed';
}

// ---------- 4. picture ----------
async function picture(s, el) {
  const l = chosenLook(s); if (!l) { setStep(s, 'choose'); go(`session/${s.id}/choose`); return; }
  const provider = aiForStage('preview', s);
  const name = aiName(provider);
  const look = savedLook(s);
  const productRefs = look?.products || [];
  const original = s.photoId ? await store.getImage(s.photoId) : null;
  // Forget the photo only when it is really gone, not after a passing storage error.
  if (s.photoId && !original && (await store.imageExists(s.photoId)) === 'no') { s.photoId = null; save(); }
  const photoFile = original ? new File([original], `style-you-${s.id}.jpg`, { type: original.type || 'image/jpeg' }) : null;
  const files = photoFile ? [{ file: photoFile, label: 'your photo' }] : [];
  el.innerHTML = html`<h2 class="step-h">Get your styled preview</h2>
    ${photoFile ? handoffHTML({ text: pictureRequest(l, productRefs, s.id), which: provider, files, sessionId: s.id, stage: 'preview', sendLabel: `Send look + photo to ${name}`, after: [`${name} edits your photo into Look ${l.number}.`], note: 'Picture limits depend on your plan with Google or OpenAI.' })
    : raw(html`<div class="card warn-card"><b>Your photo isn't on this phone any more</b><p>The styled preview is made from your full-length photo. Choose it again to continue.</p><div class="btn-col"><button class="btn primary" data-rephoto>${icon('image')}<span>Choose your photo</span></button></div></div>`)}
    <h2 class="step-h">Bring the picture back</h2>
    <div class="cmp-wait">${s.photoId ? raw(html`<figure>${img(s.photoId, { alt: 'Your photo' })}<figcaption>You now</figcaption></figure>`) : ''}<figure class="waiting"><span>${icon('image')}</span><figcaption>Proposed look — waiting for picture</figcaption></figure></div>
    ${pictureReturnHTML(provider)}
    <p class="muted small center">Your original photo is kept for this styling session only unless you choose to remember it in Settings.</p>`;
  hydrate(el);
  wireHandoff(el, { text: () => pictureRequest(l, productRefs, s.id), files, onSwitch: w => { setStageAI(s, 'preview', w); render(); toast(`Now using ${aiName(w)} for previews — Style You will send the photo and full look again.`, { ms: 4000 }); } });
  $('[data-rephoto]', el)?.addEventListener('click', async () => {
    const [f] = await pickFiles({ accept: 'image/*' }); if (!f) return;
    try { const { blob, w, h } = await shrink(f, 1080, 0.85); s.photoId = await store.putImage(blob, 'me', { w, h }); save(); render(); }
    catch (e) { toast(e.message, { ms: 4000 }); }
  });
  wirePictureReturn(el, b => receivePicture(s, b));
}
async function receivePicture(s, blob) {
  try {
    const p = await keepPicture(blob, 'look');
    const old = [s.pictures?.after, s.pictures?.afterThumb].filter(Boolean);
    s.pictures = { after: p.full, afterThumb: p.thumb };
    const look = savedLook(s);
    if (look) look.pictures = { ...(look.pictures || {}), before: state.profile.keepPhotos ? s.photoId : null, after: p.full, afterThumb: p.thumb };
    state.settings.photosSinceBackup = (state.settings.photosSinceBackup || 0) + 1;
    setStep(s, 'compare');
    recordAIInbox({ sessionId: s.id, provider: aiForStage('preview', s), type: 'image', title: 'Styled preview received', detail: s.title, route: `session/${s.id}/compare` });
    for (const id of old) if (!isImageUsed(id)) store.deleteImage(id);
    go(`session/${s.id}/compare`);
  } catch (e) { toast('That picture could not be used: ' + e.message, { ms: 5000 }); }
}

// ---------- 5. compare ----------
async function compare(s, el) {
  const l = chosenLook(s); if (!s.pictures?.after || !l) { setStep(s, 'picture'); go(`session/${s.id}/picture`); return; }
  const provider = aiForStage('preview', s);
  const name = aiName(provider);
  const original = s.photoId ? await store.getImage(s.photoId) : null;
  const files = original ? [{ file: new File([original], `style-you-${s.id}.jpg`, { type: original.type || 'image/jpeg' }), label: 'your photo' }] : [];
  el.innerHTML = html`<h2 class="step-h">Look ${l.number} · ${l.name}</h2>
    ${compareHTML(s.photoId, s.pictures.after)}
    <div class="btn-col"><button class="btn primary big" data-ok>Looks right — save</button>
      <button class="btn secondary" data-nomatch>${icon('warn')}<span>This doesn't match</span></button>
      <button class="btn ghost" data-replace>${icon('image')}<span>Replace picture</span></button></div>
    <div class="nomatch"${raw(ui.nomatchOpen === s.id ? '' : ' hidden')}>${files.length ? handoffHTML({ text: correctionRequest(l, s.id), which: provider, files, sessionId: s.id, stage: 'correction', sendLabel: `Send correction + photo to ${name}`, after: ['Bring the new picture back below.'] }) : raw('<p class="warn">Your original photo is no longer on this phone. Use “Replace picture” to bring in a new one.</p>')}${pictureReturnHTML(provider)}</div>`;
  ui.nomatchOpen = null;
  hydrate(el); wireCompare(el);
  $('[data-ok]', el).onclick = () => finish(s);
  $('[data-nomatch]', el).onclick = () => { const n = $('.nomatch', el); n.hidden = false; n.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  $('[data-replace]', el).onclick = () => { const s2 = openSheet(pictureReturnHTML(provider).__raw, { title: 'Replace picture' }); wirePictureReturn(s2.body, async b => { await s2.close(); receivePicture(s, b); }); };
  wireHandoff($('.nomatch', el), { text: () => correctionRequest(l, s.id), files, onSwitch: w => { setStageAI(s, 'preview', w); ui.nomatchOpen = s.id; render(); toast(`Now using ${aiName(w)} for the corrected picture.`, { ms: 3000 }); } });
  wirePictureReturn($('.nomatch', el), b => receivePicture(s, b));
}

// ---------- 6. products ----------
function products(s, el) {
  const l = chosenLook(s); if (!l) { go(`session/${s.id}`); return; }
  const look = savedLook(s);
  const provider = aiForStage('shopping', s);
  const name = aiName(provider);
  const missing = l.pieces.filter(p => !p.owned);
  if (!missing.length || s.occasion?.noShopping) {
    s.shopStatus = s.occasion?.noShopping ? 'skipped' : 'not-needed';
    // Never move an occasion back: only step forward to the picture if it hasn't got there yet.
    if (s.stepIndex < STEPS.findIndex(x => x.id === 'picture')) setStep(s, 'picture'); else save();
    go(`session/${s.id}/${s.stepIndex >= STEPS.findIndex(x => x.id === 'picture') ? s.step : 'picture'}`); return;
  }
  const prods = look?.products || [];
  el.innerHTML = html`<h2 class="step-h">Find the pieces you don't own</h2>
    <p class="muted">Finding the products before the preview helps the AI visualise the look closer to what you can actually buy.</p>
    <ul class="mini-pieces">${missing.map(p => raw(html`<li><span class="buy">+</span><span>${p.name}</span></li>`))}</ul>
    ${handoffHTML({ text: productsRequest(l, s, state.profile), which: provider, sessionId: s.id, stage: 'shopping', after: ['Copy the reply and come back.'] })}
    ${pasteHTML({ label: 'Paste the product list' })}<div class="parse-msg"></div>
    ${prods.length ? raw(productListHTML(look)) : ''}
    <div class="sticky-save"><button class="btn primary big" data-finish>${prods.length ? 'Continue to styled preview' : 'Skip product search and continue'}</button></div>`;
  wireHandoff(el, { text: () => productsRequest(l, s, state.profile), onSwitch: w => { setStageAI(s, 'shopping', w); render(); } });
  wirePaste(el, t => receiveProducts(s, t, el));
  $('[data-finish]', el).onclick = () => { s.shopStatus = prods.length ? 'done' : 'skipped'; save(); setStep(s, 'picture'); go(`session/${s.id}/picture`); };
}
function productListHTML(look) {
  const prods = look.products || [];
  const total = prods.filter(p => p.found && Number.isFinite(p.price)).reduce((a, p) => a + p.price, 0);
  return html`<ul class="pieces">${prods.map(p => raw(html`<li class="piece"><div class="pc-txt"><b>${p.piece || p.product || 'Piece'}</b>
      <span class="muted">${p.found ? [p.brand, p.product, p.priceText].filter(Boolean).join(' · ') : p.reason}</span></div>
      ${p.found ? raw(html`<a class="btn small primary" href="${p.url}" target="_blank" rel="noopener noreferrer">${icon('external')}<span>Open on ${p.retailer}</span></a>`) : raw('<span class="pill">No exact product found</span>')}</li>`))}</ul>
    <div class="card budget"><div class="row between"><span>New items${look.budget ? ' vs budget' : ''}</span><b>${fmtINR(total) || '₹0'}${look.budget ? ` of ${fmtINR(look.budget)}` : ''}</b></div>${look.budget && total > look.budget ? raw('<p class="warn small">Over budget</p>') : ''}
    <p class="muted small">Check size, price and stock on the shop's page before buying.</p></div>`;
}
function receiveProducts(s, text, el) {
  if (wrongSession(s, text, el, receiveProducts)) return false;
  const l = chosenLook(s); const look = savedLook(s);
  if (!l) return false;
  const { items, hadBlock } = parseProducts(text);
  const msg = el ? $('.parse-msg', el) : null;
  if (!items.length) {
    const m = html`<div class="card warn-card"><b>Couldn't find the product list</b><p>Copy the whole reply, or ask for it in the right format:</p><button class="btn secondary" data-fix>${icon('copy')}<span>Copy “please repeat in the right format”</span></button></div>`;
    if (msg) { msg.innerHTML = m; $('[data-fix]', msg).onclick = () => copyNow(fixFormatRequest('PRODUCTS')).then(() => toast('Copied. Paste it in the same chat.', { ms: 3000 })); }
    return false;
  }
  const missing = l.pieces.map((p, i) => ({ ...p, key: `p${i}` })).filter(p => !p.owned);
  for (const it of items) {
    const n = normalise(it.piece);
    const m = missing.find(p => normalise(p.name) === n) || missing.find(p => n && (normalise(p.name).includes(n) || n.includes(normalise(p.name)))) || null;
    it.pieceKey = m?.key || null;
    if (m) it.piece = m.name;
  }
  if (look) look.products = items;
  s.shopStatus = 'done';
  save();
  const bad = items.filter(i => !i.found && i.reason && !/no exact/i.test(i.reason)).length;
  toast(`${plural(items.filter(i => i.found).length, 'product')} found${bad ? ` · ${bad} link${bad > 1 ? 's' : ''} rejected (not a product page)` : ''}${hadBlock ? '' : ' (read without the format markers — please check)'}`, { ms: 5000 });
  recordAIInbox({ sessionId: s.id, provider: aiForStage('shopping', s), type: 'products', title: 'Shopping reply received', detail: `${items.length} product reference${items.length === 1 ? '' : 's'} attached`, route: `session/${s.id}/products` });
  if (el) products(s, el); else go(`session/${s.id}/products`);
  return true;
}

// ---------- 7. done ----------
function finish(s) {
  setStep(s, 'done');
  go(`session/${s.id}/done`);
}
function done(s, el) {
  const look = savedLook(s);
  const complete = !!s.pictures?.after;
  if (complete && s.status !== 'complete') { s.status = 'complete'; save(); }
  if (complete && !state.profile.keepPhotos && s.photoId) { const id = s.photoId; s.photoId = null; save(); if (!isImageUsed(id)) store.deleteImage(id); }
  el.innerHTML = html`<div class="done-hero">${icon('check')}<h2>${complete ? 'Saved to My Looks' : 'Saved — picture still needed'}</h2>
    <p class="muted">${complete ? 'Rate it now or after the occasion. Share it to ask family.' : 'This occasion stays open on Today until the picture is added.'}</p></div>
    ${look?.pictures?.afterThumb ? raw(html`<div class="done-pic">${img(look.pictures.after, { alt: look.title })}</div>`) : ''}
    <div class="btn-col">${look ? raw(html`<a class="btn primary big" href="#/look/${look.id}">Open the look</a>`) : ''}
    ${complete ? '' : raw(html`<a class="btn secondary" href="#/session/${s.id}/picture">Add the picture</a>`)}
    <a class="btn ghost" href="#/home">Back to Today</a></div>`;
  hydrate(el);
}

// ---------- things shared into the app (Android share target) ----------
// A shared reply goes to the occasion named on its STYLEYOU_SESSION line. Without that line it goes to the only
// occasion waiting for that kind of reply; when several are waiting, the user picks. Nothing is guessed.
const LOOK_STEPS = ['send', 'choose'], PRODUCT_STEPS = ['products', 'picture', 'compare', 'done'], PICTURE_STEPS = ['picture', 'compare'];
function pickSession(list, what) {
  return new Promise(resolve => {
    let done = false;
    const sh = openSheet(html`<p class="lead">Which occasion is this ${what} for?</p><div class="btn-col">${list.map(x => raw(html`<button class="btn secondary" data-sid="${x.id}">${x.title}<span class="muted small"> · next: ${x.nextLabel}</span></button>`))}<button class="btn ghost" data-close="1">Keep in AI Inbox</button></div>`, { title: 'Choose the occasion', onClose: () => { if (!done) { done = true; resolve(null); } } });
    sh.body.addEventListener('click', async e => { const b = e.target.closest('[data-sid]'); if (!b) return; done = true; await sh.close(); resolve(sess(b.dataset.sid)); });
  });
}
function noteUnmatched(text, s, why) {
  recordAIInbox({ sessionId: s?.id || null, provider: s ? aiForStage('looks', s) : null, type: 'unmatched', title: 'Shared AI reply needs review', detail: text.slice(0, 160), payload: text, route: s ? `session/${s.id}` : 'ai/inbox' });
  toast(why, { ms: 5500 });
}
async function routeShared(entry) {
  const act = activeSessions().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const file = entry.files?.find(f => /^image\//.test(f.type));
  const text = [entry.title, entry.text, entry.url].filter(Boolean).join('\n');
  const sid = text ? readSessionId(text) : '';
  const named = sid ? sess(sid) : null;
  if (file) {
    const waiting = act.filter(x => PICTURE_STEPS.includes(x.step));
    // A picture whose text names an occasion goes there or nowhere; without a name, to the only one waiting.
    let target = named ? (named.status === 'active' && PICTURE_STEPS.includes(named.step) ? named : null) : waiting.length === 1 ? waiting[0] : null;
    if (!target && !named && waiting.length > 1) target = await pickSession(waiting, 'picture');
    if (target) { await receivePicture(target, file.blob || file); toast(`Picture received for “${target.title}”`, { ms: 2500 }); return; }
    const withLook = act.filter(x => x.chosen);
    const sh = openSheet(html`<p class="lead">You shared a picture with Style You.</p><div class="btn-col"><button class="btn primary" data-i>Import as a styled image</button><button class="btn secondary" data-w>Add to my wardrobe</button>${withLook.map(x => raw(html`<button class="btn secondary" data-p="${x.id}">Use as the preview for “${x.title}”</button>`))}<button class="btn ghost" data-close="1">Ignore</button></div>`, { title: 'Shared picture' });
    $('[data-i]', sh.body).onclick = async () => { await sh.close(); ui.pendingImportBlob = file.blob || file; go('import-look'); };
    $('[data-w]', sh.body).onclick = async () => { await sh.close(); ui.pendingShared = [file.blob || file]; go('add/photos'); toast('Tap “Choose photos” to add more, or review below', { ms: 3000 }); };
    $$('[data-p]', sh.body).forEach(b => b.addEventListener('click', async () => { await sh.close(); const x = sess(b.dataset.p); if (x) receivePicture(x, file.blob || file); }));
    return;
  }
  if (!text) return;
  const isLooks = /STYLEYOU[_ ]LOOK/i.test(text), isProducts = /STYLEYOU[_ ]PRODUCTS|https?:\/\//i.test(text);
  if (!isLooks && !isProducts) { noteUnmatched(text, named || null, 'That text did not look like a Style You reply. It was noted in AI Inbox.'); return; }
  const steps = isLooks ? LOOK_STEPS : PRODUCT_STEPS;
  const receive = isLooks ? receiveLooks : receiveProducts;
  if (sid) {
    if (!named) { noteUnmatched(text, null, 'That reply is for an occasion that isn\'t on this phone. It was noted in AI Inbox.'); return; }
    if (named.status !== 'active') { noteUnmatched(text, named, `That reply is for “${named.title}”, which is already finished. It was noted in AI Inbox.`); return; }
    if (!steps.includes(named.step)) { noteUnmatched(text, named, `“${named.title}” isn't waiting for that reply. It was noted in AI Inbox.`); return; }
    receive(named, text, null); return;
  }
  const waiting = act.filter(x => steps.includes(x.step));
  if (waiting.length === 1) { receive(waiting[0], text, null); return; }
  if (waiting.length > 1) { const t = await pickSession(waiting, 'reply'); if (t) receive(t, text, null); else noteUnmatched(text, null, 'Reply saved to AI Inbox.'); return; }
  noteUnmatched(text, null, act.length ? 'No occasion is waiting for that reply. It was noted in AI Inbox.' : 'Shared reply saved to AI Inbox. Start an occasion to use it.');
}
onInbox(routeShared);
Object.defineProperty(exports,'STEPS',{enumerable:true,get:()=>STEPS});
Object.defineProperty(exports,'receiveLooks',{enumerable:true,get:()=>receiveLooks});
Object.defineProperty(exports,'receivePicture',{enumerable:true,get:()=>receivePicture});
Object.defineProperty(exports,'routeShared',{enumerable:true,get:()=>routeShared});
Object.defineProperty(exports,'receiveProducts',{enumerable:true,get:()=>receiveProducts});
};
__mods['js/views/ai.js'] = function(require,exports,module){
// AI apps: the main app, the app for each step, and AI Inbox. Browser abilities live in Settings → About → Troubleshooting.
const { state, save, route, go, aiName, unreadAI } = require('js/app.js');
const { $, $$, html, raw, icon, toast, copyText } = require('js/ui.js');
const { pageHead } = require('js/views/common.js');

const STAGE_LABEL = { looks: 'looks', shopping: 'shopping', preview: 'the styled preview', correction: 'a corrected picture' };
function when(e) { try { return new Date(e.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch { return ''; } }

route('ai', (el, [sub]) => {
  if (sub === 'inbox') return inbox(el);
  const p = state.profile;
  el.innerHTML = html`<div class="page ai-bridge">${pageHead('AI apps', { back: '#/settings', sub: 'Style You prepares each request; your own Gemini or ChatGPT does the styling.' })}
    <h2 class="section-h">Your main AI app</h2>
    <div class="provider-pick" role="radiogroup" aria-label="Main AI app">
      ${[['gemini', 'Gemini'], ['chatgpt', 'ChatGPT']].map(([v, l]) => raw(html`<button class="provider ${p.defaultAI === v ? 'on' : ''}" role="radio" aria-checked="${p.defaultAI === v}" data-ai="${v}">${icon('sparkle')}<span><b>${l}</b><em>${p.defaultAI === v ? 'Main app' : 'Tap to use'}</em></span></button>`))}
    </div>
    <h2 class="section-h">App for each step</h2>
    <div class="card route-ai"><p class="muted small">Leave these on “Main” unless you want a step to use the other one. Each occasion can also change them from its ⋯ menu.</p>
      ${[['looks', 'Looks'], ['shopping', 'Shopping'], ['preview', 'Styled previews']].map(([k, l]) => raw(html`<label class="route-row"><span>${l}</span><select data-stage-ai="${k}"><option value="default" ${raw((p.aiRouting?.[k] || 'default') === 'default' ? 'selected' : '')}>Main: ${aiName(p.defaultAI)}</option><option value="gemini" ${raw(p.aiRouting?.[k] === 'gemini' ? 'selected' : '')}>Gemini</option><option value="chatgpt" ${raw(p.aiRouting?.[k] === 'chatgpt' ? 'selected' : '')}>ChatGPT</option></select></label>`))}
    </div>
    <a class="card inbox-link" href="#/ai/inbox"><div>${icon('paste')}<span><b>AI Inbox</b><em>Replies shared to Style You, and what was sent</em></span></div><span class="pill${unreadAI() ? ' warn-pill' : ''}">${unreadAI() ? `${unreadAI()} new` : 'Nothing new'}</span></a>
    <a class="card inbox-link" href="#/settings/about"><div>${icon('info')}<span><b>Something not working?</b><em>Troubleshooting: what this browser can do</em></span></div>${icon('chevron')}</a>
  </div>`;
  $$('[data-ai]', el).forEach(b => b.onclick = () => { p.defaultAI = b.dataset.ai; save(); toast(`${aiName(p.defaultAI)} is now your main AI app`, { ms: 2500 }); go('ai'); });
  $$('[data-stage-ai]', el).forEach(sel => sel.onchange = () => { p.aiRouting = { ...(p.aiRouting || {}), [sel.dataset.stageAi]: sel.value }; save(); toast('Saved', { ms: 1800 }); });
});

function inbox(el) {
  const items = state.aiInbox || [], hand = state.handoffs || [];
  items.forEach(x => { x.read = true; }); save();
  el.innerHTML = html`<div class="page ai-inbox">${pageHead('AI Inbox', { back: '#/ai', sub: 'Replies shared to Style You and requests sent, kept on this phone only.' })}
    <h2 class="section-h">Returns</h2>
    ${items.length ? raw(html`<div class="timeline">${items.slice(0,30).map(x => raw(html`<div class="card timeline-row"><span class="timeline-ico">${icon(x.type==='image'?'image':x.type==='products'?'external':'paste')}</span><div><b>${x.title}</b><p>${x.detail || ''}</p><em>${[x.provider ? aiName(x.provider) : '', when(x)].filter(Boolean).join(' · ')}</em>${x.payload ? raw(html`<details class="inbox-payload"><summary>View full reply</summary><pre>${x.payload}</pre><button class="btn small secondary" data-copy-inbox="${x.id}">Copy full reply</button></details>`) : ''}${x.route ? raw(html`<a class="linkish inline" href="#/${x.route}">Open related session</a>`) : ''}</div></div>`))}</div>`) : raw('<div class="card subtle"><p class="muted">Nothing has returned yet. Results shared back to Style You will appear here.</p></div>')}
    <h2 class="section-h">Recent handoffs</h2>
    ${hand.length ? raw(html`<div class="timeline">${hand.slice(0,20).map(x => raw(html`<div class="card timeline-row"><span class="timeline-ico">${icon('share')}</span><div><b>${x.kind === 'request' ? `Request sent${STAGE_LABEL[x.stage] ? ` for ${STAGE_LABEL[x.stage]}` : ''}` : x.kind}</b><em>${aiName(x.provider)} · ${x.method === 'file-share' ? 'shared with photos' : 'copied'} · ${when(x)}</em></div></div>`))}</div>`) : raw('<div class="card subtle"><p class="muted">No handoffs yet.</p></div>')}
    ${(items.length || hand.length) ? raw('<button class="btn ghost danger-text" data-clear>Clear AI history</button>') : ''}
  </div>`;
  $$('[data-copy-inbox]', el).forEach(b => b.addEventListener('click', async () => { const x = items.find(i => i.id === b.dataset.copyInbox); if (x?.payload && await copyText(x.payload)) toast('Full reply copied', { ms: 1800 }); else toast('Could not copy that reply', { ms: 2500 }); }));
  $('[data-clear]', el)?.addEventListener('click', () => { state.aiInbox = []; state.handoffs = []; save(); inbox(el); toast('AI history cleared', { ms: 2200 }); });
}
};
__mods['js/views/settings.js'] = function(require,exports,module){
// Settings: profile, my colours, look of the app, storage & clean-up, backup & restore, delete everything, about.
const { state, save, mutate, route, go, ui, today, APP_VERSION, replaceState, imageRefs, photosAtRisk, render, unreadAI } = require('js/app.js');
const store = require('js/store.js');
const { $, $$, html, raw, icon, toast, pickFiles, confirmSheet, applyLook, detectedLook, shareOrOffer, download, isIOS, isStandalone } = require('js/ui.js');
const { deriveDNA: learnDNA, mergeDNA } = require('js/dna.js');
const { defaultState, migrate, EXPORT_SCHEMA } = require('js/state.js');
const { PALETTE } = require('js/catalog.js');
const { fmtBytes, plural, prettyDate, daysBetween } = require('js/util.js');
const { hamming, DUPLICATE_DISTANCE } = require('js/images.js');
const { pageHead, citySearchHTML, wireCitySearch } = require('js/views/common.js');
const { myColours, setMyPhoto } = require('js/views/aiflows.js');
const { hydrate, img } = require('js/parts.js');

route('settings', (el, [sub]) => {
  if (sub === 'profile') return profile(el);
  if (sub === 'dna') return styleDNA(el);
  if (sub === 'storage') return storage(el);
  if (sub === 'backup') return backup(el);
  if (sub === 'about') return about(el);
  const p = state.profile;
  const look = state.settings.appearance || 'auto';
  el.innerHTML = html`<div class="page settings">${pageHead('Settings', { back: '#/home' })}
    <ul class="list">
      <li><a href="#/settings/profile">${icon('user')}<span><b>Profile</b><em>${[p.name, p.city?.short || p.city?.name, p.defaultAI === 'chatgpt' ? 'ChatGPT' : 'Gemini'].filter(Boolean).join(' · ')}</em></span>${icon('chevron')}</a></li>
      <li><button data-colours>${icon('sparkle')}<span><b>My colours</b><em>${p.colours ? `${p.colours.good.slice(0, 4).join(', ')}…` : 'Not set — a one-time list from your photo'}</em></span>${icon('chevron')}</button></li>
      <li><a href="#/settings/dna">${icon('sparkle')}<span><b>Style DNA</b><em>${styleDNASummary()}</em></span>${icon('chevron')}</a></li>
      <li><a href="#/ai">${icon('share')}<span><b>AI apps</b><em>${p.defaultAI === 'chatgpt' ? 'ChatGPT' : 'Gemini'} · ${unreadAI() ? `${unreadAI()} new in AI Inbox` : 'app for each step, AI Inbox'}</em></span>${icon('chevron')}</a></li>
      <li><a href="#/settings/storage">${icon('layers')}<span><b>Storage &amp; privacy</b><em>Space used, clean-up, photos</em></span>${icon('chevron')}</a></li>
      <li><a href="#/settings/backup">${icon('shield')}<span><b>Backup &amp; restore</b><em>${state.settings.lastBackup ? `Last backup ${prettyDate(state.settings.lastBackup.slice(0, 10))}` : 'No backup yet'}</em></span>${icon('chevron')}</a></li>
      <li><a href="#/settings/about">${icon('info')}<span><b>About</b><em>Version ${APP_VERSION}</em></span>${icon('chevron')}</a></li>
    </ul>
    <h2 class="section-h">Look of the app</h2>
    <div class="seg" role="radiogroup" aria-label="Look of the app">${[['auto', 'Automatic'], ['ios', 'iPhone'], ['android', 'Android'], ['desktop', 'Desktop']].map(([k, l]) => raw(html`<button role="radio" aria-checked="${look === k}" data-look="${k}">${l}</button>`))}</div>
    <p class="muted small">Automatic matches this device (${({ ios: 'iPhone', android: 'Android', desktop: 'desktop' })[detectedLook()]}).</p>
    <h2 class="section-h">Start again</h2>
    <button class="btn ghost danger-text" data-wipe>${icon('trash')}<span>Delete everything on this device</span></button>
  </div>`;
  $('[data-colours]', el).onclick = () => myColours();
  $$('[data-look]', el).forEach(b => b.onclick = () => { state.settings.appearance = b.dataset.look; save(); applyLook(b.dataset.look); go('settings'); });
  $('[data-wipe]', el).onclick = wipe;
});

function profile(el) {
  const p = state.profile;
  el.innerHTML = html`<div class="page">${pageHead('Profile', { back: '#/settings', sub: 'Saved on this device.' })}
    <form class="form" autocomplete="off">
      <label class="field"><span>Name <em class="opt-tag">Optional</em></span><input name="name" maxlength="40" value="${p.name}" autocomplete="given-name"></label>
      <div class="field"><span>Home city (for weather)</span>${citySearchHTML(p.city)}</div>
      <div class="grid3"><label class="field"><span>Top size</span><input name="top" maxlength="12" value="${p.sizes.top}"></label><label class="field"><span>Bottom size</span><input name="bottom" maxlength="12" value="${p.sizes.bottom}"></label><label class="field"><span>Shoe size</span><input name="shoe" maxlength="12" value="${p.sizes.shoe}"></label></div>
      <label class="field"><span>Clothing</span><select name="clothing">${[['auto', 'Both / Any — follow my brief'], ['menswear', 'Menswear'], ['womenswear', 'Womenswear'], ['both', 'Both']].map(([v, l]) => raw(html`<option value="${v}" ${raw(p.clothing === v ? 'selected' : '')}>${l}</option>`))}</select></label>
      <label class="field"><span>AI app</span><select name="defaultAI"><option value="gemini" ${raw(p.defaultAI === 'gemini' ? 'selected' : '')}>Gemini</option><option value="chatgpt" ${raw(p.defaultAI === 'chatgpt' ? 'selected' : '')}>ChatGPT</option></select></label>
      <label class="field"><span>Language for AI replies</span><select name="language">${['English', 'Hindi', 'Marathi', 'Gujarati', 'Bengali', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Punjabi'].map(l => raw(html`<option ${raw(p.language === l ? 'selected' : '')}>${l}</option>`))}</select></label>
      <label class="field"><span>Style notes</span><textarea name="styleNotes" rows="2" maxlength="300" placeholder="e.g. prefer straight cuts, love block prints">${p.styleNotes}</textarea></label>
      <label class="field"><span>Customs</span><textarea name="customs" rows="2" maxlength="300" placeholder="e.g. no black at weddings, covered shoulders at temples">${p.customs}</textarea></label>
      <label class="field"><span>Comfort</span><input name="comfort" maxlength="150" placeholder="e.g. flat shoes only" value="${p.comfort}"></label>
      <div class="field"><span>Colours to avoid</span><div class="chips wrap avoid">${PALETTE.map(([n, h]) => raw(html`<button type="button" class="chip col${p.avoidColours.includes(n) ? ' on' : ''}" aria-pressed="${p.avoidColours.includes(n)}" data-c="${n}"><span class="swatch" style="--c:${h}"></span>${n}</button>`))}</div></div>
      <label class="check"><input type="checkbox" name="adult" checked disabled><span>18 or older (confirmed)</span></label>
      <div class="sticky-save"><button class="btn primary" type="submit">Save</button><a class="btn ghost" href="#/settings">Cancel</a></div>
    </form></div>`;
  let city = p.city; const avoid = new Set(p.avoidColours);
  wireCitySearch(el, c => { city = c; });
  $$('.avoid [data-c]', el).forEach(b => b.onclick = () => { const n = b.dataset.c; avoid.has(n) ? avoid.delete(n) : avoid.add(n); b.classList.toggle('on', avoid.has(n)); b.setAttribute('aria-pressed', avoid.has(n)); });
  $('form', el).addEventListener('submit', e => {
    e.preventDefault(); const f = e.target;
    const name = f.name.value.trim().slice(0, 40);
    mutate(s => {
      Object.assign(s.profile, { name, city: city || s.profile.city, sizes: { top: f.top.value.trim(), bottom: f.bottom.value.trim(), shoe: f.shoe.value.trim() }, clothing: f.clothing.value, defaultAI: f.defaultAI.value, language: f.language.value, styleNotes: f.styleNotes.value.trim(), customs: f.customs.value.trim(), comfort: f.comfort.value.trim(), avoidColours: [...avoid] });
      if (!city) s.profile.city = null;
      s.settings.weather = null;
    }, { undo: 'Profile saved', rerender: false });
    go('settings');
  });
}

// ---------- Style DNA ----------
function ratingCount() { return state.worn.filter(x => x.rating).length + state.looks.filter(x => x.rating).length; }
function styleDNASummary() {
  const n = ratingCount(), d = state.profile.styleDNA?.statements || [];
  if (d.length) return `${plural(d.length, 'editable preference')} · learned from feedback`;
  return n >= 10 ? 'Ready to review' : `${n}/10 ratings before insights`;
}
function styleDNA(el) {
  const n = ratingCount(); let dna = state.profile.styleDNA || { statements: [], updatedAt: null };
  if (n >= 10 && (!dna.statements || !dna.statements.length) && !dna.updatedAt) { dna = { statements: mergeDNA([], learnDNA(state)), updatedAt: new Date().toISOString() }; state.profile.styleDNA = dna; save(); }
  const rows = dna.statements || [];
  const draft = ui.dnaDraft === true;
  el.innerHTML = html`<div class="page">${pageHead('Style DNA', { back: '#/settings', sub: 'Editable style memory built from your own feedback.' })}
    ${n < 10 ? raw(html`<div class="card subtle"><b>${n}/10 outfit ratings</b><p class="muted">After 10 ratings, Style You will suggest a small set of preferences. You can edit or delete every statement.</p></div>`) : raw(html`<div class="card"><b>Based on ${n} ratings</b><p class="muted">These are suggestions, not facts about you. They are used in future AI requests and can be changed at any time.</p></div>`)}
    ${n >= 10 && !rows.some(x => x.source !== 'user') ? raw('<p class="muted dna-empty">Nothing clear to learn yet. Rate a few more outfits and Style You will learn your style.</p>') : ''}
    <div class="dna-list">${rows.map((x, i) => raw(html`<div class="card dna-row" data-i="${i}"><textarea rows="2" maxlength="180" aria-label="Preference ${i + 1}">${x.text || ''}</textarea><button class="icon-btn danger-text" data-rm aria-label="Remove preference">${icon('trash')}</button></div>`))}
      ${draft ? raw(html`<div class="card dna-row dna-new"><textarea rows="2" maxlength="180" placeholder="e.g. I prefer straight cuts and block prints" aria-label="New preference"></textarea><button class="btn small primary" data-savenew disabled>Save</button></div>`) : ''}</div>
    <div class="btn-col">${draft ? '' : raw(html`<button class="btn secondary" data-add>${icon('plus')}<span>Add a preference</span></button>`)}${n >= 10 ? raw('<button class="btn ghost" data-refresh>Rebuild suggestions from my ratings</button>') : ''}</div>
    <p class="muted small">Style DNA stays on this device and is included in your backup. Your own instructions for an occasion always come first.</p></div>`;
  $$('.dna-row[data-i]', el).forEach(row => {
    const i = +row.dataset.i;
    $('textarea', row).onchange = e => {
      const d = state.profile.styleDNA.statements; if (!d[i]) return;
      const t = e.target.value.trim().slice(0, 180);
      if (!t) { mutate(s => { s.profile.styleDNA.statements.splice(i, 1); s.profile.styleDNA.updatedAt = new Date().toISOString(); }, { undo: 'Preference removed' }); return; }
      if (t !== d[i].text) { d[i].text = t; d[i].source = 'user'; state.profile.styleDNA.updatedAt = new Date().toISOString(); save(); }
    };
    $('[data-rm]', row).onclick = () => mutate(s => { s.profile.styleDNA.statements.splice(i, 1); s.profile.styleDNA.updatedAt = new Date().toISOString(); }, { undo: 'Preference removed' });
  });
  $('[data-add]', el)?.addEventListener('click', () => { ui.dnaDraft = true; styleDNA(el); $('.dna-new textarea', el)?.focus(); });
  $('.dna-new textarea', el)?.addEventListener('input', e => { $('[data-savenew]', el).disabled = !e.target.value.trim(); });
  $('[data-savenew]', el)?.addEventListener('click', () => {
    const t = $('.dna-new textarea', el).value.trim().slice(0, 180);
    ui.dnaDraft = false;
    if (!t) { styleDNA(el); toast('Nothing added', { ms: 1800 }); return; }
    mutate(s => { s.profile.styleDNA = s.profile.styleDNA || { statements: [], updatedAt: null }; s.profile.styleDNA.statements.push({ id: `dna-${Date.now()}`, text: t, source: 'user' }); s.profile.styleDNA.updatedAt = new Date().toISOString(); }, { undo: 'Preference added' });
  });
  $('[data-refresh]', el)?.addEventListener('click', async () => {
    const ok = await confirmSheet({ title: 'Rebuild Style DNA?', text: 'Learned suggestions are replaced with new ones from your ratings. Preferences you typed or edited yourself are kept.', ok: 'Rebuild' });
    if (!ok) return;
    mutate(s => { s.profile.styleDNA = { statements: mergeDNA(s.profile.styleDNA?.statements || [], learnDNA(s)), updatedAt: new Date().toISOString() }; }, { undo: 'Style DNA rebuilt' });
  });
}

// ---------- storage ----------
async function usage() {
  const meta = await store.allImageMeta();
  const by = { wardrobe: 0, looks: 0, me: 0, other: 0 };
  for (const m of meta) { const k = m.kind?.startsWith('wardrobe') ? 'wardrobe' : m.kind?.startsWith('look') ? 'looks' : m.kind === 'me' ? 'me' : 'other'; by[k] += m.bytes || 0; }
  const details = new Blob([JSON.stringify(state)]).size;
  const total = by.wardrobe + by.looks + by.me + by.other + details;
  const est = await store.estimate();
  return { by, details, total, est, meta };
}
function suggestions(meta) {
  const size = new Map(meta.map(m => [m.id, m.bytes || 0]));
  const sz = ids => ids.reduce((a, id) => a + (size.get(id) || 0), 0);
  const sixMonths = 182; const out = [];
  const notForMe = state.looks.filter(l => l.rating === 'Not for me' && l.pictures?.after);
  if (notForMe.length) out.push({ id: 'nfm', label: `Pictures of ${plural(notForMe.length, 'look')} rated “Not for me”`, ids: notForMe.flatMap(l => [l.pictures.after, l.pictures.afterThumb]), apply: s => s.looks.forEach(l => { if (notForMe.some(x => x.id === l.id)) l.pictures = { ...l.pictures, after: null, afterThumb: null }; }) });
  const old = state.looks.filter(l => !l.starred && !l.wornOn && daysBetween((l.createdAt || '').slice(0, 10) || today(), today()) > sixMonths);
  if (old.length) out.push({ id: 'old', label: `${plural(old.length, 'look')} older than 6 months, never worn or starred (whole look)`, ids: old.flatMap(l => [l.pictures?.after, l.pictures?.afterThumb]).filter(Boolean), apply: s => { s.looks = s.looks.filter(l => !old.some(x => x.id === l.id)); } });
  const dups = []; const ws = state.wardrobe.filter(w => w.fp && w.photo);
  for (let i = 0; i < ws.length; i++) for (let j = 0; j < i; j++) if (hamming(ws[i].fp, ws[j].fp) <= DUPLICATE_DISTANCE) { dups.push(ws[i]); break; }
  if (dups.length) out.push({ id: 'dup', label: `Photos of ${plural(dups.length, 'piece')} that look like duplicates (${dups.map(d => d.code).join(', ')}; details kept)`, ids: dups.flatMap(w => [w.photo.full, w.photo.thumb]), apply: s => s.wardrobe.forEach(w => { if (dups.some(d => d.id === w.id)) w.photo = null; }) });
  const arch = state.wardrobe.filter(w => w.status === 'Archived' && w.photo);
  if (arch.length) out.push({ id: 'arch', label: `Photos of ${plural(arch.length, 'archived piece')} (details kept)`, ids: arch.flatMap(w => [w.photo.full, w.photo.thumb]), apply: s => s.wardrobe.forEach(w => { if (arch.some(d => d.id === w.id)) w.photo = null; }) });
  const oldPics = state.looks.filter(l => l.pictures?.after && l.rating !== 'Not for me' && daysBetween((l.createdAt || '').slice(0, 10) || today(), today()) > 90);
  if (oldPics.length) out.push({ id: 'oldpic', label: `Pictures of ${plural(oldPics.length, 'look')} older than 3 months (details and links kept)`, ids: oldPics.flatMap(l => [l.pictures.after, l.pictures.afterThumb]), apply: s => s.looks.forEach(l => { if (oldPics.some(x => x.id === l.id)) l.pictures = { ...l.pictures, after: null, afterThumb: null }; }) });
  out.forEach(o => { o.bytes = sz(o.ids.filter(Boolean)); });
  return out;
}

async function storage(el) {
  el.innerHTML = html`<div class="page">${pageHead('Storage & privacy', { back: '#/settings' })}<div class="skeleton"></div></div>`;
  const seq = ui.seq;
  const u = await usage();
  if (seq !== ui.seq) return;
  const big = u.total > 150 * 1024 * 1024;
  const low = u.est?.quota && u.est.usage && (u.est.quota - u.est.usage) < 200 * 1024 * 1024;
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  const sug = suggestions(u.meta);
  const p = state.profile;
  el.innerHTML = html`<div class="page">${pageHead('Storage & privacy', { back: '#/settings' })}
    <div class="card"><div class="row between"><b>Style You uses</b><b>${fmtBytes(u.total)}</b></div>
      <div class="usage" aria-hidden="true">${['wardrobe', 'looks', 'me'].map(k => raw(html`<span class="u-${k}" style="flex:${Math.max(0.5, u.by[k])}"></span>`))}<span class="u-details" style="flex:${Math.max(0.5, u.details)}"></span></div>
      <ul class="legend"><li><i class="u-wardrobe"></i>Wardrobe photos ${fmtBytes(u.by.wardrobe)}</li><li><i class="u-looks"></i>Look pictures ${fmtBytes(u.by.looks)}</li><li><i class="u-me"></i>Your photos ${fmtBytes(u.by.me)}</li><li><i class="u-details"></i>Details ${fmtBytes(u.details)}</li></ul>
      <p class="status ${low ? 'bad' : big ? 'warnc' : 'okc'}">${low ? 'Phone low on space' : big ? 'Getting large' : 'Healthy'}</p>
      <p class="muted small">${store.mode === 'memory' ? 'This browser is not saving anything — changes are lost when you close it.' : photosAtRisk() ? 'Safari tab: photos are kept only until Safari closes. Add Style You to your Home Screen to keep them.' : persisted ? 'Protected: the browser will not clear this data on its own.' : isIOS && isStandalone() ? 'Saved in the home-screen app.' : 'The browser may clear data if the phone runs very low on space. Keep a backup.'}</p></div>
    <h2 class="section-h">Clean up</h2>
    ${sug.length ? raw(html`<p class="muted">Nothing is removed until you review and tap Remove. You can Undo for a few seconds.</p>
      <ul class="review">${sug.map((s, i) => raw(html`<li><label class="check"><input type="checkbox" data-s="${i}"><span>${s.label}</span></label><span class="muted small">frees about ${fmtBytes(s.bytes)}</span></li>`))}</ul>
      <button class="btn primary" data-clean disabled>Remove ticked</button>`) : raw('<p class="muted">Nothing to clean up. Wardrobe photos are never removed automatically.</p>')}
    <h2 class="section-h">Your photo</h2>
    <label class="check"><input type="checkbox" data-keep ${raw(p.keepPhotos ? 'checked' : '')}><span>Keep my original styling photo between sessions</span></label>
    <p class="muted small">Used for the before-and-after view and See it on me. Off: your photo is removed when an occasion is finished.</p>
    ${p.myPhoto ? raw(html`<div class="me-row">${img(p.myPhoto, { cls: 'me-thumb', alt: 'Your saved photo' })}<div><b>Saved photo</b><button class="linkish" data-newme>Change</button><button class="linkish danger-text" data-rmme>Remove</button></div></div>`) : raw('<button class="btn secondary" data-newme>Add your full-length photo</button>')}
    <h2 class="section-h">Privacy</h2>
    <ul class="plain"><li>Style You has no server and no account. Nothing is uploaded by the app.</li><li>Your photo leaves this device only when you send it to Gemini or ChatGPT yourself.</li><li>Photos are re-saved smaller on the device, which also removes location data.</li><li>Weather: only the city's position is sent to Open-Meteo.</li></ul>
  </div>`;
  hydrate(el);
  const boxes = $$('[data-s]', el); const clean = $('[data-clean]', el);
  boxes.forEach(b => b.onchange = () => { clean.disabled = !boxes.some(x => x.checked); });
  clean?.addEventListener('click', () => {
    const pick = boxes.filter(b => b.checked).map(b => sug[+b.dataset.s]);
    const drop = pick.flatMap(s => s.ids).filter(Boolean);
    mutate(s => pick.forEach(x => x.apply(s)), { undo: `Removed — about ${fmtBytes(pick.reduce((a, x) => a + x.bytes, 0))} freed`, dropImages: drop, rerender: false });
    storage(el);
  });
  $('[data-keep]', el).onchange = e => { mutate(s => { s.profile.keepPhotos = e.target.checked; }, { toastMsg: e.target.checked ? 'Original photo will be kept between sessions' : 'Original photo will be removed after each styling session', rerender: false }); };
  $$('[data-newme]', el).forEach(b => b.onclick = async () => { const [f] = await pickFiles({ accept: 'image/*' }); if (!f) return; try { await setMyPhoto(f); storage(el); } catch (er) { toast(er.message, { ms: 4000 }); } });
  $('[data-rmme]', el)?.addEventListener('click', () => { const id = p.myPhoto; mutate(s => { s.profile.myPhoto = null; }, { undo: 'Photo removed', dropImages: [id], rerender: false }); storage(el); });
}

// ---------- backup ----------
function blobToDataURL(b) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); }); }
async function dataURLToBlob(u) { const r = await fetch(u); return r.blob(); }

async function exportBackup() {
  toast('Preparing your backup…', { ms: 2000 });
  const refs = imageRefs(); const images = [];
  for (const id of refs) { const r = await store.getImageRec(id); if (r?.blob) images.push({ id, kind: r.kind, w: r.w, h: r.h, createdAt: r.createdAt, data: await blobToDataURL(r.blob) }); }
  const out = { schemaVersion: EXPORT_SCHEMA, app: 'Style You', appVersion: APP_VERSION, exportedAt: new Date().toISOString(), state, images };
  const file = new File([JSON.stringify(out)], `style-you-backup-${today()}.json`, { type: 'application/json' });
  const r = await shareOrOffer(file, 'Style You backup', 'Save backup');
  if (r === 'shared' || r === 'downloaded') { state.settings.lastBackup = new Date().toISOString(); state.settings.photosSinceBackup = 0; state.settings.backupSnoozeUntil = null; save(); }
  if (r === 'shared' || r === 'downloaded') toast(`Backup ready: ${plural(state.wardrobe.length, 'piece')}, ${plural(state.looks.length, 'look')}, ${plural(images.length, 'picture')} (${fmtBytes(file.size)}).`, { ms: 5000 });
  if (ui.route === 'home') render();
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('That file is not a Style You backup.', { ms: 4000 }); return; }
  const st = data?.state || (data?.profile || data?.wardrobe ? data : null);
  if (!st || typeof st !== 'object' || (data.schemaVersion && data.schemaVersion > EXPORT_SCHEMA)) { toast(data?.schemaVersion > EXPORT_SCHEMA ? 'This backup is from a newer version. Update Style You first.' : 'That file is not a Style You backup.', { ms: 5000 }); return; }
  const next = migrate(data.schemaVersion ? { ...data, state: st } : st);
  next.profile.onboarded = true; next.profile.adultConfirmed = next.profile.adultConfirmed || state.profile.adultConfirmed;
  const imgs = Array.isArray(data.images) ? data.images.filter(i => i && typeof i.id === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(i.data || '')) : [];
  const ok = await confirmSheet({ title: 'Restore this backup?', text: `From ${data.exportedAt ? prettyDate(String(data.exportedAt).slice(0, 10)) : 'an earlier version'}: ${plural(next.wardrobe.length, 'piece')}, ${plural(next.looks.length, 'look')}, ${plural(imgs.length, 'picture')}. Everything now on this device is replaced.`, ok: 'Restore', danger: true });
  if (!ok) return;
  const before = JSON.parse(JSON.stringify(state));
  const previous = new Map();
  const written = [];
  const rollbackImages = async () => {
    for (const id of [...written].reverse()) {
      const old = previous.get(id);
      if (old?.blob) await store.putImageWithId(id, old.blob, old.kind || 'wardrobe', { w: old.w, h: old.h, createdAt: old.createdAt });
      else await store.deleteImage(id);
    }
  };
  try {
    // Stage every imported picture first, remembering anything with the same id so failure/Undo is reversible.
    for (const i of imgs) {
      if (!previous.has(i.id)) previous.set(i.id, await store.getImageRec(i.id));
      await store.putImageWithId(i.id, await dataURLToBlob(i.data), i.kind || 'wardrobe', { w: i.w, h: i.h, createdAt: i.createdAt });
      written.push(i.id);
    }
    replaceState(next); await store.flush();
    if (store.saveError()) throw store.saveError();
  } catch (e) {
    replaceState(before); await store.flush();
    await rollbackImages();
    toast(e?.name === 'QuotaExceededError' ? 'Not enough space on this device to restore the pictures. Nothing was changed.' : 'Restore failed; your previous data was kept: ' + (e?.message || e), { ms: 7000 });
    return;
  }
  const refs = imageRefs(next);
  const oldOnly = [...imageRefs(before)].filter(id => !refs.has(id));
  toast('Backup restored', {
    undo: async () => { replaceState(before); await store.flush(); await rollbackImages(); render(); toast('Restore undone', { ms: 2200 }); },
    onExpire: () => oldOnly.forEach(id => store.deleteImage(id))
  });
  go('home');
}

function backup(el) {
  el.innerHTML = html`<div class="page">${pageHead('Backup & restore', { back: '#/settings' })}
    <p class="lead">One file with your clothes, photos, looks and settings. Keep it in Files, iCloud Drive, Google Drive or another secure location.</p>
    <p class="muted">${state.settings.lastBackup ? `Last backup: ${prettyDate(state.settings.lastBackup.slice(0, 10))}.` : 'No backup yet.'} A reminder appears every 14 days, and after 20 new photos.</p>
    <div class="btn-col"><button class="btn primary big" data-exp>${icon('download')}<span>Back up now</span></button>
    <button class="btn secondary" data-imp>${icon('upload')}<span>Restore from a backup file</span></button></div></div>`;
  $('[data-exp]', el).onclick = () => exportBackup();
  $('[data-imp]', el).onclick = async () => { const [f] = await pickFiles({ accept: '.json,application/json,text/plain' }); if (f) importBackup(f); };
}

async function wipe() {
  const ok = await confirmSheet({ title: 'Delete everything?', text: 'Your wardrobe, photos, looks and settings are removed from this device. Make a backup first if you may want them back.', ok: 'Delete everything', danger: true });
  if (!ok) return;
  const drop = [...imageRefs()];
  mutate(s => { const fresh = defaultState(); Object.keys(s).forEach(k => delete s[k]); Object.assign(s, fresh); }, { undo: 'Everything deleted', dropImages: drop, rerender: false });
  try { localStorage.removeItem('styleyou-state'); } catch { /* ignore */ }
  go('onboarding');
}

function troubleshooting() {
  let fileShare = false;
  try { fileShare = !!(navigator.share && navigator.canShare && navigator.canShare({ files: [new File(['x'], 'styleyou.jpg', { type: 'image/jpeg' })] })); } catch { fileShare = false; }
  return [
    ['Send photos straight to Gemini or ChatGPT', fileShare, 'You save the photos with a button and attach them in the AI app.'],
    ['Copy the request for you', !!navigator.clipboard?.writeText, 'Open “See what we’ll send” and copy the text by hand.'],
    ['Paste a picture straight in', !!navigator.clipboard?.read, 'Use “Choose from Photos / Files” instead.'],
    [isIOS ? 'Opened from the Home Screen' : 'Installed as an app', isStandalone(), isIOS ? 'Add Style You to your Home Screen so Safari keeps your photos.' : 'Installing is optional; it opens like an app.']
  ];
}
function about(el) {
  el.innerHTML = html`<div class="page">${pageHead('About', { back: '#/settings' })}
    <div class="card"><b>Style You ${APP_VERSION}</b><p class="muted">Free, no account. Your own Gemini or ChatGPT does the styling and pictures.</p></div>
    <ul class="plain"><li>AI pictures are style visualisations: fit, colour and details may differ from real products.</li><li>Product prices and stock change; always check on the shop's page.</li><li><a class="credit" href="https://open-meteo.com/" target="_blank" rel="noopener">Weather data by Open-Meteo.com</a> (CC BY 4.0).</li><li>Fonts: Figtree and Manrope (SIL Open Font License).</li></ul>
    <button class="btn secondary" data-upd>${icon('refresh')}<span>Check for updates</span></button>
    <h2 class="section-h">Troubleshooting</h2>
    <p class="muted">What this phone's browser lets Style You do. If something here says “No”, Style You uses another way automatically.</p>
    <div class="card cap-list">${troubleshooting().map(([label, ok, other]) => raw(html`<div><span>${label}${ok ? '' : raw(html`<em class="muted small">${other}</em>`)}</span><span class="cap ${ok ? 'ok' : 'off'}">${ok ? 'Yes' : 'No'}</span></div>`))}</div></div>`;
  $('[data-upd]', el).onclick = async () => {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (!reg) { toast('Updates arrive automatically when you reopen the app.', { ms: 3000 }); return; }
    try { await reg.update(); toast(reg.waiting || reg.installing ? 'A new version is ready — tap the banner at the top.' : 'You have the latest version.', { ms: 3500 }); } catch { toast('Could not check right now.', { ms: 2500 }); }
  };
}
Object.defineProperty(exports,'exportBackup',{enumerable:true,get:()=>exportBackup});
Object.defineProperty(exports,'importBackup',{enumerable:true,get:()=>importBackup});
};
__mods['js/views/wardrobe.js'] = function(require,exports,module){
// Wardrobe: list, search, filters, select mode, item details, sets, adding from photos or a typed list.
const { state, save, mutate, route, go, ui, today, itemById, photosAtRisk } = require('js/app.js');
const store = require('js/store.js');
const { $, $$, html, raw, icon, toast, openSheet, pickFiles, confirmSheet } = require('js/ui.js');
const { CATEGORIES, CAT, GROUP_LABEL, PALETTE, PATTERNS, FABRICS, STATUSES, guessCategory, hexForName } = require('js/catalog.js');
const { effectiveStatus, groupOf, laundryReviewDue } = require('js/engine.js');
const { newItem, splitBulk, guessColourWord } = require('js/state.js');
const { shrink, analyse, colourAt, hamming, DUPLICATE_DISTANCE } = require('js/images.js');
const { prettyDate, plural, normalise, esc, daysBetween } = require('js/util.js');
const { tile, hydrate, empty, swatch } = require('js/parts.js');
const { pageHead } = require('js/views/common.js');
const { labelWithAI } = require('js/views/aiflows.js');

const FILTERS = [['all', 'All'], ['top', 'Tops'], ['bottom', 'Bottoms'], ['one', 'Full outfits'], ['layer', 'Layers'], ['footwear', 'Footwear'], ['accessory', 'Accessories'], ['away', 'Not available'], ['sets', 'Sets'], ['archived', 'Archived']];
const GROUP_ORDER = ['top', 'bottom', 'one', 'layer', 'footwear', 'accessory'];
const QUICK_CATS = ['kurta', 'shirt', 'top', 'tshirt', 'trousers', 'jeans', 'palazzo', 'dress', 'saree', 'kurtaset', 'dupatta', 'jacket', 'footwear', 'earrings', 'bag'];
const SEASONS = ['Hot', 'Warm', 'Cool', 'Cold', 'Rainy', 'All-weather'];
const FITS = ['Relaxed', 'Regular', 'Straight', 'Slim', 'Tailored', 'Oversized', 'Flowy'];
const ITEM_OCCASIONS = ['Everyday', 'Work', 'Formal', 'Wedding', 'Festive', 'Party', 'Travel', 'Religious'];

function statusBadge(it) {
  const st = effectiveStatus(it, today());
  const laundryDue = laundryReviewDue(it, today());
  return st === 'Available' ? '' : `<span class="badge">${esc(st)}</span>`;
}

// ---------- list ----------
// ---------- simple insights, worked out on the phone ----------
const INSIGHT_DAYS = 60;
function insights() {
  const t = today();
  const active = state.wardrobe.filter(w => w.status !== 'Archived');
  const logged = state.worn.length > 0;
  const most = active.filter(w => (w.timesWorn || 0) > 0).sort((a, b) => (b.timesWorn || 0) - (a.timesWorn || 0) || a.name.localeCompare(b.name)).slice(0, 3);
  const idle = active.filter(w => w.lastWorn && daysBetween(w.lastWorn, t) >= INSIGHT_DAYS);
  const lovedIds = state.worn.filter(x => x.rating === 'Love it').flatMap(x => x.itemIds || []);
  const cc = new Map(); for (const id of lovedIds) { const w = itemById(id); const n = w && !w.colour?.unknown ? w.colour?.name : null; if (n) cc.set(n, (cc.get(n) || 0) + 1); }
  const colours = [...cc].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([n]) => n);
  return { logged, most, idle, colours };
}
function insightsHTML() {
  const i = insights();
  if (!i.logged) return html`<div class="card insights"><b>Insights</b><p class="muted small">Log a few outfits with “Wore this” to see what you wear most, what's been waiting in the cupboard and the colours you love.</p></div>`;
  const rows = [];
  if (i.most.length) rows.push(html`<button class="ins-row" data-ins="most"><span><b>Most worn</b><em>${i.most.map(w => `${w.name} (${w.timesWorn})`).join(', ')}</em></span>${icon('chevron')}</button>`);
  rows.push(html`<button class="ins-row" data-ins="idle"><span><b>Not worn in ${INSIGHT_DAYS} days</b><em>${i.idle.length ? plural(i.idle.length, 'piece') : 'None — nice'}</em></span>${icon('chevron')}</button>`);
  if (i.colours.length) rows.push(html`<button class="ins-row" data-ins="colour" data-colour-name="${i.colours[0]}"><span><b>Colours you love</b><em>${i.colours.join(', ')}</em></span>${icon('chevron')}</button>`);
  return html`<div class="card insights"><b>Insights</b>${raw(rows.join(''))}</div>`;
}
const INSIGHT_FILTERS = { most: 'Most worn', idle: `Not worn in ${INSIGHT_DAYS} days` };

function wardrobeBody() {
  const f = ui.wFilter || 'all'; const q = ui.wQuery || ''; const sel = ui.wSelect || null;
  const all = state.wardrobe;
  const nq = normalise(q);
  let list = all.filter(w => f === 'archived' ? w.status === 'Archived' : w.status !== 'Archived');
  if (GROUP_ORDER.includes(f)) list = list.filter(w => groupOf(w) === f);
  if (f === 'away') list = list.filter(w => effectiveStatus(w, today()) !== 'Available' && w.status !== 'Archived');
  if (f === 'most') list = list.filter(w => (w.timesWorn || 0) > 0).sort((a, b) => (b.timesWorn || 0) - (a.timesWorn || 0));
  if (f === 'idle') list = list.filter(w => w.lastWorn && daysBetween(w.lastWorn, today()) >= INSIGHT_DAYS);
  if (nq) list = list.filter(w => normalise(`${w.name} ${w.code} ${w.colour?.name} ${CAT[w.category]?.label} ${w.fabric} ${w.pattern}`).includes(nq));
  const activeCount = all.filter(w => w.status !== 'Archived').length;
  const inLaundry = all.filter(w => w.status === 'Laundry');

  let body;
  if (!all.length) body = empty('Your wardrobe is empty', 'Add the 15 things you wear most. Photos work best; a typed list is quicker.', html`<div class="btn-col"><a class="btn primary" href="#/add/photos">${icon('image')}<span>Add from photos</span></a><a class="btn secondary" href="#/add/list">${icon('paste')}<span>Type a list</span></a></div>`).__raw;
  else if (f === 'sets') body = setsHTML();
  else if (!list.length) body = empty(nq ? `Nothing matches “${q}”` : 'Nothing here', nq ? 'Try another word, or clear the search.' : f === 'archived' ? 'Archived clothes appear here. They are kept but never suggested.' : 'No clothes in this group yet.', nq ? '<button class="btn secondary" data-clearq>Clear search</button>' : '').__raw;
  else if (f === 'all' && !nq) body = insightsHTML() + GROUP_ORDER.map(g => { const gi = list.filter(w => groupOf(w) === g); return gi.length ? html`<h2 class="group-h">${GROUP_LABEL[g]} <span class="muted">${gi.length}</span></h2><div class="grid">${gi.map(w => tile(w, { selectable: !!sel, selected: sel?.has(w.id), extra: statusBadge(w) }))}</div>` : ''; }).join('');
  else body = html`<div class="grid">${list.map(w => tile(w, { selectable: !!sel, selected: sel?.has(w.id), extra: statusBadge(w) }))}</div>`;
  if (inLaundry.length && !sel && (f === 'all' || f === 'away') && !nq) body = laundryBarHTML(inLaundry.length) + body;
  return { body, all, activeCount, f, q, sel };
}
function laundryBarHTML(n) {
  return html`<div class="card laundry-bar"><span>${icon('refresh')}<span>${plural(n, 'piece')} in the laundry</span></span><button class="btn small primary" data-laundryback>Laundry's back (${n})</button></div>`;
}

route('wardrobe', el => {
  const { body, all, activeCount, f, q, sel } = wardrobeBody();

  el.innerHTML = html`<div class="page wardrobe${sel ? ' selecting' : ''}">
    ${pageHead('Wardrobe', { sub: all.length ? `${plural(activeCount, 'piece')}${photosAtRisk() ? ' · photos kept until Safari closes' : ''}` : '', actions: all.length ? html`<button class="btn small ${sel ? 'primary' : 'ghost'}" data-select>${sel ? 'Done' : 'Select'}</button><a class="icon-btn accent" href="#/add" aria-label="Add clothes">${icon('plus')}</a>` : '' })}
    ${all.length ? raw(html`<div class="searchbar">${icon('search')}<input type="search" placeholder="Search name, colour, code" aria-label="Search wardrobe" value="${q}" maxlength="40"></div>
    <div class="chips scroll" role="group" aria-label="Filter">${FILTERS.map(([k, l]) => raw(html`<button class="chip${f === k ? ' on' : ''}" aria-pressed="${f === k}" data-f="${k}">${l}</button>`))}</div>
    ${INSIGHT_FILTERS[f] ? raw(html`<div class="row showing"><span class="muted">Showing: <b>${INSIGHT_FILTERS[f]}</b></span><button class="btn small ghost" data-f="all">Show all</button></div>`) : ''}`) : ''}
    <div class="wbody">${raw(body)}</div>
    ${sel ? raw(html`<div class="selbar" role="toolbar" aria-label="Selected clothes"><span class="selcount">${sel.size} selected</span>
      <button class="btn small" data-act="laundry" ${raw(sel.size ? '' : 'disabled')}>Laundry</button>
      <button class="btn small" data-act="available" ${raw(sel.size ? '' : 'disabled')}>Available</button>
      <button class="btn small" data-act="set" ${raw(sel.size > 1 ? '' : 'disabled')}>Make a set</button>
      <button class="btn small" data-act="label" ${raw(sel.size ? '' : 'disabled')}>Label with AI</button>
      <button class="btn small" data-act="archive" ${raw(sel.size ? '' : 'disabled')}>Archive</button>
      <button class="btn small danger" data-act="delete" ${raw(sel.size ? '' : 'disabled')}>Delete</button></div>`) : ''}
  </div>`;
  hydrate(el);

  const qi = $('.searchbar input', el);
  // Searching updates only the list, so the keyboard stays open.
  if (qi) qi.addEventListener('input', () => {
    ui.wQuery = qi.value; clearTimeout(ui.wqT);
    ui.wqT = setTimeout(() => { if (ui.route !== 'wardrobe' || !document.contains(qi)) return; const wb = $('.wbody', el); wb.innerHTML = wardrobeBody().body; hydrate(wb); }, 200);
  });
  $$('[data-f]', el).forEach(b => b.onclick = () => { ui.wFilter = b.dataset.f; go('wardrobe'); });
  $('[data-select]', el)?.addEventListener('click', () => { ui.wSelect = sel ? null : new Set(); go('wardrobe'); });
  el.querySelector('.wbody').addEventListener('click', e => {
    if (e.target.closest('[data-clearq]')) { ui.wQuery = ''; go('wardrobe'); return; }
    if (e.target.closest('[data-laundryback]')) { laundryBack(); return; }
    const ins = e.target.closest('[data-ins]');
    if (ins) { if (ins.dataset.ins === 'colour') { ui.wFilter = 'all'; ui.wQuery = ins.dataset.colourName; } else { ui.wFilter = ins.dataset.ins; ui.wQuery = ''; } go('wardrobe'); return; }
    const t = e.target.closest('.tile'); if (!t || !t.dataset.id) return;
    if (sel) { sel.has(t.dataset.id) ? sel.delete(t.dataset.id) : sel.add(t.dataset.id); go('wardrobe'); }
    else go(`item/${t.dataset.id}`);
  });
  el.querySelector('.wbody').addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && e.target.closest('.tile[role=checkbox]')) { e.preventDefault(); e.target.click(); } });
  if (sel) wireSelBar(el, sel);
  wireSets(el);
});

function wireSelBar(el, sel) {
  $$('[data-act]', el).forEach(b => b.onclick = async () => {
    const ids = [...sel]; const n = plural(ids.length, 'piece');
    const a = b.dataset.act;
    if (a === 'laundry' || a === 'available' || a === 'archive') {
      const st = a === 'laundry' ? 'Laundry' : a === 'available' ? 'Available' : 'Archived';
      ui.wSelect = null;
      mutate(s => { for (const id of ids) { const w = s.wardrobe.find(x => x.id === id); if (w) { w.status = st; w.statusSince = today(); } } }, { undo: `${n} marked ${st}` });
    }
    if (a === 'set') makeSet(ids);
    if (a === 'label') { ui.wSelect = null; go('wardrobe'); labelWithAI(ids); }
    if (a === 'delete') {
      const drop = ids.flatMap(id => { const w = itemById(id); return [w?.photo?.full, w?.photo?.thumb]; }).filter(Boolean);
      ui.wSelect = null;
      mutate(s => { s.wardrobe = s.wardrobe.filter(w => !ids.includes(w.id)); s.sets = s.sets.map(x => ({ ...x, itemIds: x.itemIds.filter(i => !ids.includes(i)) })).filter(x => x.itemIds.length > 1); }, { undo: `${n} deleted`, dropImages: drop });
    }
  });
}

// ---------- sets ----------
function setsHTML() {
  if (!state.sets.length) return empty('No sets yet', 'Kurta sets, a saree with its blouse, or a lehenga set: tap Select, choose the pieces, then “Make a set”. A set is suggested as one outfit unless you say it can be worn separately.').__raw;
  return state.sets.map(s => html`<div class="card set-card" data-set="${s.id}"><div class="row between"><b>${s.name}</b><span class="muted">${s.canSplit ? 'Can be worn separately' : 'Always together'}</span></div>
    <div class="grid small">${s.itemIds.map(itemById).filter(Boolean).map(w => tile(w, { small: true }))}</div>
    <div class="row"><button class="btn small secondary" data-editset>Edit</button><button class="btn small ghost danger-text" data-delset>Remove set</button></div></div>`).join('');
}
function wireSets(el) {
  $$('[data-set]', el).forEach(c => {
    const id = c.dataset.set;
    $('[data-editset]', c).onclick = () => makeSet(null, id);
    $('[data-delset]', c).onclick = () => mutate(s => { s.sets = s.sets.filter(x => x.id !== id); }, { undo: 'Set removed (the clothes are kept)' });
  });
}
function makeSet(ids, editId = null) {
  const ex = editId ? state.sets.find(s => s.id === editId) : null;
  const items = (ex ? ex.itemIds : ids).map(itemById).filter(Boolean);
  const guess = items.find(i => ['one', 'top'].includes(groupOf(i)));
  const s = openSheet(html`<div class="grid small">${items.map(w => tile(w, { small: true }))}</div>
    <label class="field"><span>Name</span><input id="set-name" maxlength="40" value="${ex?.name || (guess ? `${guess.colour?.name || ''} ${CAT[guess.category].label.split(' /')[0].toLowerCase()} set`.trim() : 'My set')}"></label>
    <label class="check"><input type="checkbox" id="set-split" ${raw(ex?.canSplit ? 'checked' : '')}><span>These can also be worn separately</span></label>
    <div class="btn-col"><button class="btn primary" data-ok>${ex ? 'Save' : 'Make set'}</button><button class="btn ghost" data-close="1">Cancel</button></div>`, { title: ex ? 'Edit set' : 'Make a set' });
  hydrate(s.body);
  $('[data-ok]', s.body).onclick = async e => {
    if (e.currentTarget.disabled) return; e.currentTarget.disabled = true;
    const name = $('#set-name', s.body).value.trim() || 'My set', canSplit = $('#set-split', s.body).checked;
    await s.close();
    ui.wSelect = null;
    mutate(st => {
      if (ex) { const t = st.sets.find(x => x.id === ex.id); Object.assign(t, { name, canSplit }); }
      else {
        st.sets = st.sets.map(x => ({ ...x, itemIds: x.itemIds.filter(i => !ids.includes(i)) })).filter(x => x.itemIds.length > 1); // a piece belongs to one set
        st.sets.push({ id: 'set-' + Date.now().toString(36), name, canSplit, itemIds: ids });
      }
    }, { undo: ex ? 'Set saved' : `Set “${name}” made` });
    if (!ex) { ui.wFilter = 'sets'; go('wardrobe'); }
  };
}

// ---------- item details ----------
route('item', (el, [id]) => {
  const it = itemById(id);
  if (!it) { el.innerHTML = html`<div class="page">${pageHead('Not found', { back: '#/wardrobe' })}${empty('This piece is no longer in your wardrobe', 'It may have been deleted.', '<a class="btn primary" href="#/wardrobe">Back to Wardrobe</a>')}</div>`; return; }
  const d = { ...it, colour: { ...it.colour }, secondColour: it.secondColour ? { ...it.secondColour } : null, seasons: [...(it.seasons || [])], occasions: [...(it.occasions || [])] };
  // Every tag stored on the piece is shown, including ones the AI added that are not in the usual list, so all can be removed.
  const seasonChoices = [...SEASONS, ...d.seasons.filter(x => !SEASONS.includes(x))];
  const occChoices = [...ITEM_OCCASIONS, ...d.occasions.filter(x => !ITEM_OCCASIONS.includes(x))];
  const sets = state.sets.filter(s => s.itemIds.includes(it.id));
  const looks = state.looks.filter(l => (l.pieces || []).some(p => p.wardrobeId === it.id)).length;
  const st = effectiveStatus(it, today());
  const laundryDue = laundryReviewDue(it, today());
  el.innerHTML = html`<div class="page item">
    ${pageHead(it.name, { back: '#/wardrobe', sub: `${it.code} · ${CAT[it.category]?.label || ''}` })}
    <div class="item-pic" style="--c:${it.colour?.hex || '#8C8F96'}">${it.photo?.full ? raw(html`<img data-img="${it.photo.full}" alt="${it.name}" class="pickable">`) : raw('<span class="tile-sw big"></span>')}</div>
    ${it.photo?.full ? raw('<p class="muted center small">Colour wrong? Tap the clothes in the photo to pick it.</p>') : ''}
    <div class="row center wrap">${it.photo?.full ? raw(html`<button class="btn small secondary" data-photo>${icon('image')}<span>Change photo</span></button><button class="btn small ghost" data-rmphoto>Remove photo</button>`) : raw(html`<button class="btn small secondary" data-photo>${icon('image')}<span>Add a photo</span></button>`)}</div>
    <form class="form" autocomplete="off">
      <label class="field"><span>Name</span><input name="name" maxlength="80" value="${it.name}" required></label>
      <label class="field"><span>Category</span><select name="category">${CATEGORIES.map(c => raw(html`<option value="${c.id}" ${raw(c.id === it.category ? 'selected' : '')}>${c.label}</option>`))}</select></label>
      <div class="field"><span>Main colour</span><button type="button" class="colour-btn" data-colour>${swatch(it.colour?.hex)}<span class="cname">${it.colour?.name || 'Choose'}</span>${icon('chevron')}</button></div>
      <div class="field"><span>Second colour (optional)</span><button type="button" class="colour-btn" data-colour2>${swatch(it.secondColour?.hex || '#C9CACE')}<span class="cname2">${it.secondColour?.name || 'None'}</span>${icon('chevron')}</button></div>
      <div class="grid2"><label class="field"><span>Pattern</span><select name="pattern"><option value="">Not set</option>${PATTERNS.map(p => raw(html`<option ${raw(p === it.pattern ? 'selected' : '')}>${p}</option>`))}</select></label>
      <label class="field"><span>Fabric</span><select name="fabric"><option value="">Not set</option>${FABRICS.map(p => raw(html`<option ${raw(p === it.fabric ? 'selected' : '')}>${p}</option>`))}</select></label></div>
      <label class="field"><span>Fit / silhouette</span><select name="fit"><option value="">Not set</option>${FITS.map(x => raw(html`<option ${raw(x === (it.fit || '') ? 'selected' : '')}>${x}</option>`))}</select></label>
      <div class="field"><span>Weather / season</span><div class="chips wrap meta-seasons">${seasonChoices.map(x => raw(html`<button type="button" class="chip${d.seasons.includes(x) ? ' on' : ''}" aria-pressed="${d.seasons.includes(x)}" data-season="${x}">${x}</button>`))}</div></div>
      <div class="field"><span>Good for</span><div class="chips wrap meta-occasions">${occChoices.map(x => raw(html`<button type="button" class="chip${d.occasions.includes(x) ? ' on' : ''}" aria-pressed="${d.occasions.includes(x)}" data-itemocc="${x}">${x}</button>`))}</div></div>
      <label class="field"><span>How dressy? <b class="fval">${it.formality ?? CAT[it.category]?.f}</b>/5</span><input type="range" name="formality" min="1" max="5" step="1" value="${it.formality ?? CAT[it.category]?.f ?? 3}" aria-label="How dressy, 1 very casual to 5 very formal"><span class="range-ends"><em>Very casual</em><em>Very formal</em></span></label>
      <div class="field"><span>Status</span><div class="chips" role="radiogroup" aria-label="Status">${STATUSES.map(s => raw(html`<label class="chip radio${it.status === s ? ' on' : ''}"><input type="radio" name="status" value="${s}" ${raw(it.status === s ? 'checked' : '')}>${s}</label>`))}</div>
        ${it.status === 'Laundry' ? raw(html`<div class="status-note"><p class="muted small">${laundryDue ? 'This has been in Laundry for 3+ days. Is it ready to wear?' : 'It stays unavailable until you mark it Available.'}</p><button type="button" class="btn small secondary" data-laundry-ready>Mark Available</button></div>`) : ''}</div>
      <label class="check"><input type="checkbox" name="favourite" ${raw(it.favourite ? 'checked' : '')}><span>Favourite</span></label>
      <label class="field"><span>Notes</span><textarea name="notes" rows="2" maxlength="300">${it.notes || ''}</textarea></label>
      <div class="sticky-save"><button class="btn primary" type="submit">Save changes</button><a class="btn ghost" href="#/wardrobe">Cancel</a></div>
    </form>
    <div class="card facts"><p>Worn ${plural(it.timesWorn || 0, 'time')}${it.lastWorn ? `, last on ${prettyDate(it.lastWorn)}` : ''}.</p>
      ${sets.length ? raw(html`<p>Part of ${sets.map(s => s.name).join(', ')}.</p>`) : ''}${looks ? raw(html`<p>In ${plural(looks, 'saved look')}.</p>`) : ''}</div>
    <div class="btn-col"><a class="btn secondary" href="#/mix/around/${it.id}">${icon('shuffle')}<span>Outfits with this</span></a>
      <button class="btn ghost danger-text" data-del>${icon('trash')}<span>Delete this piece</span></button></div>
  </div>`;
  hydrate(el);
  const form = $('form', el);
  const out = $('.fval', form);
  let touchedF = it.formality != null;
  form.formality.addEventListener('input', () => { out.textContent = form.formality.value; });
  form.category.addEventListener('change', () => { if (!touchedF) { form.formality.value = CAT[form.category.value].f; out.textContent = form.formality.value; } });
  form.formality.addEventListener('change', () => { touchedF = true; });
  $$('.chip.radio input', form).forEach(r => r.addEventListener('change', () => $$('.chip.radio', form).forEach(c => c.classList.toggle('on', c.querySelector('input').checked))));
  const setColour = c => { d.colour = c; $('.cname', el).textContent = c.name; $('[data-colour] .swatch', el).style.setProperty('--c', c.hex); };
  const setColour2 = c => { d.secondColour = c; $('.cname2', el).textContent = c ? c.name : 'None'; $('[data-colour2] .swatch', el).style.setProperty('--c', c ? c.hex : '#C9CACE'); };
  $('[data-colour]', el).onclick = () => colourSheet(d.colour, setColour);
  $('[data-colour2]', el).onclick = () => colourSheet(d.secondColour, setColour2, { allowNone: true });
  $$('[data-season]', el).forEach(b => b.onclick = () => { const v=b.dataset.season; d.seasons.includes(v) ? d.seasons=d.seasons.filter(x=>x!==v) : d.seasons.push(v); b.classList.toggle('on',d.seasons.includes(v)); b.setAttribute('aria-pressed',d.seasons.includes(v)); });
  $$('[data-itemocc]', el).forEach(b => b.onclick = () => { const v=b.dataset.itemocc; d.occasions.includes(v) ? d.occasions=d.occasions.filter(x=>x!==v) : d.occasions.push(v); b.classList.toggle('on',d.occasions.includes(v)); b.setAttribute('aria-pressed',d.occasions.includes(v)); });
  $('[data-laundry-ready]', el)?.addEventListener('click', e => {
    // Saved straight away, without redrawing the form, so unsaved edits on this screen are kept.
    mutate(s => { const w = s.wardrobe.find(x => x.id === it.id); if (w) { w.status = 'Available'; w.statusSince = today(); } }, { undo: `${it.name} marked Available`, rerender: false });
    const r = form.querySelector('input[name=status][value=Available]'); if (r) { r.checked = true; $$('.chip.radio', form).forEach(c => c.classList.toggle('on', c.querySelector('input').checked)); }
    e.currentTarget.closest('.status-note')?.remove();
  });
  $('.pickable', el)?.addEventListener('click', async e => {
    const r = e.target.getBoundingClientRect();
    const blob = await store.getImage(it.photo.full); if (!blob) return;
    const c = await colourAt(blob, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    setColour({ ...c, source: 'user' }); toast(`Colour set to ${c.name} — tap Save changes to keep it`, { ms: 3000 });
  });
  form.addEventListener('submit', e => {
    e.preventDefault();
    const name = form.name.value.trim(); if (!name) { toast('Please give it a name', { ms: 2500 }); return; }
    const status = form.status.value;
    mutate(s => {
      const w = s.wardrobe.find(x => x.id === it.id); if (!w) return;
      if (w.category !== form.category.value && CAT[w.category]?.prefix !== CAT[form.category.value]?.prefix) { /* keep the code so old AI chats still match */ }
      Object.assign(w, { name, category: form.category.value, colour: d.colour, secondColour: d.secondColour, pattern: form.pattern.value, fabric: form.fabric.value, fit: form.fit.value, seasons: [...d.seasons], occasions: [...d.occasions], formality: touchedF ? +form.formality.value : w.formality, favourite: form.favourite.checked, notes: form.notes.value.trim() });
      if (w.status !== status) { w.status = status; w.statusSince = today(); }
    }, { undo: 'Changes saved', rerender: false });
    go('wardrobe');
  });
  $('[data-photo]', el).onclick = async () => {
    const [f] = await pickFiles({ accept: 'image/*' }); if (!f) return;
    try {
      const p = await processPhoto(f);
      const old = [it.photo?.full, it.photo?.thumb].filter(Boolean);
      mutate(s => { const w = s.wardrobe.find(x => x.id === it.id); w.photo = { full: p.full, thumb: p.thumb }; w.fp = p.fp; if (w.colour?.source !== 'user') w.colour = { hex: p.colour.hex, name: p.colour.name }; s.settings.photosSinceBackup = (s.settings.photosSinceBackup || 0) + 1; }, { undo: 'Photo updated', dropImages: old });
    } catch (err) { toast(err.message, { ms: 4000 }); }
  };
  $('[data-rmphoto]', el)?.addEventListener('click', () => {
    const old = [it.photo?.full, it.photo?.thumb].filter(Boolean);
    mutate(s => { const w = s.wardrobe.find(x => x.id === it.id); w.photo = null; }, { undo: 'Photo removed (details kept)', dropImages: old });
  });
  $('[data-del]', el).onclick = () => {
    const drop = [it.photo?.full, it.photo?.thumb].filter(Boolean);
    go('wardrobe');
    mutate(s => { s.wardrobe = s.wardrobe.filter(w => w.id !== it.id); s.sets = s.sets.map(x => ({ ...x, itemIds: x.itemIds.filter(i => i !== it.id) })).filter(x => x.itemIds.length > 1); }, { undo: `${it.name} deleted`, dropImages: drop });
  };
});

function colourSheet(current, onPick, { allowNone = false } = {}) {
  const s = openSheet(html`<div class="palette">${allowNone ? raw(html`<button class="pal none${current ? '' : ' on'}" data-none aria-label="None"><span class="swatch none-sw"></span><span>None</span></button>`) : ''}${PALETTE.map(([n, h]) => raw(html`<button class="pal${current?.name === n ? ' on' : ''}" data-n="${n}" data-h="${h}" aria-label="${n}"><span class="swatch" style="--c:${h}"></span><span>${n}</span></button>`))}</div>`, { title: allowNone ? 'Choose second colour' : 'Choose colour' });
  s.body.addEventListener('click', async e => { const b = e.target.closest('.pal'); if (!b) return; onPick(b.dataset.none != null ? null : { hex: b.dataset.h, name: b.dataset.n, source: 'user' }); await s.close(); });
}
// One tap: every piece in the laundry is Available again (with Undo). Nothing comes back from the laundry by itself.
function laundryBack() {
  const ids = state.wardrobe.filter(w => w.status === 'Laundry').map(w => w.id);
  if (!ids.length) { toast('Nothing is in the laundry', { ms: 2000 }); return; }
  mutate(s => { for (const w of s.wardrobe) if (ids.includes(w.id)) { w.status = 'Available'; w.statusSince = today(); } }, { undo: `${plural(ids.length, 'piece')} back from the laundry` });
}

// ---------- adding ----------
async function processPhoto(file) {
  const big = await shrink(file, 800, 0.8);
  const small = await shrink(big.bmp, 200, 0.75);
  const a = analyse(big.bmp);
  const full = await store.putImage(big.blob, 'wardrobe', { w: big.w, h: big.h });
  const thumb = await store.putImage(small.blob, 'wardrobe-thumb', { w: small.w, h: small.h });
  return { full, thumb, colour: a.colour, fp: a.fp, bytes: big.blob.size + small.blob.size };
}

route('add', (el, [mode]) => {
  if (mode === 'photos') return addPhotos(el);
  if (mode === 'list') return addList(el);
  if (mode === 'review') return reviewBatch(el);
  el.innerHTML = html`<div class="page">${pageHead('Add clothes', { back: '#/wardrobe' })}
    <p class="lead">Start with the 15 things you wear most.</p>
    <div class="starts"><a class="start" href="#/add/photos">${icon('image')}<div><b>From photos</b><span>Best: colours are found for you</span></div>${icon('chevron')}</a>
    <a class="start" href="#/add/list">${icon('paste')}<div><b>Type a list</b><span>Quick: “2 white shirts, navy chinos, brown loafers”</span></div>${icon('chevron')}</a></div></div>`;
});

function addPhotos(el) {
  const risk = photosAtRisk();
  el.innerHTML = html`<div class="page">${pageHead('Add from photos', { back: '#/add' })}
    ${risk ? raw(html`<div class="card warn-card">${icon('warn')}<div><b>Add Style You to your Home Screen first</b><p>In a Safari tab, photos are kept only until you close Safari. Details you add are saved, but add to your Home Screen to keep the photos.</p></div></div>`) : ''}
    ${!state.settings.photoTipsSeen ? raw(html`<div class="card tips"><b>For the best results</b><ul><li>One piece per photo</li><li>Plain background, like a bed sheet or floor</li><li>Daylight, no flash</li></ul></div>`) : ''}
    <div class="btn-col"><button class="btn primary big" data-pick>${icon('image')}<span>Choose photos</span></button>
    <button class="btn secondary" data-cam>${icon('camera')}<span>Take a photo</span></button></div>
    <p class="muted center">You can pick several at once. Photos are made smaller on this device and never uploaded.</p>
    <div class="progress" hidden><div class="bar"><span></span></div><p class="muted center ptext"></p></div></div>`;
  const run = async files => {
    files = files.filter(f => /^image\//.test(f.type) || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name));
    if (!files.length) return;
    state.settings.photoTipsSeen = true; save();
    const pr = $('.progress', el), bar = $('.bar span', el), pt = $('.ptext', el); pr.hidden = false;
    $$('button', el).forEach(b => b.disabled = true);
    const batch = ui.addBatch || []; ui.keepImages = ui.keepImages || [];
    let failed = 0;
    for (let i = 0; i < files.length; i++) {
      pt.textContent = `Preparing ${i + 1} of ${files.length}…`; bar.style.width = `${Math.round(100 * i / files.length)}%`;
      try {
        const p = await processPhoto(files[i]);
        ui.keepImages.push(p.full, p.thumb);
        const dupOf = [...state.wardrobe, ...batch].find(w => w.fp && hamming(w.fp, p.fp) <= DUPLICATE_DISTANCE);
        batch.push({ key: 'b' + Math.random().toString(36).slice(2), name: '', category: null, colour: { hex: p.colour.hex, name: p.colour.name }, photo: { full: p.full, thumb: p.thumb }, fp: p.fp, dupOf: dupOf ? (dupOf.code || 'another photo in this batch') : null, dupName: dupOf?.name || '' });
      } catch (e) { failed++; console.warn(e); }
    }
    ui.addBatch = batch;
    if (failed) toast(`${plural(failed, 'photo')} could not be opened (try JPEG or PNG).`, { ms: 5000 });
    go('add/review');
  };
  $('[data-pick]', el).onclick = async () => run(await pickFiles({ accept: 'image/*', multiple: true }));
  if (ui.pendingShared?.length) { const f = ui.pendingShared; ui.pendingShared = null; run(f.map(b => b instanceof File ? b : new File([b], 'shared.jpg', { type: b.type || 'image/jpeg' }))); }
  $('[data-cam]', el).onclick = async () => run(await pickFiles({ accept: 'image/*', capture: 'environment' }));
}

function reviewBatch(el) {
  const batch = ui.addBatch || [];
  if (!batch.length) { go('add/photos'); return; }
  el.innerHTML = html`<div class="page review-page">${pageHead(`Check ${plural(batch.length, 'piece')}`, { back: '#/add/photos', sub: 'Pick a category for each. Tap the photo if the colour is wrong.' })}
    <div class="review-list">${batch.map((b, i) => raw(html`<article class="rv card" data-i="${i}">
      <div class="rv-top"><div class="rv-pic"><img data-img="${b.photo.full}" alt="Photo ${i + 1}" class="pickable"></div>
        <div class="rv-meta"><button class="colour-btn small" data-colour>${swatch(b.colour.hex)}<span class="cname">${b.colour.name}</span></button>
        <input class="rv-name" placeholder="Name (optional)" maxlength="80" value="${b.name}" aria-label="Name">
        ${b.dupOf ? raw(html`<p class="warn small">Looks like ${b.dupOf}${b.dupName ? ` (${b.dupName})` : ''}.</p>`) : ''}</div>
        <button class="icon-btn" data-rm aria-label="Remove from this batch">${icon('close')}</button></div>
      <div class="chips wrap cat-chips" role="radiogroup" aria-label="Category">${QUICK_CATS.map(c => raw(html`<button class="chip${b.category === c ? ' on' : ''}" aria-pressed="${b.category === c}" data-cat="${c}">${CAT[c].label.split(' /')[0]}</button>`))}
        <select class="chip-select" aria-label="More categories"><option value="">More…</option>${CATEGORIES.filter(c => !QUICK_CATS.includes(c.id)).map(c => raw(html`<option value="${c.id}" ${raw(b.category === c.id ? 'selected' : '')}>${c.label}</option>`))}</select></div>
    </article>`))}</div>
    <div class="sticky-save"><button class="btn primary big" data-save>Save ${plural(batch.length, 'piece')}</button><button class="btn ghost" data-cancel>Cancel</button></div></div>`;
  hydrate(el);
  const missingCat = () => batch.filter(b => !b.category).length;
  const updSave = () => { const m = missingCat(); $('[data-save]', el).textContent = m ? `Save ${plural(batch.length, 'piece')} (${m} as “Other”)` : `Save ${plural(batch.length, 'piece')}`; };
  updSave();
  $$('.rv', el).forEach(card => {
    const b = batch[+card.dataset.i];
    card.addEventListener('click', async e => {
      const c = e.target.closest('[data-cat]');
      if (c) { b.category = c.dataset.cat; $$('[data-cat]', card).forEach(x => { x.classList.toggle('on', x === c); x.setAttribute('aria-pressed', x === c); }); $('.chip-select', card).value = ''; updSave(); }
      if (e.target.closest('[data-colour]')) colourSheet(b.colour, col => { b.colour = col; $('.cname', card).textContent = col.name; $('.swatch', card).style.setProperty('--c', col.hex); });
      if (e.target.closest('[data-rm]')) {
        const i = batch.indexOf(b); batch.splice(i, 1);
        reviewBatch(el);
        toast('Removed from this batch', { undo: () => { batch.splice(i, 0, b); reviewBatch(el); }, onExpire: () => { if (!batch.includes(b)) { store.deleteImage(b.photo.full); store.deleteImage(b.photo.thumb); } } });
      }
      const pic = e.target.closest('.pickable');
      if (pic) {
        const r = pic.getBoundingClientRect(); const blob = await store.getImage(b.photo.full); if (!blob) return;
        const col = await colourAt(blob, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
        b.colour = { ...col, source: 'user' }; $('.cname', card).textContent = col.name; $('.swatch', card).style.setProperty('--c', col.hex);
      }
    });
    $('.chip-select', card).addEventListener('change', e => { if (!e.target.value) return; b.category = e.target.value; $$('[data-cat]', card).forEach(x => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); }); updSave(); });
    $('.rv-name', card).addEventListener('input', e => { b.name = e.target.value; });
  });
  $('[data-save]', el).onclick = e => {
    if (e.currentTarget.disabled || !batch.length) return; e.currentTarget.disabled = true;
    const n = batch.length;
    mutate(s => {
      for (const b of batch) {
        const cat = b.category || 'other';
        const it = newItem(s, { name: b.name.trim() || `${b.colour.name} ${CAT[cat].label.split(' /')[0].toLowerCase()}`, category: cat, colourHex: b.colour.hex, colourName: b.colour.name, photo: b.photo, fp: b.fp });
        if (b.colour.source) it.colour.source = b.colour.source;
        s.wardrobe.push(it);
      }
      s.settings.photosSinceBackup = (s.settings.photosSinceBackup || 0) + n;
    }, { undo: `${plural(n, 'piece')} added`, rerender: false });
    ui.addBatch = []; ui.keepImages = [];
    ui.wFilter = 'all'; go('wardrobe');
  };
  $('[data-cancel]', el).onclick = async () => {
    if (!(await confirmSheet({ title: 'Discard these photos?', text: `${plural(batch.length, 'photo')} will not be added.`, ok: 'Discard', danger: true }))) return;
    for (const b of batch) { store.deleteImage(b.photo.full); store.deleteImage(b.photo.thumb); }
    ui.addBatch = []; ui.keepImages = []; go('wardrobe');
  };
}

function addList(el) {
  el.innerHTML = html`<div class="page">${pageHead('Type a list', { back: '#/add' })}
    <label class="field"><span>One piece per line, or separated by commas</span><textarea rows="7" maxlength="4000" placeholder="2 white shirts&#10;navy chinos&#10;blue kurti&#10;brown loafers&#10;gold jhumkas">${ui.listDraft || ''}</textarea></label>
    <button class="btn primary big" data-preview>Preview</button><div class="lp"></div></div>`;
  const ta = $('textarea', el);
  ta.addEventListener('input', () => { ui.listDraft = ta.value; });
  $('[data-preview]', el).onclick = () => {
    const names = splitBulk(ta.value);
    if (!names.length) { toast('Type at least one piece', { ms: 2500 }); return; }
    const rows = names.map(n => { const cn = guessColourWord(n); const hex = hexForName(cn); return { name: n, category: guessCategory(n), colour: hex ? { hex, name: cn } : null }; });
    const lp = $('.lp', el);
    const draw = () => {
      lp.innerHTML = html`<ul class="list-rows">${rows.map((r, i) => raw(html`<li data-i="${i}">${swatch(r.colour?.hex || '#C9CACE')}<input value="${r.name}" maxlength="80" aria-label="Name"><select aria-label="Category">${CATEGORIES.map(c => raw(html`<option value="${c.id}" ${raw(c.id === r.category ? 'selected' : '')}>${c.label}</option>`))}</select><button class="icon-btn" data-rm aria-label="Remove">${icon('close')}</button></li>`))}</ul>
        ${rows.some(r => !r.colour) ? raw('<p class="muted small">Grey dots: no colour found in the name. You can set it later, or add a photo.</p>') : ''}
        <div class="sticky-save"><button class="btn primary big" data-save ${raw(rows.length ? '' : 'disabled')}>Add ${plural(rows.length, 'piece')}</button></div>`;
      $$('li', lp).forEach(li => {
        const r = rows[+li.dataset.i];
        $('input', li).oninput = e => { r.name = e.target.value; };
        $('select', li).onchange = e => { r.category = e.target.value; };
        $('[data-rm]', li).onclick = () => { rows.splice(rows.indexOf(r), 1); draw(); };
      });
      $('[data-save]', lp).onclick = e => {
        if (e.currentTarget.disabled) return; e.currentTarget.disabled = true;
        const good = rows.filter(r => r.name.trim());
        mutate(s => { for (const r of good) { const cn = r.colour?.name || guessColourWord(r.name); s.wardrobe.push(newItem(s, { name: r.name.trim(), category: r.category, colourName: hexForName(cn) ? cn : undefined, colourHex: hexForName(cn) || undefined })); } }, { undo: `${plural(good.length, 'piece')} added`, rerender: false });
        ui.listDraft = ''; ui.wFilter = 'all'; go('wardrobe');
      };
    };
    draw();
  };
}
Object.defineProperty(exports,'laundryBack',{enumerable:true,get:()=>laundryBack});
Object.defineProperty(exports,'insights',{enumerable:true,get:()=>insights});
Object.defineProperty(exports,'colourSheet',{enumerable:true,get:()=>colourSheet});
};
__mods['js/views/week.js'] = function(require,exports,module){
// Week planner: a different outfit for each chosen day, planned on the phone (instant, offline) or by the AI.
const { state, mutate, route, go, ui, today, itemById, availableNow, aiName } = require('js/app.js');
const { $, $$, html, raw, icon, toast, openSheet } = require('js/ui.js');
const { DAY_TYPES, DAY, CAT } = require('js/catalog.js');
const { planDays, suggest, wardrobeReady } = require('js/engine.js');
const { addDays, prettyDate } = require('js/util.js');
const { weekRequest, WEEKDAY_KEYS, wardrobeLines, fixFormatRequest } = require('js/prompts.js');
const { parseCodeOutfits } = require('js/parse.js');
const { forecastRange } = require('js/weather.js');
const { board, hydrate, woreThis, empty, handoffHTML, wireHandoff, pasteHTML, wirePaste, copyNow } = require('js/parts.js');
const { pageHead, CREDIT } = require('js/views/common.js');

function draftDays() {
  if (ui.weekDraft) return ui.weekDraft;
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(today(), i); const wd = new Date(`${date}T12:00:00`).getDay();
    days.push({ date, key: WEEKDAY_KEYS[wd], on: wd !== 0, dayType: wd === 0 || wd === 6 ? 'casual' : 'work' });
  }
  ui.weekDraft = days; return days;
}

route('week', async (el, [mode]) => {
  const plan = state.week;
  if (plan && mode !== 'new') return showPlan(el, plan);
  const days = draftDays();
  const ready = wardrobeReady(state.wardrobe.filter(w => w.status !== 'Archived'), today());
  el.innerHTML = html`<div class="page week">${pageHead('Plan my week', { back: plan ? '#/week' : '#/home' })}
    ${!ready ? empty('Add a few more clothes', 'Planning needs at least one top and one bottom, or a full outfit.', html`<a class="btn primary" href="#/add">${icon('plus')}<span>Add clothes</span></a>`) : raw(html`
    <p class="lead">Choose the days and what each one is for.</p>
    <ul class="week-days">${days.map((d, i) => raw(html`<li class="${d.on ? '' : 'off'}"><label class="check"><input type="checkbox" data-on="${i}" ${raw(d.on ? 'checked' : '')}><span>${prettyDate(d.date)}</span></label>
      <select data-type="${i}" aria-label="Kind of day for ${prettyDate(d.date)}" ${raw(d.on ? '' : 'disabled')}>${DAY_TYPES.map(t => raw(html`<option value="${t.id}" ${raw(t.id === d.dayType ? 'selected' : '')}>${t.label}</option>`))}</select><span class="wx muted small" data-wx="${i}"></span></li>`))}</ul>
    ${CREDIT}
    <div class="btn-col"><button class="btn primary big" data-local>${icon('shuffle')}<span>Plan on this device</span></button>
    <button class="btn secondary" data-ai>${icon('wand')}<span>Ask ${aiName()} to plan</span></button></div>
    <p class="muted center small">On this device: instant, works offline. ${aiName()}: you copy a request and paste the reply back.</p>`)}</div>`;
  if (!ready) return;
  $$('[data-on]', el).forEach(c => c.onchange = () => { days[+c.dataset.on].on = c.checked; go('week/new'); });
  $$('[data-type]', el).forEach(s => s.onchange = () => { days[+s.dataset.type].dayType = s.value; });
  const chosen = () => days.filter(d => d.on);
  $('[data-local]', el).onclick = () => {
    const c = chosen(); if (!c.length) { toast('Choose at least one day', { ms: 2500 }); return; }
    const res = planDays(state.wardrobe, state.worn, state.sets, c.map(d => ({ ...d, temp: d.wx?.temp, extras: d.wx?.extras, label: DAY[d.dayType].label })), { avoidColours: state.profile.avoidColours, style: state.settings.mixStyle || 'fusion' }, today());
    savePlan(res.map(r => ({ date: r.date, key: r.key, dayType: r.dayType, weather: r.wx || null, ids: r.outfit?.ids || [], why: r.outfit?.why || '', title: r.outfit?.title || 'No outfit found', repeat: r.repeat, source: 'phone' })));
  };
  $('[data-ai]', el).onclick = () => aiPlan(chosen());
  // Forecast for the visible days (best effort).
  const c = state.profile.city;
  if (c && days.some(d => d.wx === undefined)) {
    days.forEach(d => { if (d.wx === undefined) d.wx = null; });
    try {
      const wx = await forecastRange(c.lat, c.lon, days[0].date, days[6].date);
      days.forEach(d => { d.wx = wx[d.date] || null; });
    } catch { /* weather is optional here */ }
  }
  days.forEach((d, i) => { const t = $(`[data-wx="${i}"]`, el); if (t && d.wx) t.textContent = [d.wx.temp, ...d.wx.extras].filter(Boolean).join(' · '); });
});

function savePlan(days) {
  mutate(s => { s.week = { createdAt: new Date().toISOString(), days }; }, { undo: 'Week planned', rerender: false });
  ui.weekDraft = null;
  go('week');
}

function aiPlan(days, which = state.profile.defaultAI) {
  if (!days.length) { toast('Choose at least one day', { ms: 2500 }); return; }
  const lines = days.map(d => ({ key: d.key, date: d.date, label: DAY[d.dayType].label, weather: d.wx ? [d.wx.temp, ...d.wx.extras].filter(Boolean).join(' + ') : '' }));
  const text = weekRequest(lines, state.profile, wardrobeLines(state.wardrobe.filter(w => w.status !== 'Archived'), availableNow));
  const s = openSheet(html`${handoffHTML({ text, which, after: ['Copy the reply and come back here.'] })}<hr>${pasteHTML()}<div class="parse-msg"></div>`, { title: `Plan with ${aiName(which)}`, full: true });
  wireHandoff(s.body, { text, onSwitch: w => s.close().then(() => aiPlan(days, w)) });
  wirePaste(s.body, async t => {
    const got = parseCodeOutfits(t, state.wardrobe, 'DAY');
    const byKey = new Map(got.map(g => [g.key, g]));
    const matched = days.filter(d => byKey.get(d.key)?.ids.length);
    if (!matched.length) {
      $('.parse-msg', s.body).innerHTML = html`<div class="card warn-card"><p>Couldn't find the day plans in that text.</p><button class="btn secondary" data-fix>Copy “please repeat in the right format”</button></div>`;
      $('[data-fix]', s.body).onclick = () => copyNow(fixFormatRequest('DAY')).then(() => toast('Copied. Paste it in the same chat.', { ms: 3000 }));
      return;
    }
    const unknown = got.flatMap(g => g.unknown);
    await s.close();
    savePlan(days.map(d => { const g = byKey.get(d.key); return { date: d.date, key: d.key, dayType: d.dayType, weather: d.wx || null, ids: g?.ids || [], why: g?.why || '', title: g?.ids.length ? `${DAY[d.dayType].label} outfit` : 'Not planned', missing: g?.missing || '', source: 'ai' }; }));
    if (unknown.length) toast(`Ignored codes not in your wardrobe: ${unknown.join(', ')}`, { ms: 6000 });
  });
}

function showPlan(el, plan) {
  const days = plan.days.filter(d => d.date >= today());
  el.innerHTML = html`<div class="page week">${pageHead('This week', { back: '#/home', actions: html`<a class="btn small ghost" href="#/week/new">New plan</a>` })}
    ${!days.length ? empty('This plan has finished', 'Make a new plan for the coming days.', '<a class="btn primary" href="#/week/new">New plan</a>') : raw(html`${days.map(d => { const idx = plan.days.indexOf(d); const gone = d.ids.filter(id => !itemById(id)).length; return raw(html`<section class="card day" data-d="${idx}">
      <div class="row between"><h2>${d.date === today() ? 'Today' : prettyDate(d.date, { weekday: 'long', day: 'numeric', month: 'short' })}</h2><span class="muted">${DAY[d.dayType]?.label || ''}${d.weather?.temp ? ` · ${[d.weather.temp, ...(d.weather.extras || [])].join(' · ')}` : ''}</span></div>
      ${d.ids.length ? board(d.ids.filter(id => itemById(id))) : raw('<p class="muted">No outfit for this day.</p>')}
      ${d.why ? raw(html`<p>${d.why}</p>`) : ''}${d.repeat ? raw('<p class="warn small">Repeats a piece from another day — not enough other options.</p>') : ''}
      ${d.missing && !/^none\.?$/i.test(d.missing) ? raw(html`<p class="opt">Missing: ${d.missing}</p>`) : ''}${gone ? raw('<p class="warn small">Some pieces were removed from your wardrobe.</p>') : ''}
      <div class="row">${d.date === today() && d.ids.length ? raw(html`<button class="btn primary" data-wore>${icon('check')}<span>Wore this</span></button>`) : ''}<button class="btn secondary" data-swap>${icon('refresh')}<span>Another</span></button></div></section>`); })}`)}
  </div>`;
  hydrate(el);
  $$('.day', el).forEach(sec => {
    const i = +sec.dataset.d; const d = plan.days[i];
    $('[data-wore]', sec)?.addEventListener('click', () => woreThis(d.ids.filter(id => itemById(id)), { baseIds: d.ids.filter(id => ['top', 'bottom', 'one'].includes(CAT[itemById(id)?.category]?.group)) }));
    $('[data-swap]', sec).onclick = () => {
      const others = new Set(plan.days.filter((_, k) => k !== i).flatMap(x => x.ids.filter(id => ['top', 'bottom', 'one'].includes(CAT[itemById(id)?.category]?.group))));
      const r = suggest(state.wardrobe, state.worn, state.sets, { dayType: d.dayType, temp: d.weather?.temp, extras: d.weather?.extras || [], avoidColours: state.profile.avoidColours, style: state.settings.mixStyle || 'fusion', count: 20 }, today());
      const curKey = d.ids.slice().sort().join('+');
      const pick = r.outfits.find(o => o.ids.slice().sort().join('+') !== curKey && !o.baseIds.some(id => others.has(id))) || r.outfits.find(o => o.ids.slice().sort().join('+') !== curKey);
      if (!pick) { toast('No other outfit fits this day', { ms: 2500 }); return; }
      mutate(s => { Object.assign(s.week.days[i], { ids: pick.ids, why: pick.why, title: pick.title, repeat: pick.baseIds.some(id => others.has(id)), missing: '', source: 'phone' }); }, { undo: 'Outfit changed' });
    };
  });
}

};
__mods['js/weather.js'] = function(require,exports,module){
// Weather and place lookup via Open-Meteo (free, no key, non-commercial; credit shown in the app).
const { localISO, daysBetween } = require('js/util.js');

const FORECAST_DAYS = 16;

function tempTag(maxT) {
  if (!Number.isFinite(maxT)) return null;
  if (maxT >= 32) return 'Hot';
  if (maxT >= 26) return 'Warm';
  if (maxT >= 20) return 'Mild';
  if (maxT >= 13) return 'Cool';
  return 'Cold';
}
function extraTags({ humidity, rainProb, rainSum, wind }) {
  const t = [];
  if (Number.isFinite(humidity) && humidity >= 75) t.push('Humid');
  if ((Number.isFinite(rainProb) && rainProb >= 50) || (Number.isFinite(rainSum) && rainSum >= 1)) t.push('Rainy');
  if (Number.isFinite(wind) && wind >= 30) t.push('Windy');
  return t;
}

async function searchPlaces(q, fetchFn = fetch) {
  const r = await fetchFn(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`);
  if (!r.ok) throw new Error('place search failed');
  const d = await r.json();
  return (d.results || []).map(x => ({
    name: [x.name, x.admin1, x.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', '),
    short: x.name, lat: x.latitude, lon: x.longitude
  }));
}

// Returns {status:'ok'|'far'|'past', temp, extras, summary}
async function forecastFor(lat, lon, date = localISO(), fetchFn = fetch) {
  const today = localISO();
  const d = daysBetween(today, date);
  if (d < 0) return { status: 'past', temp: null, extras: [], summary: 'That date has passed — choose the conditions.' };
  if (d >= FORECAST_DAYS) return { status: 'far', temp: null, extras: [], summary: 'Too far ahead for a forecast — choose likely conditions.' };
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max&hourly=relative_humidity_2m&timezone=auto&start_date=${date}&end_date=${date}`;
  const r = await fetchFn(url);
  if (!r.ok) throw new Error('forecast failed');
  const j = await r.json(); const dd = j.daily || {};
  const n = k => { const v = Number(dd[k]?.[0]); return Number.isFinite(v) ? v : NaN; };
  const maxT = n('temperature_2m_max'), minT = n('temperature_2m_min');
  const hum = (j.hourly?.relative_humidity_2m || []).map(Number).filter(Number.isFinite);
  const humidity = hum.length ? hum.reduce((a, b) => a + b, 0) / hum.length : NaN, rainProb = n('precipitation_probability_max'), rainSum = n('precipitation_sum'), wind = n('wind_speed_10m_max');
  const temp = tempTag(maxT); const extras = extraTags({ humidity, rainProb, rainSum, wind });
  const bits = [];
  if (Number.isFinite(minT) && Number.isFinite(maxT)) bits.push(`${Math.round(minT)}–${Math.round(maxT)}°C`);
  if (Number.isFinite(humidity)) bits.push(`humidity ${Math.round(humidity)}%`);
  if (Number.isFinite(rainProb)) bits.push(`rain ${Math.round(rainProb)}%`);
  return { status: 'ok', temp, extras, maxT, summary: bits.join(' · ') };
}

// Several days in one call: returns {date: {temp, extras, summary}} for dates inside the forecast window.
async function forecastRange(lat, lon, start, end, fetchFn = fetch) {
  const today = localISO();
  const last = new Date(`${today}T12:00:00`); last.setDate(last.getDate() + FORECAST_DAYS - 1);
  const lastISO = localISO(last);
  const s = start < today ? today : start, e = end > lastISO ? lastISO : end;
  if (s > e) return {};
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max&hourly=relative_humidity_2m&timezone=auto&start_date=${s}&end_date=${e}`;
  const r = await fetchFn(url);
  if (!r.ok) throw new Error('forecast failed');
  const j = await r.json(); const dd = j.daily || {}; const out = {};
  const hours = j.hourly?.time || []; const hum = j.hourly?.relative_humidity_2m || [];
  (dd.time || []).forEach((date, i) => {
    const v = k => { const x = Number(dd[k]?.[i]); return Number.isFinite(x) ? x : NaN; };
    const hs = hum.filter((_, k) => String(hours[k] || '').startsWith(date)).map(Number).filter(Number.isFinite);
    const humidity = hs.length ? hs.reduce((a, b) => a + b, 0) / hs.length : NaN;
    const maxT = v('temperature_2m_max'), minT = v('temperature_2m_min');
    out[date] = { temp: tempTag(maxT), extras: extraTags({ humidity, rainProb: v('precipitation_probability_max'), rainSum: v('precipitation_sum'), wind: v('wind_speed_10m_max') }), maxT, summary: Number.isFinite(maxT) ? `${Math.round(minT)}–${Math.round(maxT)}°C` : '' };
  });
  return out;
}

function currentPosition(timeout = 12000) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('unsupported'));
    navigator.geolocation.getCurrentPosition(p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }), reject, { enableHighAccuracy: false, timeout, maximumAge: 600000 });
  });
}
Object.defineProperty(exports,'FORECAST_DAYS',{enumerable:true,get:()=>FORECAST_DAYS});
Object.defineProperty(exports,'tempTag',{enumerable:true,get:()=>tempTag});
Object.defineProperty(exports,'extraTags',{enumerable:true,get:()=>extraTags});
Object.defineProperty(exports,'searchPlaces',{enumerable:true,get:()=>searchPlaces});
Object.defineProperty(exports,'forecastFor',{enumerable:true,get:()=>forecastFor});
Object.defineProperty(exports,'forecastRange',{enumerable:true,get:()=>forecastRange});
Object.defineProperty(exports,'currentPosition',{enumerable:true,get:()=>currentPosition});
};
require('js/main.js');
})();
