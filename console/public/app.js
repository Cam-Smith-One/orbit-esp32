'use strict';

const MAX_PROMPT_LENGTH = 6000;
const MAX_FACT_LENGTH = 500;
const MAX_CITY_LENGTH = 100;
const MAX_CONNECTOR_NAME_LENGTH = 80;
const MAX_TOKEN_LENGTH = 4096;
const COMMAND_POLL_LIMIT = 12;

const ICON_PATHS = {
  arrow: 'M5 12h13M13 6l6 6-6 6',
  check: 'm5 12 4 4L19 6',
  close: 'M6 6l12 12M18 6 6 18',
  info: 'M12 10v6m0-9.5v.1',
  alert: 'M12 4 3.8 19h16.4L12 4Zm0 6v4m0 3v.1',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3m-12 0h14v10H5V10Z',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M20 11a8 8 0 0 0-14.7-4L3 10m0 0V5m0 5h5M4 13a8 8 0 0 0 14.7 4L21 14m0 0v5m0-5h-5',
  trash: 'M5 7h14M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5',
  cloud: 'M7.5 18h9a4.5 4.5 0 0 0 .7-8.95A6 6 0 0 0 6 10.2 4 4 0 0 0 7.5 18Z',
  memory: 'M5 4.5h11.5A2.5 2.5 0 0 1 19 7v12.5H7.5A2.5 2.5 0 0 1 5 17V4.5Zm0 0v13A2.5 2.5 0 0 0 7.5 20H19M9 9h6M9 13h5',
  link: 'M10 13.5 8.5 15a3.18 3.18 0 0 1-4.5-4.5l3-3a3.18 3.18 0 0 1 4.5 0M14 10.5 15.5 9a3.18 3.18 0 0 1 4.5 4.5l-3 3a3.18 3.18 0 0 1-4.5 0M8.5 15.5l7-7',
  pin: 'M15 4 20 9l-4 1-4 4 1 4-2 2-2-6-6-2 2-2 4 1 4-4 1-4Z',
};

const ui = {
  activeView: 'overview',
  authenticated: false,
  loading: false,
  refreshing: false,
  state: null,
  draft: null,
  dirty: {agent: false, connectors: false},
  saving: false,
  configAwaitingState: null,
  network: 'connecting',
  stateRequest: null,
  autoRefreshTimer: null,
  commandWatchers: new Map(),
  commands: new Map(),
  fieldRefs: new Map(),
  noticeTimers: new Map(),
  noticeSequence: 0,
  memoryFact: '',
  memorySubmitting: false,
  newConnector: {id: 'new', hasToken: false, name: '', url: '', tokenDraft: ''},
};

const dom = {};

class HttpError extends Error {
  constructor(status, body) {
    super(`Request failed (${status})`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

class NetworkError extends Error {
  constructor() {
    super('The dashboard could not be reached');
    this.name = 'NetworkError';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function makeNode(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function makeIcon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', className || 'icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_PATHS[name] || ICON_PATHS.info);
  svg.append(path);
  return svg;
}

function append(parent, ...children) {
  children.forEach((child) => {
    if (child !== null && child !== undefined) parent.append(child);
  });
  return parent;
}

function makeButton(label, className, iconName, type = 'button') {
  const button = makeNode('button', className);
  button.type = type;
  if (iconName) button.append(makeIcon(iconName, 'button-icon'));
  button.append(makeNode('span', '', label));
  return button;
}

function registerField(element, key) {
  element.dataset.focusKey = key;
  ui.fieldRefs.set(key, element);
  return element;
}

function normalizedId(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text ? text : null;
}

function normalizedRevision(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function normalizeConfiguredConnector(raw) {
  if (!isObject(raw)) return null;
  const id = normalizedId(raw.id);
  if (!id) return null;
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : '',
    url: typeof raw.url === 'string' ? raw.url : '',
    enabled: raw.enabled === true,
    allowedTools: Array.isArray(raw.allowedTools)
      ? [...new Set(raw.allowedTools.filter((tool) => typeof tool === 'string'))]
      : [],
    hasToken: raw.hasToken === true,
  };
}

function normalizeConfig(raw) {
  const source = isObject(raw) ? raw : {};
  const connectors = Array.isArray(source.connectors)
    ? source.connectors.map(normalizeConfiguredConnector).filter(Boolean)
    : null;
  return {
    revision: normalizedRevision(source.revision),
    prompt: typeof source.prompt === 'string' ? source.prompt : '',
    weatherCity: typeof source.weatherCity === 'string' ? source.weatherCity : '',
    connectors,
  };
}

function normalizeMemory(raw) {
  if (!isObject(raw)) return null;
  const id = normalizedId(raw.id);
  return id && typeof raw.fact === 'string' ? {id, fact: raw.fact} : null;
}

function normalizeNote(raw) {
  if (!isObject(raw)) return null;
  const id = normalizedId(raw.id);
  return id && typeof raw.text === 'string'
    ? {id, text: raw.text, created_at: raw.created_at}
    : null;
}

function normalizeTool(raw) {
  if (!isObject(raw) || typeof raw.name !== 'string' || !raw.name) return null;
  return {
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    readOnly: raw.readOnly === true,
  };
}

function normalizeSnapshotConnector(raw) {
  if (!isObject(raw)) return null;
  const id = normalizedId(raw.id);
  if (!id) return null;
  return {
    id,
    status: raw.status,
    tools: Array.isArray(raw.tools) ? raw.tools.map(normalizeTool).filter(Boolean) : null,
  };
}

function normalizeCommandResult(raw) {
  if (!isObject(raw)) return null;
  const id = normalizedId(raw.id);
  if (!id || typeof raw.ok !== 'boolean') return null;
  return {id, ok: raw.ok, error: typeof raw.error === 'string' ? raw.error : ''};
}

function normalizeQueuedCommand(raw) {
  if (!isObject(raw)) return null;
  const id = normalizedId(raw.id);
  return id && typeof raw.kind === 'string' ? {id, kind: raw.kind} : null;
}

function normalizeState(raw) {
  if (!isObject(raw) || !isObject(raw.config) || !isObject(raw.snapshot)) {
    throw new Error('The relay returned an incomplete state response');
  }
  const snapshot = raw.snapshot;
  return {
    config: normalizeConfig(raw.config),
    snapshot: {
      updatedAt: snapshot.updatedAt,
      appliedRevision: normalizedRevision(snapshot.appliedRevision),
      connected: typeof snapshot.connected === 'boolean' ? snapshot.connected : null,
      memories: Array.isArray(snapshot.memories)
        ? snapshot.memories.map(normalizeMemory).filter(Boolean)
        : null,
      notes: Array.isArray(snapshot.notes)
        ? snapshot.notes.map(normalizeNote).filter(Boolean)
        : null,
      connectors: Array.isArray(snapshot.connectors)
        ? snapshot.connectors.map(normalizeSnapshotConnector).filter(Boolean)
        : null,
      commandResults: Array.isArray(snapshot.commandResults)
        ? snapshot.commandResults.map(normalizeCommandResult).filter(Boolean)
        : null,
    },
    commands: Array.isArray(raw.commands)
      ? raw.commands.map(normalizeQueuedCommand).filter(Boolean)
      : null,
  };
}

function draftFromConfig(config) {
  return {
    prompt: config.prompt,
    weatherCity: config.weatherCity,
    connectors: Array.isArray(config.connectors)
      ? config.connectors.map((connector) => ({...connector, tokenDraft: ''}))
      : [],
  };
}

function publicConnectorFromDraft(connector) {
  return {
    id: connector.id,
    name: connector.name.trim(),
    url: connector.url.trim(),
    enabled: connector.enabled === true,
    allowedTools: [...new Set(connector.allowedTools.filter((tool) => typeof tool === 'string'))],
  };
}

function savePayloadFromDraft() {
  return {
    revision: ui.state.config.revision,
    prompt: ui.draft.prompt,
    weatherCity: ui.draft.weatherCity,
    connectors: ui.draft.connectors.map((connector) => {
      const saved = publicConnectorFromDraft(connector);
      if (connector.clearToken) saved.token = '';
      else if (typeof connector.tokenDraft === 'string' && connector.tokenDraft.trim()) {
        saved.token = connector.tokenDraft;
      }
      return saved;
    }),
  };
}

function connectorSignature(connectors) {
  return JSON.stringify((connectors || []).map((connector) => ({
    id: connector.id,
    name: connector.name,
    url: connector.url,
    enabled: connector.enabled === true,
    allowedTools: [...new Set(connector.allowedTools || [])].sort(),
  })));
}

function configMatchesPayload(config, payload) {
  return config.prompt === payload.prompt
    && config.weatherCity === payload.weatherCity
    && config.connectors !== null
    && connectorSignature(config.connectors) === connectorSignature(payload.connectors);
}

function revisionText(value) {
  return value === null || value === undefined ? 'Not reported' : `r${value}`;
}

function formatDateTime(value) {
  if (value === null || value === undefined || value === '') return 'Not reported';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(date);
}

function makeTime(value, className = '') {
  const time = makeNode('time', className, formatDateTime(value));
  if (value !== null && value !== undefined) time.dateTime = String(value);
  return time;
}

function statusTone(value) {
  if (value === true) return 'good';
  if (value === false) return 'danger';
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (text.includes('error') || text.includes('fail') || text.includes('offline')) return 'danger';
  if (text.includes('connected') || text.includes('online') || text === 'ok' || text.includes('success')) return 'good';
  if (text.includes('pending') || text.includes('test')) return 'warn';
  return 'quiet';
}

function statusLabel(value, fallback = 'Not reported') {
  if (value === true) return 'Connected';
  if (value === false) return 'Offline';
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.trim().replace(/(^|[\s_-])([a-z])/g, (_, separator, letter) => `${separator}${letter.toUpperCase()}`);
}

function makeStatusPill(label, tone = 'quiet') {
  const pill = makeNode('span', `status-pill status-pill--${tone}`);
  pill.append(makeNode('span', 'status-pill-dot', ''), makeNode('span', '', label));
  return pill;
}

function makeEyebrow(text) {
  return makeNode('p', 'eyebrow', text);
}

function makePageHeading(kicker, title, description, action = null) {
  const heading = makeNode('section', 'page-heading');
  const copy = makeNode('div', 'page-heading-copy');
  append(copy, makeEyebrow(kicker), makeNode('h1', '', title), makeNode('p', 'page-heading-description', description));
  heading.append(copy);
  if (action) heading.append(action);
  return heading;
}

function makePanelHeader(kicker, title, description = '') {
  const header = makeNode('div', 'panel-header');
  const copy = makeNode('div', 'panel-header-copy');
  append(copy, kicker ? makeEyebrow(kicker) : null, makeNode('h2', '', title));
  if (description) copy.append(makeNode('p', 'panel-description', description));
  header.append(copy);
  return header;
}

function makeEmptyState(title, description, iconName = 'info') {
  const empty = makeNode('div', 'empty-state');
  const iconWrap = makeNode('div', 'empty-state-icon');
  iconWrap.append(makeIcon(iconName));
  append(empty, iconWrap, makeNode('h3', '', title), makeNode('p', '', description));
  return empty;
}

function makeMetricCard(label, value, description, tone = 'quiet') {
  const card = makeNode('article', 'metric-card');
  card.append(makeNode('span', 'metric-label', label));
  const valueNode = makeNode('strong', `metric-value metric-value--${tone}`, value);
  card.append(valueNode, makeNode('span', 'metric-description', description));
  return card;
}

function connectionState() {
  const timestamp = Date.parse(ui.state?.snapshot.updatedAt || '');
  if (!Number.isFinite(timestamp)) return {label: 'Not synced', tone: 'quiet', title: 'Waiting for Orbit.'};
  if (Date.now() - timestamp > 120000) return {label: 'Offline', tone: 'danger', title: 'The Mac relay is offline.'};
  const connected = ui.state?.snapshot.connected;
  if (connected === true) return {label: 'Voice connected', tone: 'good', title: 'Orbit is in conversation.'};
  if (connected === false) return {label: 'Relay online', tone: 'good', title: 'Ready when you are.'};
  return {label: 'Not reported', tone: 'quiet', title: 'Relay status is unavailable.'};
}

function snapshotConnector(id) {
  const connectors = ui.state?.snapshot.connectors;
  if (!Array.isArray(connectors)) return null;
  return connectors.find((connector) => connector.id === String(id)) || null;
}

function connectorStatus(id) {
  const snapshot = snapshotConnector(id);
  if (!snapshot) return {label: 'No test result', tone: 'quiet'};
  return {label: statusLabel(snapshot.status), tone: statusTone(snapshot.status)};
}

function saveStatus() {
  if (ui.saving) return {label: 'Saving configuration…', tone: 'saving'};
  if (ui.dirty.agent || ui.dirty.connectors) return {label: 'Unsaved changes', tone: 'dirty'};
  if (ui.configAwaitingState) return {label: 'Saved · waiting for relay', tone: 'pending'};
  if (!ui.state) return {label: ui.loading ? 'Loading live state…' : 'State unavailable', tone: 'quiet'};
  const revision = ui.state.config.revision;
  const applied = ui.state.snapshot.appliedRevision;
  if (ui.state.snapshot.updatedAt && revision !== null && applied !== null && String(revision) === String(applied)) {
    return {label: 'Applied to relay', tone: 'applied'};
  }
  if (revision !== null && applied !== null) return {label: 'Saved · waiting for relay', tone: 'pending'};
  return {label: 'Saved · revision not reported', tone: 'saved'};
}

function setClassState(element, prefix, value) {
  [...element.classList].filter((className) => className.startsWith(prefix)).forEach((className) => element.classList.remove(className));
  element.classList.add(`${prefix}${value}`);
}

function renderChrome() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === ui.activeView;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });

  const networkLabels = {
    connecting: 'Connecting to dashboard',
    online: 'Private cloud console',
    offline: 'Dashboard unavailable',
  };
  dom.networkLabel.textContent = networkLabels[ui.network] || networkLabels.connecting;
  setClassState(dom.networkDot, 'status-dot--', ui.network === 'online' ? 'good' : ui.network === 'offline' ? 'danger' : 'quiet');

  const sync = saveStatus();
  dom.syncLabel.textContent = sync.label;
  setClassState(dom.syncState, 'sync-state--', sync.tone);
  dom.refreshButton.disabled = ui.refreshing;
  dom.mobileRefreshButton.disabled = ui.refreshing;
  dom.logoutButton.disabled = ui.saving;

  document.querySelectorAll('[data-save-button]').forEach((button) => {
    button.disabled = ui.saving;
    const label = button.querySelector('[data-save-label]');
    if (label) label.textContent = ui.saving ? 'Saving…' : 'Save configuration';
  });
  document.querySelectorAll('[data-save-status]').forEach((element) => {
    element.textContent = sync.label;
    setClassState(element, 'save-status--', sync.tone);
  });
}

function captureRenderContext() {
  const active = document.activeElement;
  if (!active || !dom.viewRoot.contains(active)) return {inside: false, scrollY: window.scrollY};
  return {
    inside: true,
    key: active.dataset.focusKey || null,
    selectionStart: typeof active.selectionStart === 'number' ? active.selectionStart : null,
    selectionEnd: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
    scrollY: window.scrollY,
  };
}

function restoreRenderContext(context) {
  if (!context) return;
  if (context.inside && context.key) {
    const next = ui.fieldRefs.get(context.key);
    if (next) {
      next.focus({preventScroll: true});
      if (context.selectionStart !== null && typeof next.setSelectionRange === 'function') {
        next.setSelectionRange(context.selectionStart, context.selectionEnd ?? context.selectionStart);
      }
    }
  }
  if (typeof context.scrollY === 'number') window.scrollTo({top: context.scrollY, behavior: 'auto'});
}

function render() {
  renderChrome();
  if (!ui.authenticated) return;
  const context = captureRenderContext();
  ui.fieldRefs.clear();
  if (ui.loading && !ui.state) {
    dom.viewRoot.replaceChildren(renderLoading());
  } else if (!ui.state) {
    dom.viewRoot.replaceChildren(renderLoadError());
  } else {
    dom.viewRoot.replaceChildren(renderActiveView());
  }
  restoreRenderContext(context);
  renderChrome();
}

function renderLoading() {
  const page = makeNode('div', 'page');
  const state = makeNode('section', 'loading-state');
  const orb = makeNode('div', 'orb orb--loading');
  orb.setAttribute('aria-hidden', 'true');
  append(state, orb, makeNode('p', 'eyebrow', 'Orbit / Live state'), makeNode('h1', '', 'Reading the relay…'), makeNode('p', '', 'Nothing is shown until the local relay confirms it.'));
  page.append(state);
  return page;
}

function renderLoadError() {
  const page = makeNode('div', 'page');
  const error = makeNode('section', 'loading-state loading-state--error');
  const icon = makeNode('div', 'empty-state-icon');
  icon.append(makeIcon('cloud'));
  const button = makeButton('Try again', 'button button--primary', 'refresh');
  button.addEventListener('click', () => loadState());
  append(error, icon, makeNode('p', 'eyebrow', 'Orbit / Live state'), makeNode('h1', '', 'The relay is not answering.'), makeNode('p', '', 'No local values are being invented here. Retry when the relay is reachable.'), button);
  page.append(error);
  return page;
}

function renderActiveView() {
  if (ui.activeView === 'agent') return renderAgent();
  if (ui.activeView === 'memory') return renderMemory();
  if (ui.activeView === 'connections') return renderConnections();
  return renderOverview();
}

function renderOverview() {
  const page = makeNode('div', 'page page--overview');
  const refreshAction = makeButton('Refresh state', 'button button--subtle', 'refresh');
  refreshAction.addEventListener('click', () => loadState());
  page.append(makePageHeading('Overview', 'Orbit, at a glance.', 'Live relay state, saved configuration, and the edges of this firmware build.', refreshAction));

  const state = connectionState();
  const hero = makeNode('section', `panel overview-hero overview-hero--${state.tone}`);
  const visual = makeNode('div', 'overview-hero-visual');
  const orb = makeNode('div', `orb orb--hero orb--${state.tone}`);
  orb.setAttribute('aria-hidden', 'true');
  orb.append(makeNode('span', 'orb-glint'));
  visual.append(orb, makeNode('span', 'orb-caption', 'ORBIT / RELAY'));
  const heroCopy = makeNode('div', 'overview-hero-copy');
  const heroMeta = makeNode('div', 'hero-meta');
  heroMeta.append(makeStatusPill(state.label, state.tone));
  heroMeta.append(makeNode('span', 'hero-meta-label', 'Live status'));
  const heroDescription = makeNode('p', 'hero-description');
  if (ui.state.snapshot.updatedAt !== undefined && ui.state.snapshot.updatedAt !== null) {
    append(heroDescription, document.createTextNode('Last seen '), makeTime(ui.state.snapshot.updatedAt, 'inline-time'), document.createTextNode('.'));
  } else {
    heroDescription.textContent = 'The relay did not report a last-seen timestamp.';
  }
  append(heroCopy, heroMeta, makeNode('h2', '', state.title), heroDescription);
  hero.append(visual, heroCopy);
  page.append(hero);

  const metrics = makeNode('section', 'metric-grid', '');
  metrics.append(
    makeMetricCard('Relay status', state.label, 'From the latest snapshot', state.tone),
    makeMetricCard('Last seen', formatDateTime(ui.state.snapshot.updatedAt), 'Relay timestamp', ui.state.snapshot.updatedAt ? 'good' : 'quiet'),
    makeMetricCard('Applied revision', ui.state.snapshot.updatedAt ? revisionText(ui.state.snapshot.appliedRevision) : 'Not synced', `Config ${revisionText(ui.state.config.revision)}`, ui.state.snapshot.updatedAt ? 'good' : 'quiet'),
  );
  page.append(metrics);

  const syncPanel = makeNode('section', 'panel sync-panel');
  const syncIcon = makeNode('div', 'panel-icon panel-icon--blue');
  syncIcon.append(makeIcon('cloud'));
  const syncCopy = makeNode('div', 'sync-panel-copy');
  append(syncCopy, makeEyebrow('Cloud sync'), makeNode('h2', '', ui.state.snapshot.updatedAt ? `Applied ${revisionText(ui.state.snapshot.appliedRevision)}` : 'Waiting for first sync'), makeNode('p', '', 'State refreshes every 30 seconds while this tab is visible. A saved configuration is only marked applied when the relay reports the matching revision in a snapshot.'));
  const syncRevisions = makeNode('div', 'sync-revisions');
  syncRevisions.append(makeNode('span', 'revision-label', 'Saved config'), makeNode('strong', '', revisionText(ui.state.config.revision)), makeNode('span', 'revision-label', 'Relay applied'), makeNode('strong', '', revisionText(ui.state.snapshot.appliedRevision)));
  syncPanel.append(syncIcon, syncCopy, syncRevisions);
  page.append(syncPanel);

  const insightGrid = makeNode('div', 'insight-grid');
  const inventory = makeNode('section', 'panel inventory-panel');
  inventory.append(makePanelHeader('Live inventory', 'What the relay returned', 'These are bounded lists from the latest snapshot, not a claim about the full archive.'));
  const inventoryRows = makeNode('div', 'inventory-rows');
  const memories = ui.state.snapshot.memories;
  const notes = ui.state.snapshot.notes;
  const connectors = ui.state.snapshot.connectors;
  inventoryRows.append(
    makeInventoryRow('Memories · latest 100', memories === null ? 'Unavailable' : String(memories.length), 'returned by relay', 'memory'),
    makeInventoryRow('Notes · latest 10', notes === null ? 'Unavailable' : String(notes.length), 'returned by relay', 'pin'),
    makeInventoryRow('Connector signals', connectors === null ? 'Unavailable' : String(connectors.length), 'reported in snapshot', 'link'),
  );
  inventory.append(inventoryRows);

  const firmware = makeNode('section', 'panel firmware-panel');
  const firmwareIcon = makeNode('div', 'panel-icon panel-icon--ink');
  firmwareIcon.append(makeIcon('info'));
  const firmwareCopy = makeNode('div', 'firmware-copy');
  append(firmwareCopy, makeEyebrow('Hardware limitation'), makeNode('h2', '', 'Bluetooth headphone audio is not available'), makeNode('p', '', 'The ESP32-S3 supports Bluetooth Low Energy, but not Bluetooth Classic or LE Audio. Headphones need a separate audio adapter or a Mac/phone audio path.'));
  firmware.append(firmwareIcon, firmwareCopy);
  insightGrid.append(inventory, firmware);
  page.append(insightGrid);

  const connectorPanel = renderConnectorSignals();
  page.append(connectorPanel);
  return page;
}

function makeInventoryRow(label, value, description, iconName) {
  const row = makeNode('div', 'inventory-row');
  const icon = makeNode('div', 'inventory-icon');
  icon.append(makeIcon(iconName));
  const copy = makeNode('div', 'inventory-copy');
  append(copy, makeNode('strong', '', label), makeNode('span', '', description));
  append(row, icon, copy, makeNode('b', 'inventory-value', value));
  return row;
}

function renderConnectorSignals() {
  const panel = makeNode('section', 'panel connector-signals');
  panel.append(makePanelHeader('Connections', 'Latest connector signals', 'Status and discovery metadata reported by the relay.'));
  const list = makeNode('div', 'signal-list');
  const signals = ui.state.snapshot.connectors;
  if (signals === null) {
    list.append(makeEmptyState('Signal data unavailable', 'The latest snapshot did not include connector status.', 'link'));
  } else if (!signals.length) {
    list.append(makeEmptyState('No connector signals yet', 'Configure a connection and test it to request live metadata.', 'link'));
  } else {
    signals.forEach((signal) => {
      const configured = Array.isArray(ui.state.config.connectors)
        ? ui.state.config.connectors.find((connector) => connector.id === signal.id)
        : null;
      const row = makeNode('div', 'signal-row');
      const copy = makeNode('div', 'signal-copy');
      append(copy, makeNode('strong', '', configured?.name || signal.id), makeNode('span', '', `${signal.tools === null ? 'Tool metadata not reported' : `${signal.tools.length} tool${signal.tools.length === 1 ? '' : 's'} discovered`}`));
      append(row, copy, makeStatusPill(statusLabel(signal.status), statusTone(signal.status)));
      list.append(row);
    });
  }
  panel.append(list);
  return panel;
}

function renderAgent() {
  const page = makeNode('div', 'page');
  const revision = makeNode('div', 'revision-lockup');
  revision.append(makeNode('span', 'revision-label', 'Current revision'), makeNode('strong', '', revisionText(ui.state.config.revision)), makeNode('span', 'revision-label', `Relay applied ${revisionText(ui.state.snapshot.appliedRevision)}`));
  page.append(makePageHeading('Agent', 'Give Orbit a steady voice.', 'Set the owner prompt and the city Orbit uses when a weather request needs a default.', revision));

  const form = makeNode('form', 'panel config-form');
  form.id = 'agent-form';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    saveConfig();
  });
  form.append(makePanelHeader('Voice instructions', 'Owner prompt', 'These instructions shape how Orbit responds. Keep credentials and secrets out of the prompt.'));

  const promptLabel = makeNode('label', 'field-label', 'Prompt');
  promptLabel.htmlFor = 'agent-prompt';
  const prompt = registerField(makeNode('textarea', 'text-area'), 'agent.prompt');
  prompt.id = 'agent-prompt';
  prompt.name = 'prompt';
  prompt.maxLength = MAX_PROMPT_LENGTH;
  prompt.rows = 10;
  prompt.placeholder = 'Add the preferences Orbit should follow…';
  prompt.value = ui.draft.prompt;
  prompt.setAttribute('aria-describedby', 'prompt-help prompt-count');
  prompt.addEventListener('input', () => {
    ui.draft.prompt = prompt.value;
    ui.dirty.agent = true;
    promptCount.textContent = `${prompt.value.length.toLocaleString()} / ${MAX_PROMPT_LENGTH.toLocaleString()}`;
    renderChrome();
  });
  const promptMeta = makeNode('div', 'field-meta');
  const promptHelp = makeNode('span', 'field-help', 'Up to 6,000 characters. Saved with the next configuration revision.');
  promptHelp.id = 'prompt-help';
  const promptCount = makeNode('span', 'character-count', `${prompt.value.length.toLocaleString()} / ${MAX_PROMPT_LENGTH.toLocaleString()}`);
  promptCount.id = 'prompt-count';
  append(promptMeta, promptHelp, promptCount);
  append(form, promptLabel, prompt, promptMeta);

  const divider = makeNode('div', 'form-divider');
  form.append(divider);
  const cityGrid = makeNode('div', 'field-grid field-grid--city');
  const cityField = makeNode('div', 'field');
  const cityLabel = makeNode('label', 'field-label', 'Default weather city');
  cityLabel.htmlFor = 'weather-city';
  const city = registerField(makeNode('input', 'text-input'), 'agent.weatherCity');
  city.id = 'weather-city';
  city.name = 'weatherCity';
  city.type = 'text';
  city.maxLength = MAX_CITY_LENGTH;
  city.autocomplete = 'address-level2';
  city.value = ui.draft.weatherCity;
  city.placeholder = 'City used for weather requests';
  city.addEventListener('input', () => {
    ui.draft.weatherCity = city.value;
    ui.dirty.agent = true;
    renderChrome();
  });
  append(cityField, cityLabel, city);
  const cityNote = makeNode('div', 'field-callout');
  cityNote.append(makeIcon('cloud'), makeNode('span', '', 'Used when you ask for weather without naming a city.'));
  cityGrid.append(cityField, cityNote);
  form.append(cityGrid);

  const footer = makeNode('div', 'form-footer');
  const save = makeButton('Save configuration', 'button button--primary', null, 'submit');
  save.dataset.saveButton = 'true';
  save.querySelector('span').dataset.saveLabel = 'true';
  const saveStatusLabel = makeNode('span', 'save-status', saveStatus().label);
  saveStatusLabel.dataset.saveStatus = 'true';
  append(footer, save, saveStatusLabel);
  form.append(footer);
  page.append(form);
  return page;
}

function makeAuthFieldset(idPrefix, connector) {
  const fieldset = makeNode('fieldset', 'auth-fieldset');
  const legend = makeNode('legend', 'field-label', 'Authentication');
  fieldset.append(legend);
  const options = makeNode('div', 'auth-options');
  const bearerLabel = makeNode('label', 'auth-option auth-option--selected');
  const bearer = makeNode('input');
  bearer.type = 'radio';
  bearer.name = `${idPrefix}-auth`;
  bearer.checked = true;
  bearer.disabled = true;
  const bearerCopy = makeNode('span', 'auth-option-copy');
  append(bearerCopy, makeNode('strong', '', 'Bearer token'), makeNode('small', '', 'Sent as an Authorization bearer credential.'));
  bearerLabel.append(bearer, bearerCopy);
  const oauthLabel = makeNode('label', 'auth-option auth-option--disabled');
  const oauth = makeNode('input');
  oauth.type = 'radio';
  oauth.name = `${idPrefix}-auth`;
  oauth.disabled = true;
  const oauthCopy = makeNode('span', 'auth-option-copy');
  append(oauthCopy, makeNode('strong', '', 'OAuth'), makeNode('small', '', 'Not available yet'));
  oauthLabel.append(oauth, oauthCopy);
  options.append(bearerLabel, oauthLabel);
  fieldset.append(options);

  const tokenLabel = makeNode('label', 'field-label', connector.hasToken ? 'Bearer token · saved' : 'Bearer token');
  tokenLabel.htmlFor = `${idPrefix}-token`;
  const token = registerField(makeNode('input', 'text-input'), `${connector.id}.token`);
  token.id = `${idPrefix}-token`;
  token.type = 'password';
  token.autocomplete = 'new-password';
  token.maxLength = MAX_TOKEN_LENGTH;
  token.placeholder = connector.hasToken ? 'Leave blank to keep the saved token' : 'Paste a bearer token';
  token.spellcheck = false;
  token.value = connector.tokenDraft || '';
  token.addEventListener('input', () => {
    connector.tokenDraft = token.value;
    ui.dirty.connectors = true;
    renderChrome();
  });
  const help = makeNode('p', 'field-help', connector.hasToken ? 'A blank field keeps the saved token. Enter a new value to rotate it.' : 'The token is sent only when you save this connection.');
  fieldset.append(tokenLabel, token, help);
  if (connector.hasToken) {
    const clear = makeNode('label', 'switch-control');
    const checkbox = makeNode('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(connector.clearToken);
    checkbox.addEventListener('change', () => {
      connector.clearToken = checkbox.checked;
      token.disabled = checkbox.checked;
      ui.dirty.connectors = true;
      renderChrome();
    });
    token.disabled = checkbox.checked;
    clear.append(checkbox, makeNode('span', '', 'Remove saved token on next save'));
    fieldset.append(clear);
  }
  return fieldset;
}

function makeToolRow(connector, tool, inputKey) {
  const row = makeNode('label', `tool-row${tool.readOnly ? '' : ' tool-row--blocked'}`);
  const checkbox = makeNode('input');
  checkbox.type = 'checkbox';
  checkbox.checked = connector.allowedTools.includes(tool.name);
  checkbox.disabled = !tool.readOnly;
  checkbox.setAttribute('aria-label', `${tool.name}, ${tool.readOnly ? 'read-only' : 'not read-only'}`);
  if (tool.readOnly) {
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        if (!connector.allowedTools.includes(tool.name)) connector.allowedTools.push(tool.name);
      } else {
        connector.allowedTools = connector.allowedTools.filter((name) => name !== tool.name);
      }
      ui.dirty.connectors = true;
      renderChrome();
    });
  }
  const copy = makeNode('span', 'tool-copy');
  append(copy, makeNode('strong', '', tool.name), makeNode('span', '', tool.description || 'No description reported.'));
  const badge = makeNode('span', `tool-badge tool-badge--${tool.readOnly ? 'readonly' : 'blocked'}`, tool.readOnly ? 'Read-only' : 'Write-capable · blocked');
  row.append(checkbox, copy, badge);
  row.dataset.toolKey = inputKey;
  return row;
}

function makeSavedOnlyToolRow(name) {
  const row = makeNode('div', 'tool-row tool-row--saved-only');
  const checkbox = makeNode('input');
  checkbox.type = 'checkbox';
  checkbox.checked = true;
  checkbox.disabled = true;
  checkbox.setAttribute('aria-label', `${name}, saved approval with no discovery metadata`);
  const copy = makeNode('span', 'tool-copy');
  append(copy, makeNode('strong', '', name), makeNode('span', '', 'Saved approval; metadata was not reported in the latest discovery.'));
  row.append(checkbox, copy, makeNode('span', 'tool-badge tool-badge--saved', 'Saved · metadata missing'));
  return row;
}

function renderTools(connector) {
  const wrapper = makeNode('div', 'tools-section');
  const snapshot = snapshotConnector(connector.id);
  const tools = snapshot?.tools;
  const header = makeNode('div', 'tools-heading');
  const copy = makeNode('div');
  append(copy, makeNode('h4', '', 'Approved read-only tools'), makeNode('p', '', 'Only tools confirmed as read-only can be approved.'));
  const knownCount = tools === null || !tools ? 'Not discovered' : `${tools.length} discovered`;
  header.append(copy, makeNode('span', 'tool-count', knownCount));
  wrapper.append(header);
  const list = makeNode('div', 'tool-list');
  if (!snapshot || tools === null || !tools) {
    list.append(makeEmptyState('No discovery metadata yet', 'Save the connection, then test it to request the server’s tool list.', 'link'));
  } else if (!tools.length && !connector.allowedTools.length) {
    list.append(makeEmptyState('No tools reported', 'The latest test returned no tools for this connection.', 'link'));
  } else {
    const discoveredNames = new Set(tools.map((tool) => tool.name));
    tools.forEach((tool, index) => list.append(makeToolRow(connector, tool, `${connector.id}.tool.${index}`)));
    connector.allowedTools.filter((name) => !discoveredNames.has(name)).forEach((name) => list.append(makeSavedOnlyToolRow(name)));
  }
  wrapper.append(list);
  return wrapper;
}

function renderConnectorCard(connector, index) {
  const card = makeNode('article', 'panel connector-card');
  const cardHeader = makeNode('div', 'connector-card-header');
  const titleCopy = makeNode('div', 'connector-title-copy');
  const title = connector.name.trim() || 'Unnamed connection';
  append(titleCopy, makeNode('p', 'eyebrow', 'MCP connection'), makeNode('h3', '', title), makeNode('span', 'connector-url', connector.url || 'URL not set'));
  const statusStack = makeNode('div', 'connector-status-stack');
  statusStack.append(makeStatusPill(connector.enabled ? 'Enabled' : 'Disabled', connector.enabled ? 'good' : 'quiet'));
  const liveStatus = connectorStatus(connector.id);
  statusStack.append(makeStatusPill(liveStatus.label, liveStatus.tone));
  cardHeader.append(titleCopy, statusStack);
  card.append(cardHeader);

  const fields = makeNode('div', 'field-grid');
  const nameField = makeNode('div', 'field');
  const nameLabel = makeNode('label', 'field-label', 'Name');
  nameLabel.htmlFor = `connector-${index}-name`;
  const nameInput = registerField(makeNode('input', 'text-input'), `${connector.id}.name`);
  nameInput.id = `connector-${index}-name`;
  nameInput.type = 'text';
  nameInput.required = true;
  nameInput.maxLength = MAX_CONNECTOR_NAME_LENGTH;
  nameInput.value = connector.name;
  nameInput.addEventListener('input', () => {
    connector.name = nameInput.value;
    ui.dirty.connectors = true;
    renderChrome();
  });
  append(nameField, nameLabel, nameInput);
  const urlField = makeNode('div', 'field');
  const urlLabel = makeNode('label', 'field-label', 'HTTPS endpoint');
  urlLabel.htmlFor = `connector-${index}-url`;
  const urlInput = registerField(makeNode('input', 'text-input'), `${connector.id}.url`);
  urlInput.id = `connector-${index}-url`;
  urlInput.type = 'url';
  urlInput.required = true;
  urlInput.inputMode = 'url';
  urlInput.placeholder = 'https://…';
  urlInput.value = connector.url;
  urlInput.addEventListener('input', () => {
    connector.url = urlInput.value;
    ui.dirty.connectors = true;
    renderChrome();
  });
  append(urlField, urlLabel, urlInput);
  fields.append(nameField, urlField);
  card.append(fields);

  const switchRow = makeNode('div', 'connector-settings-row');
  const switchCopy = makeNode('div');
  append(switchCopy, makeNode('strong', '', 'Connection enabled'), makeNode('span', '', 'Orbit will use this server only when enabled.'));
  const switchLabel = makeNode('label', 'switch-control');
  const toggle = makeNode('input');
  toggle.type = 'checkbox';
  toggle.checked = connector.enabled;
  toggle.id = `connector-${index}-enabled`;
  toggle.setAttribute('aria-label', `Enable ${title}`);
  const toggleTrack = makeNode('span', 'switch-track');
  toggleTrack.setAttribute('aria-hidden', 'true');
  toggle.addEventListener('change', () => {
    connector.enabled = toggle.checked;
    ui.dirty.connectors = true;
    const pills = card.querySelectorAll('.connector-status-stack .status-pill');
    if (pills[0]) pills[0].replaceWith(makeStatusPill(toggle.checked ? 'Enabled' : 'Disabled', toggle.checked ? 'good' : 'quiet'));
    renderChrome();
  });
  switchLabel.append(toggle, toggleTrack);
  switchRow.append(switchCopy, switchLabel);
  card.append(switchRow);
  card.append(makeAuthFieldset(`connector-${index}`, connector));
  card.append(renderTools(connector));

  const footer = makeNode('div', 'connector-card-footer');
  const save = makeButton('Save configuration', 'button button--primary', null);
  save.dataset.saveButton = 'true';
  save.querySelector('span').dataset.saveLabel = 'true';
  save.addEventListener('click', () => saveConfig());
  const test = makeButton('Test connection', 'button button--subtle', 'link');
  test.addEventListener('click', () => testConnector(connector));
  const status = makeNode('span', 'save-status', saveStatus().label);
  status.dataset.saveStatus = 'true';
  const remove = makeButton('Remove', 'button button--subtle', 'trash');
  remove.addEventListener('click', () => {
    ui.draft.connectors = ui.draft.connectors.filter((item) => item.id !== connector.id);
    ui.dirty.connectors = true;
    render();
    showNotice('warning', 'Connection removed from your draft. Save configuration to apply.');
  });
  footer.append(save, test, remove, status);
  card.append(footer);
  return card;
}

function renderConnections() {
  const page = makeNode('div', 'page');
  page.append(makePageHeading('Connections', 'Keep the boundary clear.', 'Connect trusted MCP servers over HTTPS, then approve only the read-only tools Orbit may see.'));

  const add = makeNode('form', 'panel add-connector-panel');
  add.id = 'add-connector-form';
  add.append(makePanelHeader('New connection', 'Add an MCP server', 'Credentials stay blank after a successful save. OAuth is not available yet.'));
  const addFields = makeNode('div', 'field-grid');
  const addNameField = makeNode('div', 'field');
  const addNameLabel = makeNode('label', 'field-label', 'Name');
  addNameLabel.htmlFor = 'new-connector-name';
  const addName = registerField(makeNode('input', 'text-input'), 'add.name');
  addName.id = 'new-connector-name';
  addName.type = 'text';
  addName.required = true;
  addName.maxLength = MAX_CONNECTOR_NAME_LENGTH;
  addName.placeholder = 'e.g. Research tools';
  addName.value = ui.newConnector.name;
  addName.addEventListener('input', () => { ui.newConnector.name = addName.value; });
  append(addNameField, addNameLabel, addName);
  const addUrlField = makeNode('div', 'field');
  const addUrlLabel = makeNode('label', 'field-label', 'HTTPS endpoint');
  addUrlLabel.htmlFor = 'new-connector-url';
  const addUrl = registerField(makeNode('input', 'text-input'), 'add.url');
  addUrl.id = 'new-connector-url';
  addUrl.type = 'url';
  addUrl.required = true;
  addUrl.inputMode = 'url';
  addUrl.placeholder = 'https://server.example/mcp';
  addUrl.value = ui.newConnector.url;
  addUrl.addEventListener('input', () => { ui.newConnector.url = addUrl.value; });
  append(addUrlField, addUrlLabel, addUrl);
  addFields.append(addNameField, addUrlField);
  add.append(addFields);
  const addAuth = makeNode('div', 'add-auth-block');
  const addAuthFieldset = makeAuthFieldset('new-connector', ui.newConnector);
  addAuth.append(addAuthFieldset);
  add.append(addAuth);
  const addFooter = makeNode('div', 'form-footer');
  const addButton = makeButton('Add connection', 'button button--primary', 'plus', 'submit');
  const addMessage = makeNode('p', 'form-message');
  addMessage.id = 'add-connector-message';
  addFooter.append(addButton, addMessage);
  add.append(addFooter);
  add.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = addName.value.trim();
    const url = addUrl.value.trim();
    const token = add.querySelector('#new-connector-token')?.value || '';
    addMessage.textContent = '';
    if (!name) {
      addMessage.textContent = 'Add a name for this connection.';
      addMessage.className = 'form-message form-message--error';
      addName.focus();
      return;
    }
    if (!isHttpsUrl(url)) {
      addMessage.textContent = 'Use an HTTPS endpoint without credentials in the URL.';
      addMessage.className = 'form-message form-message--error';
      addUrl.focus();
      return;
    }
    if (token.length > MAX_TOKEN_LENGTH) {
      addMessage.textContent = `The bearer token must be ${MAX_TOKEN_LENGTH.toLocaleString()} characters or fewer.`;
      addMessage.className = 'form-message form-message--error';
      add.querySelector('#new-connector-token')?.focus();
      return;
    }
    if (!ui.draft || !Array.isArray(ui.draft.connectors)) return;
    ui.draft.connectors.push({
      id: crypto.randomUUID(),
      name,
      url,
      enabled: true,
      allowedTools: [],
      hasToken: Boolean(token),
      tokenDraft: token,
    });
    ui.dirty.connectors = true;
    add.reset();
    ui.newConnector = {id: 'new', hasToken: false, name: '', url: '', tokenDraft: ''};
    addMessage.textContent = 'Connection added to this draft. Save to send it to the relay.';
    addMessage.className = 'form-message form-message--success';
    render();
  });
  page.append(add);

  const listSection = makeNode('section', 'connection-list-section');
  const listHeader = makeNode('div', 'section-heading');
  const listCopy = makeNode('div');
  append(listCopy, makeEyebrow('Configured connections'), makeNode('h2', '', 'Trusted servers'), makeNode('p', 'section-description', `${ui.draft.connectors.length} configured connection${ui.draft.connectors.length === 1 ? '' : 's'} in this draft.`));
  listHeader.append(listCopy);
  listSection.append(listHeader);
  if (!ui.draft.connectors.length) {
    listSection.append(makeEmptyState('No connections configured', 'Add an HTTPS MCP server above. It will not be sent until you save the configuration.', 'link'));
  } else {
    const cards = makeNode('div', 'connector-card-list');
    ui.draft.connectors.forEach((connector, index) => cards.append(renderConnectorCard(connector, index)));
    listSection.append(cards);
  }
  const globalSave = makeNode('div', 'global-save-row');
  const globalSaveButton = makeButton('Save configuration', 'button button--primary', null);
  globalSaveButton.dataset.saveButton = 'true';
  globalSaveButton.querySelector('span').dataset.saveLabel = 'true';
  globalSaveButton.addEventListener('click', () => saveConfig());
  const globalSaveStatus = makeNode('span', 'save-status', saveStatus().label);
  globalSaveStatus.dataset.saveStatus = 'true';
  globalSave.append(globalSaveButton, globalSaveStatus);
  listSection.append(globalSave);
  page.append(listSection);
  return page;
}

function renderMemory() {
  const page = makeNode('div', 'page');
  page.append(makePageHeading('Memory', 'Keep the useful things.', 'Add explicit facts for Orbit to remember. Read and delete the latest notes without pretending the relay returned an entire archive.'));

  const queueSummary = renderQueueSummary();
  if (queueSummary) page.append(queueSummary);

  const layout = makeNode('div', 'memory-layout');
  const addPanel = makeNode('section', 'panel memory-add-panel');
  addPanel.append(makePanelHeader('New fact', 'Add something to remember', 'The relay only stores facts you explicitly add. Never put passwords, API keys, or tokens here.'));
  const form = makeNode('form', 'memory-form');
  const label = makeNode('label', 'field-label', 'Fact');
  label.htmlFor = 'memory-fact';
  const fact = registerField(makeNode('textarea', 'text-area'), 'memory.fact');
  fact.id = 'memory-fact';
  fact.maxLength = MAX_FACT_LENGTH;
  fact.rows = 5;
  fact.placeholder = 'e.g. I prefer short answers';
  fact.value = ui.memoryFact;
  fact.setAttribute('aria-describedby', 'memory-fact-help memory-fact-count');
  const factMeta = makeNode('div', 'field-meta');
  const factHelp = makeNode('span', 'field-help', 'Queued actions remain visible until a state snapshot acknowledges them.');
  factHelp.id = 'memory-fact-help';
  const factCount = makeNode('span', 'character-count', `${ui.memoryFact.length} / ${MAX_FACT_LENGTH}`);
  factCount.id = 'memory-fact-count';
  fact.addEventListener('input', () => {
    ui.memoryFact = fact.value;
    factCount.textContent = `${fact.value.length} / ${MAX_FACT_LENGTH}`;
  });
  append(factMeta, factHelp, factCount);
  const submit = makeButton('Queue fact', 'button button--primary', 'arrow', 'submit');
  submit.disabled = ui.memorySubmitting;
  const formMessage = makeNode('p', 'form-message');
  formMessage.id = 'memory-form-message';
  form.append(label, fact, factMeta, submit, formMessage);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (ui.memorySubmitting) return;
    const value = fact.value.trim();
    formMessage.textContent = '';
    formMessage.className = 'form-message';
    if (!value) {
      formMessage.textContent = 'Write a fact before queuing it.';
      formMessage.className = 'form-message form-message--error';
      fact.focus();
      return;
    }
    ui.memorySubmitting = true;
    submit.disabled = true;
    const accepted = await queueCommand('remember', {fact: value}, {detail: value});
    ui.memorySubmitting = false;
    if (accepted) {
      ui.memoryFact = '';
      fact.value = '';
      factCount.textContent = `0 / ${MAX_FACT_LENGTH}`;
      formMessage.textContent = 'Fact queued. It will appear after the relay acknowledges it in a snapshot.';
      formMessage.className = 'form-message form-message--success';
    }
    render();
  });
  addPanel.append(form);
  layout.append(addPanel);

  const records = makeNode('div', 'memory-records');
  records.append(renderMemoriesPanel(), renderNotesPanel());
  layout.append(records);
  page.append(layout);
  const actions = renderRecentActions(['remember', 'forget', 'delete_note']);
  if (actions) page.append(actions);
  return page;
}

function renderQueueSummary() {
  const commands = ui.state.commands;
  if (!Array.isArray(commands) || !commands.length) return null;
  const panel = makeNode('section', 'queue-summary');
  const icon = makeNode('div', 'queue-summary-icon');
  icon.append(makeIcon('refresh'));
  const copy = makeNode('div');
  append(copy, makeNode('strong', '', `${commands.length} relay command${commands.length === 1 ? '' : 's'} queued`), makeNode('span', '', 'Execution is confirmed only when a command result appears in a state snapshot.'));
  panel.append(icon, copy);
  return panel;
}

function renderMemoriesPanel() {
  const panel = makeNode('section', 'panel record-panel');
  const header = makePanelHeader('Saved facts', 'Memory', 'Latest 100 returned by the relay.');
  const memories = ui.state.snapshot.memories;
  const count = makeNode('span', 'record-count', memories === null ? 'Unavailable' : `${memories.length} returned`);
  header.append(count);
  panel.append(header);
  const list = makeNode('div', 'record-list');
  if (memories === null) {
    list.append(makeEmptyState('Memory data unavailable', 'The latest snapshot did not include memories.', 'memory'));
  } else if (!memories.length) {
    list.append(makeEmptyState('No saved facts', 'Facts you explicitly add will appear here after relay confirmation.', 'memory'));
  } else {
    memories.forEach((memory) => list.append(renderMemoryRow(memory)));
  }
  panel.append(list);
  return panel;
}

function renderMemoryRow(memory) {
  const row = makeNode('article', 'record-row');
  const copy = makeNode('div', 'record-copy');
  const meta = makeNode('div', 'record-meta');
  meta.append(makeNode('span', 'record-id', `Memory #${memory.id}`));
  copy.append(meta, makeNode('p', '', memory.fact));
  const action = makeNode('div', 'record-action');
  const command = latestCommand('forget', memory.id);
  if (command) action.append(makeCommandState(command));
  const button = makeButton(command?.status === 'failed' ? 'Retry' : 'Forget', 'button button--danger-ghost', command?.status === 'failed' ? 'refresh' : 'trash');
  button.disabled = command && (command.status === 'pending' || command.status === 'applied');
  button.setAttribute('aria-label', `${command?.status === 'failed' ? 'Retry forgetting' : 'Forget'} memory ${memory.id}`);
  button.addEventListener('click', () => forgetMemory(memory.id));
  action.append(button);
  row.append(copy, action);
  if (command?.status === 'pending') row.classList.add('record-row--pending');
  return row;
}

function renderNotesPanel() {
  const panel = makeNode('section', 'panel record-panel');
  const header = makePanelHeader('Voice notes', 'Notes', 'Latest 10 returned by the relay.');
  const notes = ui.state.snapshot.notes;
  header.append(makeNode('span', 'record-count', notes === null ? 'Unavailable' : `${notes.length} returned`));
  panel.append(header);
  const list = makeNode('div', 'record-list');
  if (notes === null) {
    list.append(makeEmptyState('Notes data unavailable', 'The latest snapshot did not include notes.', 'pin'));
  } else if (!notes.length) {
    list.append(makeEmptyState('No voice notes', 'Dictated notes will appear here after the relay saves them.', 'pin'));
  } else {
    notes.forEach((note) => list.append(renderNoteRow(note)));
  }
  panel.append(list);
  return panel;
}

function renderNoteRow(note) {
  const row = makeNode('article', 'record-row');
  const copy = makeNode('div', 'record-copy');
  const meta = makeNode('div', 'record-meta');
  meta.append(makeNode('span', 'record-id', `Note #${note.id}`), makeTime(note.created_at));
  copy.append(meta, makeNode('p', '', note.text));
  const action = makeNode('div', 'record-action');
  const command = latestCommand('delete_note', note.id);
  if (command) action.append(makeCommandState(command));
  const button = makeButton(command?.status === 'failed' ? 'Retry' : 'Delete', 'button button--danger-ghost', command?.status === 'failed' ? 'refresh' : 'trash');
  button.disabled = command && (command.status === 'pending' || command.status === 'applied');
  button.setAttribute('aria-label', `${command?.status === 'failed' ? 'Retry deleting' : 'Delete'} note ${note.id}`);
  button.addEventListener('click', () => deleteNote(note.id));
  action.append(button);
  row.append(copy, action);
  if (command?.status === 'pending') row.classList.add('record-row--pending');
  return row;
}

function latestCommand(kind, targetId = null) {
  return [...ui.commands.values()]
    .filter((command) => command.kind === kind && (targetId === null || String(command.targetId) === String(targetId)))
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}

function makeCommandState(command) {
  const text = command.status === 'pending'
    ? 'Queued · waiting for snapshot'
    : command.status === 'applied'
      ? 'Applied · snapshot acknowledged'
      : `Not applied · ${command.error || 'relay rejected the action'}`;
  return makeNode('span', `command-state command-state--${command.status}`, text);
}

function renderRecentActions(kinds) {
  const actions = [...ui.commands.values()]
    .filter((command) => kinds.includes(command.kind))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 6);
  if (!actions.length) return null;
  const panel = makeNode('section', 'panel recent-actions');
  panel.append(makePanelHeader('Command history', 'Recent console actions', 'Queued actions are not treated as executed until the relay acknowledges them in a snapshot.'));
  const list = makeNode('div', 'action-list');
  actions.forEach((command) => {
    const row = makeNode('div', 'action-row');
    const copy = makeNode('div', 'action-copy');
    const label = command.kind === 'remember' ? 'Remember fact' : command.kind === 'forget' ? `Forget memory #${command.targetId}` : `Delete note #${command.targetId}`;
    append(copy, makeNode('strong', '', label), command.detail ? makeNode('span', '', command.detail) : null);
    row.append(copy, makeCommandState(command));
    list.append(row);
  });
  panel.append(list);
  return panel;
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validateDraft() {
  if (!ui.state || !ui.draft) return {message: 'Live state is not ready yet.'};
  if (ui.draft.prompt.length > MAX_PROMPT_LENGTH) return {message: `The prompt must be ${MAX_PROMPT_LENGTH.toLocaleString()} characters or fewer.`, focusKey: 'agent.prompt'};
  if (ui.draft.weatherCity.length > MAX_CITY_LENGTH) return {message: `The weather city must be ${MAX_CITY_LENGTH} characters or fewer.`, focusKey: 'agent.weatherCity'};
  const seen = new Set();
  for (const connector of ui.draft.connectors) {
    if (!connector.id || seen.has(connector.id)) return {message: 'Every connection needs a unique id. Reload the live state and try again.'};
    seen.add(connector.id);
    if (!connector.name.trim()) return {message: 'Every connection needs a name.', focusKey: `${connector.id}.name`};
    if (connector.name.trim().length > MAX_CONNECTOR_NAME_LENGTH) return {message: `Connection names must be ${MAX_CONNECTOR_NAME_LENGTH} characters or fewer.`, focusKey: `${connector.id}.name`};
    if (!isHttpsUrl(connector.url.trim())) return {message: 'Every connection must use an HTTPS endpoint without URL credentials.', focusKey: `${connector.id}.url`};
    if (typeof connector.tokenDraft === 'string' && connector.tokenDraft.length > MAX_TOKEN_LENGTH) return {message: `Bearer tokens must be ${MAX_TOKEN_LENGTH.toLocaleString()} characters or fewer.`, focusKey: `${connector.id}.token`};
    const discovered = snapshotConnector(connector.id)?.tools;
    const writeTool = Array.isArray(discovered) && connector.allowedTools.find((name) => discovered.some((tool) => tool.name === name && !tool.readOnly));
    if (writeTool) return {message: `“${writeTool}” is not read-only and cannot be approved.`, focusKey: `${connector.id}.tool.0`};
  }
  return null;
}

async function saveConfig() {
  if (ui.saving || !ui.state || !ui.draft) return false;
  const validation = validateDraft();
  if (validation) {
    showNotice('error', validation.message);
    const focus = validation.focusKey ? ui.fieldRefs.get(validation.focusKey) : null;
    if (focus) focus.focus();
    return false;
  }
  const payload = savePayloadFromDraft();
  ui.saving = true;
  renderChrome();
  try {
    const response = await requestJSON('/api/config', {method: 'PUT', body: payload});
    const responseConfig = isObject(response?.config) ? normalizeConfig(response.config) : null;
    const expectedRevision = responseConfig?.revision ?? normalizedRevision(response?.revision);
    ui.configAwaitingState = {payload, expectedRevision};
    ui.dirty.agent = false;
    ui.dirty.connectors = false;
    ui.draft.connectors.forEach((connector) => {
      connector.tokenDraft = '';
      if (connector.clearToken) { connector.hasToken = false; connector.clearToken = false; }
      if (connector.hasToken || payload.connectors.some((saved) => saved.id === connector.id && saved.token)) connector.hasToken = true;
    });
    ui.saving = false;
    render();
    showNotice('success', 'Configuration saved. Waiting for the relay to acknowledge the applied revision.');
    const refreshed = await loadState({silent: true});
    if (!refreshed) showNotice('warning', 'The save was accepted, but the applied revision is not confirmed yet.');
    return true;
  } catch (error) {
    ui.saving = false;
    renderChrome();
    if (error instanceof HttpError && error.status === 401) {
      handleUnauthorized();
      return false;
    }
    if (error instanceof HttpError && error.status === 409) {
      showNotice('warning', 'Another configuration revision exists. The latest server state is loaded, and your draft is still here.', {id: 'config-conflict', persist: true});
      await loadState({silent: true});
      return false;
    }
    showMutationError(error, 'Configuration was not saved. Your draft is still on this page.');
    return false;
  }
}

async function testConnector(connector) {
  const saved = Array.isArray(ui.state?.config.connectors) && ui.state.config.connectors.find((item) => item.id === connector.id);
  const draftChanged = !saved
    || connector.name.trim() !== saved.name
    || connector.url.trim() !== saved.url
    || connector.enabled !== saved.enabled
    || connectorSignature([connector]) !== connectorSignature([saved])
    || Boolean(connector.tokenDraft);
  if (draftChanged || ui.dirty.connectors || ui.configAwaitingState) {
    showNotice('warning', 'Save this connection before testing it.');
    return false;
  }
  return queueCommand('test_connector', {connector_id: connector.id}, {targetId: connector.id, detail: connector.name || connector.id});
}

async function forgetMemory(id) {
  const confirmed = window.confirm('Forget this saved fact? The relay will remove it when the queued action is applied.');
  if (!confirmed) return false;
  const record = ui.state.snapshot.memories.find((item) => String(item.id) === String(id));
  if (!record) return false;
  return queueCommand('forget', {memory_id: Number(id), expected: record.fact}, {targetId: id});
}

async function deleteNote(id) {
  const confirmed = window.confirm('Delete this note? The relay will remove it when the queued action is applied.');
  if (!confirmed) return false;
  const record = ui.state.snapshot.notes.find((item) => String(item.id) === String(id));
  if (!record) return false;
  return queueCommand('delete_note', {note_id: Number(id), expected: record.text}, {targetId: id});
}

async function queueCommand(kind, fields = {}, meta = {}) {
  if (!ui.authenticated) return false;
  const id = crypto.randomUUID();
  const payload = {id, kind, ...fields};
  try {
    await requestJSON('/api/commands', {method: 'POST', body: payload});
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      handleUnauthorized();
      return false;
    }
    showMutationError(error, 'The action was not queued. Nothing was changed.');
    return false;
  }
  ui.commands.set(id, {
    id,
    kind,
    targetId: meta.targetId ?? null,
    detail: typeof meta.detail === 'string' ? meta.detail : '',
    status: 'pending',
    error: '',
    createdAt: Date.now(),
  });
  while (ui.commands.size > 40) {
    const oldest = [...ui.commands.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) break;
    ui.commands.delete(oldest.id);
  }
  showNotice('info', 'Action queued. Waiting for a relay snapshot before calling it applied.', {id: `command-${id}`});
  render();
  watchCommand(id);
  return true;
}

function watchCommand(id) {
  if (ui.commandWatchers.has(id)) return;
  let attempts = 0;
  const poll = async () => {
    ui.commandWatchers.delete(id);
    const command = ui.commands.get(id);
    if (!command || command.status !== 'pending' || !ui.authenticated || document.hidden) return;
    attempts += 1;
    await loadState({silent: true});
    const current = ui.commands.get(id);
    if (current?.status === 'pending' && attempts < COMMAND_POLL_LIMIT && !document.hidden) {
      const timer = window.setTimeout(poll, 1500);
      ui.commandWatchers.set(id, timer);
    }
  };
  const timer = window.setTimeout(poll, 450);
  ui.commandWatchers.set(id, timer);
}

function resumeCommandWatches() {
  [...ui.commands.values()].filter((command) => command.status === 'pending').forEach((command) => watchCommand(command.id));
}

function reconcileCommandResults(results) {
  if (!Array.isArray(results)) return;
  results.forEach((result) => {
    const command = ui.commands.get(result.id);
    if (!command || command.status !== 'pending') return;
    command.status = result.ok ? 'applied' : 'failed';
    command.error = result.error || '';
    if (result.ok) showNotice('success', 'The relay acknowledged the queued action.', {id: `command-${result.id}`});
    else showNotice('error', result.error || 'The relay did not apply the queued action.', {id: `command-${result.id}`, persist: true});
  });
}

async function requestJSON(path, options = {}) {
  const method = options.method || 'GET';
  if (method !== 'GET' && navigator.onLine === false) throw new NetworkError();
  const request = {
    method,
    mode: 'same-origin',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {Accept: 'application/json'},
    signal: options.signal,
  };
  if (options.body !== undefined) {
    request.headers['Content-Type'] = 'application/json';
    request.body = JSON.stringify(options.body);
  }
  // Same-origin mode and the browser-owned Origin header provide the relay's CSRF boundary.
  let response;
  try {
    response = await fetch(path, request);
  } catch {
    throw new NetworkError();
  }
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) throw new HttpError(response.status, body);
  return body;
}

async function loadState({silent = false} = {}) {
  if (!ui.authenticated) return false;
  if (ui.stateRequest) return ui.stateRequest;
  ui.refreshing = true;
  if (!ui.state) ui.loading = true;
  if (!silent) render();
  const request = (async () => {
    try {
      const raw = await requestJSON('/api/state');
      applyState(raw);
      return true;
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        handleUnauthorized();
        return false;
      }
      ui.network = 'offline';
      showNotice('warning', ui.state
        ? 'The relay is unreachable. Showing the last confirmed state; no new state has been assumed.'
        : 'The dashboard is unreachable. Check your connection and retry.', {id: 'offline', persist: true});
      if (!ui.state) render();
      return false;
    } finally {
      ui.refreshing = false;
      ui.loading = false;
      render();
    }
  })();
  ui.stateRequest = request;
  try {
    return await request;
  } finally {
    if (ui.stateRequest === request) ui.stateRequest = null;
  }
}

function applyState(raw) {
  const next = normalizeState(raw);
  const awaiting = ui.configAwaitingState;
  const savedConfigConfirmed = !awaiting || configMatchesPayload(next.config, awaiting.payload);
  ui.state = next;
  ui.network = 'online';
  clearNotice('offline');
  if (!ui.draft) {
    ui.draft = draftFromConfig(next.config);
  } else if (savedConfigConfirmed) {
    if (awaiting) ui.configAwaitingState = null;
    if (!ui.dirty.agent) {
      ui.draft.prompt = next.config.prompt;
      ui.draft.weatherCity = next.config.weatherCity;
    }
    if (!ui.dirty.connectors) ui.draft.connectors = draftFromConfig(next.config).connectors;
  }
  reconcileCommandResults(next.snapshot.commandResults);
  render();
}

function showMutationError(error, fallback) {
  if (error instanceof NetworkError) {
    ui.network = 'offline';
    showNotice('warning', 'The dashboard is unreachable. Your unsaved values remain on this page.', {id: 'offline', persist: true});
    return;
  }
  if (error instanceof HttpError && error.status === 403) {
    showNotice('error', 'The relay rejected this request. Check the local session and connection settings.');
    return;
  }
  showNotice('error', fallback);
}

function showNotice(kind, message, {id = `notice-${Date.now()}-${++ui.noticeSequence}`, persist = false} = {}) {
  clearNotice(id);
  const notice = makeNode('div', `notice notice--${kind}`);
  notice.dataset.noticeId = id;
  const icon = makeNode('span', 'notice-icon');
  icon.append(makeIcon(kind === 'success' ? 'check' : kind === 'warning' || kind === 'error' ? 'alert' : 'info'));
  const text = makeNode('p', '', message);
  const close = makeNode('button', 'notice-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss notice');
  close.append(makeIcon('close'));
  close.addEventListener('click', () => clearNotice(id));
  notice.append(icon, text, close);
  dom.noticeRegion.append(notice);
  if (!persist) {
    const timer = window.setTimeout(() => clearNotice(id), 6500);
    ui.noticeTimers.set(id, timer);
  }
}

function clearNotice(id) {
  const timer = ui.noticeTimers.get(id);
  if (timer) window.clearTimeout(timer);
  ui.noticeTimers.delete(id);
  dom.noticeRegion?.querySelector(`[data-notice-id="${CSS.escape(id)}"]`)?.remove();
}

function handleUnauthorized() {
  ui.authenticated = false;
  ui.network = 'connecting';
  ui.refreshing = false;
  ui.saving = false;
  ui.draft?.connectors?.forEach((connector) => {
    connector.tokenDraft = '';
  });
  stopAutoRefresh();
  clearCommandWatchers();
  showLogin('Your session expired. Enter the private console code again.');
}

function showLogin(message = '') {
  ui.newConnector.tokenDraft = '';
  ui.memoryFact = '';
  dom.appShell.classList.add('is-hidden');
  dom.authScreen.classList.remove('is-hidden');
  dom.loginMessage.textContent = message;
  window.setTimeout(() => dom.loginCode.focus(), 0);
}

function activateDashboard() {
  ui.authenticated = true;
  ui.loading = true;
  ui.network = 'connecting';
  dom.authScreen.classList.add('is-hidden');
  dom.appShell.classList.remove('is-hidden');
  render();
  startAutoRefresh();
}

async function login(event) {
  event.preventDefault();
  dom.loginMessage.textContent = '';
  const code = dom.loginCode.value;
  if (!code) {
    dom.loginMessage.textContent = 'Enter the private console code.';
    dom.loginCode.focus();
    return;
  }
  const button = dom.loginForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await requestJSON('/api/login', {method: 'POST', body: {code}});
    dom.loginCode.value = '';
    activateDashboard();
    await loadState();
  } catch (error) {
    dom.loginCode.value = '';
    if (error instanceof HttpError && error.status === 401) {
      dom.loginMessage.textContent = 'That code was not accepted.';
    } else if (error instanceof NetworkError) {
      dom.loginMessage.textContent = 'The dashboard is unreachable. Check your connection and try again.';
    } else {
      dom.loginMessage.textContent = 'The console could not sign in. Try again.';
    }
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  if (ui.saving) return;
  dom.logoutButton.disabled = true;
  try {
    await requestJSON('/api/logout', {method: 'POST'});
    clearClientSession();
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      clearClientSession();
    } else {
      dom.logoutButton.disabled = false;
      showMutationError(error, 'Sign out could not be confirmed. Try again.');
    }
  }
}

function clearClientSession() {
  stopAutoRefresh();
  clearCommandWatchers();
  ui.authenticated = false;
  ui.state = null;
  ui.draft = null;
  ui.commands.clear();
  ui.configAwaitingState = null;
  ui.dirty.agent = false;
  ui.dirty.connectors = false;
  ui.network = 'connecting';
  ui.refreshing = false;
  dom.viewRoot.replaceChildren();
  showLogin('Signed out.');
}

function clearCommandWatchers() {
  ui.commandWatchers.forEach((timer) => window.clearTimeout(timer));
  ui.commandWatchers.clear();
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (!ui.authenticated || document.hidden) return;
  ui.autoRefreshTimer = window.setInterval(() => {
    if (!document.hidden) loadState({silent: true});
  }, 30000);
}

function stopAutoRefresh() {
  if (ui.autoRefreshTimer) window.clearInterval(ui.autoRefreshTimer);
  ui.autoRefreshTimer = null;
}

function navigate(view) {
  if (!['overview', 'agent', 'memory', 'connections'].includes(view)) return;
  ui.activeView = view;
  render();
  dom.mainContent.focus({preventScroll: true});
}

async function init() {
  dom.appShell = document.getElementById('app-shell');
  dom.authScreen = document.getElementById('auth-screen');
  dom.viewRoot = document.getElementById('view-root');
  dom.mainContent = document.getElementById('main-content');
  dom.noticeRegion = document.getElementById('notice-region');
  dom.networkLabel = document.getElementById('network-label');
  dom.networkDot = document.getElementById('network-dot');
  dom.syncState = document.getElementById('sync-state');
  dom.syncLabel = document.getElementById('sync-label');
  dom.refreshButton = document.getElementById('refresh-button');
  dom.mobileRefreshButton = document.getElementById('mobile-refresh-button');
  dom.logoutButton = document.getElementById('logout-button');
  dom.loginForm = document.getElementById('login-form');
  dom.loginCode = document.getElementById('login-code');
  dom.loginMessage = document.getElementById('login-message');

  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.view)));
  document.querySelectorAll('[data-view-link]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    navigate(link.dataset.viewLink);
  }));
  dom.refreshButton.addEventListener('click', () => loadState());
  dom.mobileRefreshButton.addEventListener('click', () => loadState());
  dom.logoutButton.addEventListener('click', logout);
  document.getElementById('mobile-logout-button').addEventListener('click', logout);
  dom.loginForm.addEventListener('submit', login);
  window.addEventListener('online', () => {
    ui.network = 'connecting';
    renderChrome();
    if (ui.authenticated && !document.hidden) loadState({silent: true});
  });
  window.addEventListener('offline', () => {
    ui.network = 'offline';
    showNotice('warning', 'The browser is offline. Unsaved values stay on this page and are not sent.', {id: 'offline', persist: true});
    renderChrome();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopAutoRefresh();
      return;
    }
    if (ui.authenticated) {
      startAutoRefresh();
      loadState({silent: true}).finally(resumeCommandWatches);
    }
  });

  showLogin('');
  if (navigator.onLine === false) {
    ui.network = 'offline';
    return;
  }
  try {
    const raw = await requestJSON('/api/state');
    activateDashboard();
    applyState(raw);
    ui.loading = false;
    render();
  } catch (error) {
    if (error instanceof HttpError && error.status !== 401) {
      dom.loginMessage.textContent = 'The dashboard is not ready. Check your connection and retry.';
    }
  }
}

document.addEventListener('DOMContentLoaded', init);
