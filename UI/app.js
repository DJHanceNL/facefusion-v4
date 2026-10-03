/* ═════════════════════════════════════════════════════════════
   FaceFusion Console — front end for the FaceFusion v4 API
   Single-page app, no build step. Works from file:// because the
   API sends permissive CORS headers.
   ═════════════════════════════════════════════════════════════ */
'use strict';

/* ── Config & persistence ─────────────────────────────────── */

const Config = {
	get baseUrl() { return (localStorage.getItem('ff.baseUrl') || 'http://127.0.0.1:8000').replace(/\/+$/, ''); },
	set baseUrl(v) { localStorage.setItem('ff.baseUrl', v.replace(/\/+$/, '')); },
	get apiKey() { return sessionStorage.getItem('ff.apiKey') || localStorage.getItem('ff.apiKey') || ''; },
	setApiKey(v, remember) {
		sessionStorage.setItem('ff.apiKey', v);
		if (remember) localStorage.setItem('ff.apiKey', v); else localStorage.removeItem('ff.apiKey');
	},
	get wasConnected() { return localStorage.getItem('ff.wasConnected') === '1'; },
	set wasConnected(v) { v ? localStorage.setItem('ff.wasConnected', '1') : localStorage.removeItem('ff.wasConnected'); },
};

/* Processors that need a source, and of which media kind. */
const SOURCE_RULES = { face_swapper: 'image', lip_syncer: 'audio' };

/* ── DOM refs ─────────────────────────────────────────────── */

const $ = id => document.getElementById(id);
const dom = {
	connDot: $('connDot'), connLabel: $('connLabel'), sessionTtl: $('sessionTtl'),
	telemetry: $('telemetry'), telemetryEmpty: $('telemetryEmpty'),
	btnSettings: $('btnSettings'), btnDisconnect: $('btnDisconnect'),
	processorChips: $('processorChips'), optionsGroups: $('optionsGroups'),
	optionsPlaceholder: $('optionsPlaceholder'), optionFilter: $('optionFilter'),
	syncState: $('syncState'),
	zoneSource: $('zoneSource'), inputSource: $('inputSource'), sourceEmpty: $('sourceEmpty'),
	sourceThumbs: $('sourceThumbs'), sourceLoading: $('sourceLoading'), btnSourceFaces: $('btnSourceFaces'),
	zoneTarget: $('zoneTarget'), inputTarget: $('inputTarget'), targetEmpty: $('targetEmpty'),
	targetThumbs: $('targetThumbs'), targetLoading: $('targetLoading'), btnTargetFaces: $('btnTargetFaces'),
	btnRun: $('btnRun'), runHint: $('runHint'),
	outputCanvas: $('outputCanvas'), outputEmpty: $('outputEmpty'), outputProgress: $('outputProgress'),
	jobPhase: $('jobPhase'), jobDetail: $('jobDetail'),
	outputImage: $('outputImage'), outputVideo: $('outputVideo'),
	viewSwitch: $('viewSwitch'), viewResult: $('viewResult'), viewCompare: $('viewCompare'),
	compareWrap: $('compareWrap'), compareBase: $('compareBase'), compareTopWrap: $('compareTopWrap'),
	compareTop: $('compareTop'), compareSlider: $('compareSlider'),
	btnDownload: $('btnDownload'),
	jobsList: $('jobsList'), jobsEmpty: $('jobsEmpty'), btnJobsRefresh: $('btnJobsRefresh'),
	tabBtnBatch: $('tabBtnBatch'), tabBtnStream: $('tabBtnStream'), tabBatch: $('tabBatch'), tabStream: $('tabStream'),
	btnStreamStart: $('btnStreamStart'), btnStreamImage: $('btnStreamImage'), inputStreamImage: $('inputStreamImage'),
	btnStreamStop: $('btnStreamStop'), streamFps: $('streamFps'),
	streamInput: $('streamInput'), streamInputEmpty: $('streamInputEmpty'),
	streamOutput: $('streamOutput'), streamOutputEmpty: $('streamOutputEmpty'),
	settingsModal: $('settingsModal'), cfgUrl: $('cfgUrl'), cfgKey: $('cfgKey'), cfgRemember: $('cfgRemember'),
	btnConnect: $('btnConnect'), btnSettingsClose: $('btnSettingsClose'),
	facesModal: $('facesModal'), facesImage: $('facesImage'), facesLoading: $('facesLoading'), btnFacesClose: $('btnFacesClose'),
	toasts: $('toasts'),
};

/* ── Runtime state ────────────────────────────────────────── */

const App = {
	caps: null,               // raw /capabilities payload
	options: {},              // key → current value (hydrated from GET /state)
	lastGood: {},             // key → last value accepted by the server
	controls: new Map(),      // key → { set(value), el }
	assets: [],               // GET /assets payload list
	selectedSources: new Set(),
	selectedTarget: null,
	jobPoll: null,
	jobsTimer: null,
	busy: false,
	blobUrls: new Set(),      // for cleanup
};

/* ── Toasts ───────────────────────────────────────────────── */

function toast(message, type = 'info', ms = 4200) {
	const el = document.createElement('div');
	el.className = 'toast' + (type === 'error' ? ' t-err' : type === 'ok' ? ' t-ok' : '');
	el.textContent = message;
	dom.toasts.appendChild(el);
	setTimeout(() => { el.classList.add('is-out'); setTimeout(() => el.remove(), 300); }, ms);
}

/* ── API client ───────────────────────────────────────────── */

class ApiError extends Error {
	constructor(status, message) { super(message); this.status = status; }
}

const Api = {
	async call(path, { method = 'GET', body, form, blob = false } = {}, retried = false) {
		const headers = {};
		if (Session.accessToken) headers['Authorization'] = `Bearer ${Session.accessToken}`;
		if (body !== undefined && !form) headers['Content-Type'] = 'application/json';

		let res;
		try {
			res = await fetch(Config.baseUrl + path, {
				method, headers,
				body: form ? form : body !== undefined ? JSON.stringify(body) : undefined,
			});
		} catch (e) {
			throw new ApiError(0, 'API unreachable at ' + Config.baseUrl);
		}

		if (res.status === 401 && !retried && !path.startsWith('/session')) {
			const ok = await Session.refresh();
			if (ok) return Api.call(path, { method, body, form, blob }, true);
			Session.drop('Session expired — reconnect.');
			throw new ApiError(401, 'Session expired');
		}

		if (!res.ok) {
			let message = `HTTP ${res.status}`;
			try { const j = await res.json(); if (j && j.message) message = j.message; } catch { /* empty body */ }
			throw new ApiError(res.status, message);
		}

		if (blob) return res.blob();
		const ct = res.headers.get('content-type') || '';
		return ct.includes('application/json') ? res.json() : null;
	},

	get: (p, opts) => Api.call(p, { ...opts, method: 'GET' }),
	post: (p, body) => Api.call(p, { method: 'POST', body }),
	upload: (p, form) => Api.call(p, { method: 'POST', form }),
	put: (p, body) => Api.call(p, { method: 'PUT', body }),
	patch: p => Api.call(p, { method: 'PATCH' }),
	del: p => Api.call(p, { method: 'DELETE' }),

	wsUrl(path) {
		return Config.baseUrl.replace(/^http/, 'ws') + path;
	},
	openSocket(path) {
		return new WebSocket(Api.wsUrl(path), [`access_token.${Session.accessToken}`]);
	},
};

/* ── Session ──────────────────────────────────────────────── */

const Session = {
	accessToken: null,
	refreshToken: null,
	expiresAt: null,
	refreshTimer: null,
	countdownTimer: null,

	get connected() { return !!this.accessToken; },

	async connect() {
		setConnection('connecting');
		const body = Config.apiKey ? { api_key: Config.apiKey } : {};
		const res = await fetch(Config.baseUrl + '/session', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const j = await res.json().catch(() => null);
			setConnection('offline');
			throw new ApiError(res.status, (j && j.message) || (res.status === 429 ? 'Session limit reached' : `HTTP ${res.status}`));
		}
		const tokens = await res.json();
		this.accessToken = tokens.access_token;
		this.refreshToken = tokens.refresh_token;
		Config.wasConnected = true;

		const info = await Api.get('/session');
		this.expiresAt = new Date(info.expires_at).getTime();
		this.scheduleRefresh();
		this.startCountdown();
		setConnection('online');
		Telemetry.start();
		await hydrateState();
		Assets.refresh();
		Jobs.startAutoRefresh();
	},

	async refresh() {
		if (!this.refreshToken) return false;
		try {
			const res = await fetch(Config.baseUrl + '/session', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ refresh_token: this.refreshToken }),
			});
			if (!res.ok) return false;
			const tokens = await res.json();
			this.accessToken = tokens.access_token;
			this.refreshToken = tokens.refresh_token;
			const info = await Api.get('/session');
			this.expiresAt = new Date(info.expires_at).getTime();
			this.scheduleRefresh();
			Telemetry.restart();
			return true;
		} catch { return false; }
	},

	scheduleRefresh() {
		clearTimeout(this.refreshTimer);
		const msLeft = this.expiresAt - Date.now();
		// rotate at 55% of the TTL so a failed rotation can be retried
		this.refreshTimer = setTimeout(() => this.refresh(), Math.max(msLeft * 0.55, 10_000));
	},

	startCountdown() {
		clearInterval(this.countdownTimer);
		const tick = () => {
			const ms = this.expiresAt - Date.now();
			if (ms <= 0) { dom.sessionTtl.textContent = '00:00'; return; }
			const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
			dom.sessionTtl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
		};
		tick();
		this.countdownTimer = setInterval(tick, 1000);
	},

	async disconnect() {
		Stream.stop();
		try { await Api.del('/session'); } catch { /* already gone */ }
		this.drop('Disconnected.');
	},

	drop(reason) {
		clearTimeout(this.refreshTimer);
		clearInterval(this.countdownTimer);
		this.accessToken = this.refreshToken = null;
		Telemetry.stop();
		Jobs.stopAutoRefresh();
		clearInterval(App.jobPoll);
		setConnection('offline');
		if (reason) toast(reason, 'info');
		checkReadiness();
	},
};

function setConnection(state) {
	const map = { online: ['dot-ok', 'connected'], connecting: ['dot-warn', 'connecting…'], offline: ['dot-idle', 'offline'] };
	const [cls, label] = map[state];
	dom.connDot.className = 'dot ' + cls;
	dom.connLabel.textContent = label;
	dom.sessionTtl.hidden = state !== 'online';
	dom.btnDisconnect.hidden = state !== 'online';
}

/* ── Telemetry (WS /metrics) ──────────────────────────────── */

const Telemetry = {
	ws: null,

	start() {
		this.stop();
		try { this.ws = Api.openSocket('/metrics'); } catch { return; }
		this.ws.onmessage = e => { try { this.render(JSON.parse(e.data)); } catch { /* ignore */ } };
		this.ws.onclose = () => { if (Session.connected) setTimeout(() => Session.connected && this.start(), 5000); };
		this.ws.onerror = () => this.ws.close();
	},

	restart() { if (Session.connected) this.start(); },

	stop() {
		if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch { } this.ws = null; }
		dom.telemetry.innerHTML = '';
		dom.telemetry.appendChild(dom.telemetryEmpty);
		dom.telemetryEmpty.hidden = false;
	},

	render(m) {
		const chips = [];
		const pct = v => v && typeof v.value === 'number' ? Math.round(v.value) : null;

		if (Array.isArray(m.graphic_devices)) {
			for (const g of m.graphic_devices) {
				const u = pct(g.utilization);
				const mem = g.memory && g.memory.used && g.memory.total
					? `${g.memory.used.value}/${g.memory.total.value}${g.memory.total.unit || ''}` : '';
				const temp = g.temperature ? ` ${Math.round(g.temperature.value)}°` : '';
				chips.push(this.chip('GPU', u !== null ? `<b>${u}%</b>` : '<b>—</b>', u, `${mem}${temp}`));
			}
		}
		if (m.processor) {
			const u = pct(m.processor.utilization);
			chips.push(this.chip('CPU', `<b>${u ?? '—'}%</b>`, u, ''));
		}
		if (m.memory && m.memory.utilization) {
			const u = pct(m.memory.utilization);
			const detail = m.memory.used && m.memory.total ? `${m.memory.used.value}${m.memory.used.unit || ''} free ${m.memory.free ? m.memory.free.value + (m.memory.free.unit || '') : ''}` : '';
			chips.push(this.chip('RAM', `<b>${u ?? '—'}%</b>`, u, detail));
		}
		dom.telemetry.innerHTML = chips.join('');
		dom.telemetryEmpty.hidden = true;
	},

	chip(label, valueHtml, pctValue, title) {
		const bar = pctValue !== null && pctValue !== undefined
			? `<span class="tbar"><i style="width:${Math.min(pctValue, 100)}%"></i></span>` : '';
		return `<span class="tchip" title="${title}">${label} ${valueHtml}${bar}</span>`;
	},
};

/* ── Capabilities → options UI ────────────────────────────── */

const GROUP_ORDER = [
	'workflow', 'face_detector', 'face_aligner', 'face_selector', 'face_tracker',
	'face_masker', 'voice_extractor', 'frame_extraction', 'frame_distribution', 'output_creation',
];

const Options = {
	async load() {
		App.caps = await Api.get('/capabilities');
		this.renderProcessors();
		this.renderGroups();
		dom.optionsPlaceholder && dom.optionsPlaceholder.remove();
	},

	activeProcessors() { return new Set(App.options.processors || []); },

	renderProcessors() {
		const meta = App.caps.arguments.processors && App.caps.arguments.processors.processors;
		if (!meta) return;
		dom.processorChips.innerHTML = '';
		const selected = new Set(meta.default || []);
		App.options.processors = [...selected];

		for (const name of meta.choices) {
			const chip = document.createElement('button');
			chip.className = 'chip' + (selected.has(name) ? ' is-on' : '');
			chip.textContent = name;
			chip.dataset.processor = name;
			chip.setAttribute('aria-pressed', selected.has(name));
			chip.onclick = () => {
				const set = this.activeProcessors();
				set.has(name) ? set.delete(name) : set.add(name);
				const ordered = meta.choices.filter(c => set.has(c));
				this.markProcessorChips(ordered);
				this.highlightProcessorGroups();
				StateSync.push('processors', ordered);
				checkReadiness();
			};
			dom.processorChips.appendChild(chip);
		}
		this.markProcessorChips([...selected]);
	},

	markProcessorChips(ordered) {
		for (const chip of dom.processorChips.children) {
			const name = chip.dataset.processor;
			const idx = ordered.indexOf(name);
			chip.classList.toggle('is-on', idx !== -1);
			chip.setAttribute('aria-pressed', idx !== -1);
			chip.innerHTML = idx !== -1 ? `<span class="chip-order">${idx + 1}</span>${name}` : name;
		}
	},

	groupNames() {
		const groups = Object.keys(App.caps.arguments);
		const processorOrder = (App.caps.arguments.processors?.processors?.choices) || [];
		return [
			...GROUP_ORDER.filter(g => groups.includes(g)),
			...processorOrder.filter(g => groups.includes(g)),
			...groups.filter(g => !GROUP_ORDER.includes(g) && !processorOrder.includes(g) && g !== 'processors'),
		];
	},

	renderGroups() {
		dom.optionsGroups.innerHTML = '';
		for (const group of this.groupNames()) {
			const args = App.caps.arguments[group];
			const details = document.createElement('details');
			details.className = 'ogroup';
			details.dataset.group = group;

			const summary = document.createElement('summary');
			summary.textContent = group.replace(/_/g, ' ');
			details.appendChild(summary);

			const body = document.createElement('div');
			body.className = 'ogroup-body';
			for (const [key, meta] of Object.entries(args)) {
				body.appendChild(this.buildControl(key, meta));
			}
			details.appendChild(body);
			dom.optionsGroups.appendChild(details);
		}
		this.highlightProcessorGroups();
	},

	highlightProcessorGroups() {
		const active = this.activeProcessors();
		for (const el of dom.optionsGroups.querySelectorAll('.ogroup')) {
			const on = active.has(el.dataset.group);
			el.classList.toggle('is-processor-active', on);
			if (on) el.open = true;
		}
	},

	buildControl(key, meta) {
		const wrap = document.createElement('div');
		wrap.className = 'opt';
		wrap.dataset.key = key;
		wrap.dataset.search = (key + ' ' + key.replace(/_/g, ' ')).toLowerCase();

		const label = document.createElement('div');
		label.className = 'opt-label';
		const labelText = document.createElement('span');
		labelText.textContent = key.replace(/_/g, ' ');
		const valueTag = document.createElement('span');
		valueTag.className = 'opt-value';
		label.append(labelText, valueTag);

		const d = meta.default, ch = meta.choices;
		let input, get, set;

		const asTyped = (sample, raw) => typeof sample === 'number' ? Number(raw) : raw;

		if (Array.isArray(d)) {
			if (ch && ch.length) {
				// multi-value with choices: chips (few) or checklist (many)
				const sample = ch.find(c => c !== null);
				const current = new Set(d);
				const choiceEls = new Map(); // choice → element for hydration
				const toggle = (val, on) => {
					on ? current.add(val) : current.delete(val);
					const ordered = ch.filter(c => current.has(c));
					valueTag.textContent = `${ordered.length} selected`;
					StateSync.push(key, ordered);
				};
				if (ch.length <= 8) {
					input = document.createElement('div');
					input.className = 'chips';
					for (const c of ch) {
						const b = document.createElement('button');
						b.className = 'chip' + (current.has(c) ? ' is-on' : '');
						b.textContent = String(c);
						b.onclick = () => {
							const on = !b.classList.contains('is-on');
							b.classList.toggle('is-on', on);
							toggle(asTyped(sample, c), on);
						};
						choiceEls.set(c, b);
						input.appendChild(b);
					}
				} else {
					input = document.createElement('div');
					input.className = 'checklist';
					for (const c of ch) {
						const l = document.createElement('label');
						const cb = document.createElement('input');
						cb.type = 'checkbox';
						cb.checked = current.has(c);
						cb.onchange = () => toggle(asTyped(sample, c), cb.checked);
						l.append(cb, document.createTextNode(String(c)));
						choiceEls.set(c, cb);
						input.appendChild(l);
					}
				}
				valueTag.textContent = `${current.size} selected`;
				set = v => {
					const next = new Set(Array.isArray(v) ? v : []);
					current.clear();
					for (const val of next) current.add(val);
					for (const [c, el] of choiceEls) {
						const on = next.has(c);
						if (el.type === 'checkbox') el.checked = on;
						else el.classList.toggle('is-on', on);
					}
					valueTag.textContent = `${current.size} selected`;
				};
				get = () => ch.filter(c => current.has(c));
			} else {
				// free list (margins, padding, colours): comma-separated text
				input = document.createElement('input');
				input.type = 'text';
				input.value = d.join(', ');
				input.spellcheck = false;
				set = v => { input.value = Array.isArray(v) ? v.join(', ') : ''; };
				get = () => input.value.split(',').map(s => s.trim()).filter(s => s !== '').map(s => isNaN(Number(s)) ? s : Number(s));
				input.onchange = () => StateSync.push(key, get());
			}
		} else if (typeof d === 'boolean') {
			const sw = document.createElement('label');
			sw.className = 'switch';
			input = document.createElement('input');
			input.type = 'checkbox';
			input.checked = d;
			const track = document.createElement('span');
			track.className = 'track';
			const txt = document.createElement('span');
			txt.className = 'switch-label';
			txt.textContent = key.replace(/_/g, ' ');
			sw.append(input, track, txt);
			input.onchange = () => StateSync.push(key, input.checked);
			wrap.appendChild(sw);
			wrap.dataset.search = (key + ' ' + txt.textContent).toLowerCase();
			set = v => { input.checked = !!v; };
			get = () => input.checked;
			App.controls.set(key, { set, get, el: wrap });
			return wrap;
		} else if (ch && ch.length) {
			const numeric = typeof ch.find(c => c !== null) === 'number';
			if (numeric && ch.length > 10 && d === null) {
				// nullable numeric range: "auto" switch + disabled slider until manual
				input = document.createElement('input');
				input.type = 'range';
				input.min = ch[0];
				input.max = ch[ch.length - 1];
				input.step = ch.length > 1 ? Math.abs(ch[1] - ch[0]) : 1;
				input.value = ch[0];
				input.disabled = true;
				let manual = false;
				valueTag.textContent = 'auto';
				const autoSw = document.createElement('label');
				autoSw.className = 'switch';
				const autoCb = document.createElement('input');
				autoCb.type = 'checkbox';
				autoCb.checked = false;
				const autoTrack = document.createElement('span');
				autoTrack.className = 'track';
				const autoTxt = document.createElement('span');
				autoTxt.className = 'switch-label';
				autoTxt.textContent = 'set manually';
				autoSw.append(autoCb, autoTrack, autoTxt);
				autoCb.onchange = () => {
					manual = autoCb.checked;
					input.disabled = !manual;
					valueTag.textContent = manual ? input.value : 'auto';
					if (manual) StateSync.push(key, Number(input.value));
				};
				input.oninput = () => { valueTag.textContent = input.value; };
				input.onchange = () => { if (manual) StateSync.push(key, Number(input.value)); };
				wrap.append(label, autoSw, input);
				set = v => {
					manual = v !== null && v !== undefined;
					autoCb.checked = manual;
					input.disabled = !manual;
					if (manual) input.value = v;
					valueTag.textContent = manual ? input.value : 'auto';
				};
				get = () => manual ? Number(input.value) : null;
				App.controls.set(key, { set, get, el: wrap });
				return wrap;
			}
			if (numeric && ch.length > 10) {
				// slider over a fully expanded numeric range
				input = document.createElement('input');
				input.type = 'range';
				input.min = ch[0];
				input.max = ch[ch.length - 1];
				input.step = ch.length > 1 ? Math.abs(ch[1] - ch[0]) : 1;
				input.value = d ?? ch[0];
				valueTag.textContent = input.value;
				input.oninput = () => { valueTag.textContent = input.value; };
				input.onchange = () => StateSync.push(key, Number(input.value));
				set = v => { input.value = v ?? ch[0]; valueTag.textContent = input.value; };
				get = () => Number(input.value);
			} else {
				input = document.createElement('select');
				if (d === null) {
					const auto = document.createElement('option');
					auto.value = '';
					auto.textContent = 'auto';
					input.appendChild(auto);
				}
				for (const c of ch) {
					const o = document.createElement('option');
					o.value = String(c);
					o.textContent = String(c);
					if (c === d) o.selected = true;
					input.appendChild(o);
				}
				const sample = ch.find(c => c !== null);
				input.onchange = () => {
					if (input.value === '') return; // "auto" → leave server default
					StateSync.push(key, asTyped(sample, input.value));
				};
				set = v => { input.value = v === null || v === undefined ? '' : String(v); };
				get = () => input.value === '' ? d : asTyped(sample, input.value);
			}
		} else if (typeof d === 'number') {
			input = document.createElement('input');
			input.type = 'number';
			input.step = 'any';
			input.value = d;
			input.onchange = () => StateSync.push(key, Number(input.value));
			set = v => { input.value = v; };
			get = () => Number(input.value);
		} else {
			input = document.createElement('input');
			input.type = 'text';
			input.spellcheck = false;
			if (d === null) input.placeholder = 'auto';
			else input.value = d;
			input.onchange = () => {
				const v = input.value.trim();
				if (v === '') return;
				const n = Number(v);
				StateSync.push(key, isNaN(n) ? v : n);
			};
			set = v => { input.value = v ?? ''; };
			get = () => input.value.trim() === '' ? d : input.value.trim();
		}

		wrap.append(label, input);
		App.controls.set(key, { set, get, el: wrap });
		return wrap;
	},

	filter(q) {
		q = q.trim().toLowerCase();
		for (const group of dom.optionsGroups.querySelectorAll('.ogroup')) {
			let visible = 0;
			for (const opt of group.querySelectorAll('.opt')) {
				const show = !q || opt.dataset.search.includes(q);
				opt.hidden = !show;
				if (show) visible++;
			}
			group.hidden = visible === 0;
			if (q && visible > 0) group.open = true;
		}
	},

	payload() {
		// step args: full snapshot of known options
		const out = {};
		for (const [key, ctl] of App.controls) {
			const v = ctl.get();
			if (v !== undefined) out[key] = v;
		}
		out.processors = [...this.activeProcessors()];
		return out;
	},
};

/* ── State sync (PUT /state) ──────────────────────────────── */

const StateSync = {
	timers: new Map(),

	push(key, value) {
		App.options[key] = value;
		clearTimeout(this.timers.get(key));
		this.timers.set(key, setTimeout(() => this.send(key, value), 350));
		this.setStatus('syncing…', 'is-syncing');
	},

	async send(key, value) {
		if (!Session.connected) return;
		try {
			await Api.put('/state', { [key]: value });
			App.lastGood[key] = value;
			this.setStatus('synced', 'is-ok');
		} catch (e) {
			this.setStatus('sync failed', 'is-err');
			toast(`Option "${key.replace(/_/g, ' ')}" rejected: ${e.message}`, 'error');
			const ctl = App.controls.get(key);
			if (ctl && key in App.lastGood) ctl.set(App.lastGood[key]);
		}
	},

	setStatus(text, cls) {
		dom.syncState.textContent = text;
		dom.syncState.className = 'sync-state ' + cls;
		clearTimeout(this._fade);
		this._fade = setTimeout(() => { dom.syncState.textContent = ''; dom.syncState.className = 'sync-state'; }, 2500);
	},
};

async function hydrateState() {
	try {
		const state = await Api.get('/state');
		for (const [key, ctl] of App.controls) {
			if (key in state) {
				ctl.set(state[key]);
				App.options[key] = state[key];
				App.lastGood[key] = state[key];
			}
		}
		if (Array.isArray(state.processors)) {
			Options.markProcessorChips(state.processors);
			Options.highlightProcessorGroups();
		}
	} catch (e) {
		toast('Could not read session state: ' + e.message, 'error');
	}
}

/* ── Assets ───────────────────────────────────────────────── */

const Assets = {
	async refresh() {
		if (!Session.connected) return;
		try {
			const res = await Api.get('/assets');
			App.assets = (res && res.assets) || [];
			this.renderZone('source');
			this.renderZone('target');
		} catch (e) {
			toast('Could not list assets: ' + e.message, 'error');
		}
	},

	ofType(type) { return App.assets.filter(a => a.type === type); },

	async upload(type, files) {
		if (!files.length) return;
		const loading = type === 'source' ? dom.sourceLoading : dom.targetLoading;
		loading.hidden = false;
		try {
			const form = new FormData();
			for (const f of files) form.append('file', f);
			const res = await Api.upload(`/assets?type=${type}`, form);
			const ids = (res && res.asset_ids) || [];
			if (!ids.length) throw new Error('Upload was rejected (unsupported or unsafe file).');
			await this.refresh();
			if (type === 'source') {
				for (const id of ids) App.selectedSources.add(id);
				await this.selectSources();
			} else {
				await this.selectTarget(ids[ids.length - 1]);
			}
			toast(`${ids.length} ${type} asset${ids.length > 1 ? 's' : ''} uploaded`, 'ok');
		} catch (e) {
			toast(`Upload failed: ${e.message}`, 'error');
		} finally {
			loading.hidden = true;
			checkReadiness();
		}
	},

	async selectSources() {
		const ids = [...App.selectedSources].filter(id => App.assets.some(a => a.id === id));
		App.selectedSources = new Set(ids);
		try {
			await Api.put('/state?action=select&type=source', { asset_ids: ids });
		} catch (e) { toast('Source selection failed: ' + e.message, 'error'); }
	},

	async selectTarget(id) {
		App.selectedTarget = id;
		try {
			await Api.put('/state?action=select&type=target', { asset_id: id });
		} catch (e) { toast('Target selection failed: ' + e.message, 'error'); }
		checkReadiness();
	},

	async remove(asset) {
		try {
			await Api.del('/assets/' + asset.id);
			App.selectedSources.delete(asset.id);
			if (App.selectedTarget === asset.id) App.selectedTarget = null;
			await this.refresh();
			if (asset.type === 'source') await this.selectSources();
			checkReadiness();
		} catch (e) { toast('Delete failed: ' + e.message, 'error'); }
	},

	renderZone(type) {
		const thumbsEl = type === 'source' ? dom.sourceThumbs : dom.targetThumbs;
		const emptyEl = type === 'source' ? dom.sourceEmpty : dom.targetEmpty;
		const zone = type === 'source' ? dom.zoneSource : dom.zoneTarget;
		const facesBtn = type === 'source' ? dom.btnSourceFaces : dom.btnTargetFaces;
		const assets = this.ofType(type);

		thumbsEl.innerHTML = '';
		emptyEl.style.display = assets.length ? 'none' : '';
		zone.classList.toggle('has-assets', assets.length > 0);

		const facesAsset = type === 'source'
			? assets.find(a => App.selectedSources.has(a.id) && a.media !== 'audio')
			: assets.find(a => a.id === App.selectedTarget);
		facesBtn.hidden = !facesAsset;
		facesBtn.onclick = () => this.showFaces(facesAsset);

		for (const asset of assets) {
			const thumb = document.createElement('div');
			thumb.className = 'thumb';
			const selected = type === 'source' ? App.selectedSources.has(asset.id) : App.selectedTarget === asset.id;
			thumb.classList.toggle('is-selected', selected);
			if (type === 'source' && !selected) thumb.classList.add('is-deselected');
			thumb.title = `${asset.name}.${asset.format} — ${asset.media}`;

			const badge = document.createElement('span');
			badge.className = 'thumb-badge';
			badge.textContent = `${asset.media} · ${asset.format}`;

			if (asset.media === 'audio') {
				const icon = document.createElement('div');
				icon.style.cssText = 'display:flex;height:100%;align-items:center;justify-content:center;color:var(--text-3);font-size:22px;';
				icon.textContent = '♪';
				thumb.appendChild(icon);
			} else {
				const img = document.createElement('img');
				img.alt = asset.name;
				thumb.appendChild(img);
				this.captureUrl(asset, 'frame', '160x160').then(url => { if (url) img.src = url; });
			}

			const x = document.createElement('button');
			x.className = 'thumb-x';
			x.textContent = '✕';
			x.title = 'Delete asset';
			x.setAttribute('aria-label', 'Delete asset ' + asset.name);
			x.onclick = e => { e.stopPropagation(); this.remove(asset); };

			thumb.append(badge, x);
			thumb.onclick = () => {
				if (type === 'source') {
					App.selectedSources.has(asset.id) ? App.selectedSources.delete(asset.id) : App.selectedSources.add(asset.id);
					this.selectSources().then(() => { this.renderZone('source'); checkReadiness(); });
				} else {
					this.selectTarget(asset.id).then(() => this.renderZone('target'));
				}
			};
			thumbsEl.appendChild(thumb);
		}
	},

	async captureUrl(asset, subject, resolution) {
		try {
			let path = `/assets/${asset.id}?action=capture&subject=${subject}&resolution=${resolution}`;
			if (asset.media === 'video') path += '&frame_index=0';
			const blob = await Api.get(path, { blob: true });
			const url = URL.createObjectURL(blob);
			App.blobUrls.add(url);
			return url;
		} catch { return null; }
	},

	async showFaces(asset) {
		if (!asset) return;
		dom.facesModal.hidden = false;
		dom.facesLoading.hidden = false;
		dom.facesImage.hidden = true;
		$('facesTitle').textContent = `Detected faces — ${asset.name}.${asset.format}`;
		const url = await this.captureUrl(asset, 'face', '1024x1024');
		dom.facesLoading.hidden = true;
		if (url) {
			dom.facesImage.src = url;
			dom.facesImage.hidden = false;
		} else {
			toast('No faces detected in this asset.', 'info');
			dom.facesModal.hidden = true;
		}
	},

	outputForJob(jobId) {
		return App.assets
			.filter(a => a.type === 'output' && (a.name === jobId || a.name.startsWith(jobId)))
			.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
	},
};

/* ── Jobs ─────────────────────────────────────────────────── */

const Jobs = {
	async runPipeline() {
		if (App.busy) return;
		App.busy = true;
		dom.btnRun.disabled = true;
		Output.showProgress('Creating job', '');

		try {
			const job = await Api.post('/jobs');
			const jobId = job.job_id;

			Output.showProgress('Adding step', Options.activeProcessors().size + ' processor(s)');
			await Api.post(`/jobs/${jobId}?action=add`, Options.payload());

			Output.showProgress('Submitting job', jobId);
			await Api.patch(`/jobs/${jobId}?action=submit`);

			Output.showProgress('Running', jobId);
			await Api.patch(`/jobs/${jobId}?action=run`);

			await this.poll(jobId);
			Output.showProgress('Collecting output', jobId);
			const asset = await this.waitForOutput(jobId);
			Output.hideProgress();
			if (asset) {
				await Output.display(asset);
				toast('Job completed', 'ok');
			} else {
				toast('Job completed but no output asset was found.', 'error');
			}
		} catch (e) {
			Output.hideProgress();
			toast(e.status === 409 ? 'Another job is already queued or running.' : `Job failed: ${e.message}`, 'error');
		} finally {
			App.busy = false;
			checkReadiness();
			this.refresh();
		}
	},

	poll(jobId) {
		return new Promise((resolve, reject) => {
			clearInterval(App.jobPoll);
			App.jobPoll = setInterval(async () => {
				try {
					const job = await Api.get('/jobs/' + jobId);
					const steps = job.steps || [];
					const done = steps.filter(s => s.status === 'completed').length;
					const failed = steps.find(s => s.status === 'failed');
					const running = steps.find(s => s.status === 'started');
					Output.showProgress(
						failed ? 'Failed' : 'Processing',
						`${done}/${steps.length} steps done${running ? ' — running: ' + (running.args.processors || []).join(', ') : ''}`
					);
					if (failed) {
						clearInterval(App.jobPoll);
						reject(new Error(`Step failed: ${(failed.args.processors || []).join(', ')}`));
					} else if (steps.length && done === steps.length) {
						clearInterval(App.jobPoll);
						resolve();
					}
				} catch (e) {
					clearInterval(App.jobPoll);
					reject(e);
				}
			}, 1500);
		});
	},

	async waitForOutput(jobId, tries = 8) {
		for (let i = 0; i < tries; i++) {
			await Assets.refresh();
			const asset = Assets.outputForJob(jobId);
			if (asset) return asset;
			await new Promise(r => setTimeout(r, 1000));
		}
		return null;
	},

	async refresh() {
		if (!Session.connected) return;
		const statuses = ['queued', 'drafted', 'failed', 'completed'];
		const sections = [];
		try {
			for (const status of statuses) {
				const res = await Api.get(`/jobs?status=${status}`);
				const jobs = Object.entries(res || {}).map(([id, meta]) => ({ id, status, ...meta }));
				if (jobs.length) sections.push({ status, jobs });
			}
		} catch { return; }
		this.render(sections);
	},

	render(sections) {
		dom.jobsList.innerHTML = '';
		if (!sections.length) {
			dom.jobsList.appendChild(dom.jobsEmpty);
			dom.jobsEmpty.hidden = false;
			return;
		}
		for (const { status, jobs } of sections) {
			const label = document.createElement('div');
			label.className = 'jobs-section-label';
			label.textContent = status.toUpperCase();
			dom.jobsList.appendChild(label);

			jobs.sort((a, b) => (b.date_created || '').localeCompare(a.date_created || ''));
			for (const job of jobs.slice(0, 25)) {
				dom.jobsList.appendChild(this.renderJob(job));
			}
		}
	},

	renderJob(job) {
		const el = document.createElement('div');
		el.className = 'job';

		const top = document.createElement('div');
		top.className = 'job-top';
		const id = document.createElement('span');
		id.className = 'job-id';
		id.textContent = job.id;
		id.title = job.id;
		const chip = document.createElement('span');
		chip.className = 'job-status ' + job.status;
		chip.textContent = job.status;
		top.append(id, chip);
		el.appendChild(top);

		if (job.date_created) {
			const steps = document.createElement('div');
			steps.className = 'job-steps';
			const line = document.createElement('div');
			line.className = 'job-step';
			line.textContent = new Date(job.date_created).toLocaleString();
			steps.appendChild(line);
			el.appendChild(steps);
		}

		const actions = document.createElement('div');
		actions.className = 'job-actions';
		const mk = (text, fn, cls = '') => {
			const b = document.createElement('button');
			b.className = 'btn btn-mini ' + cls;
			b.textContent = text;
			b.onclick = fn;
			actions.appendChild(b);
		};

		if (job.status === 'drafted') {
			mk('Submit', () => this.act(`/jobs/${job.id}?action=submit`));
		}
		if (job.status === 'queued') {
			mk('Run', () => this.act(`/jobs/${job.id}?action=run`));
		}
		if (job.status === 'failed') {
			mk('Retry', () => this.act(`/jobs/${job.id}?action=retry`));
		}
		if (job.status === 'completed') {
			mk('Show output', async () => {
				await Assets.refresh();
				const asset = Assets.outputForJob(job.id);
				asset ? Output.display(asset) : toast('No output asset found for this job.', 'error');
			});
		}
		mk('Delete', async () => {
			try { await Api.del('/jobs/' + job.id); this.refresh(); }
			catch (e) { toast('Delete failed: ' + e.message, 'error'); }
		}, 'btn-danger');

		el.appendChild(actions);
		return el;
	},

	async act(path) {
		try {
			await Api.patch(path);
			this.refresh();
		} catch (e) {
			toast(e.status === 409 ? 'Another job is already queued or running.' : 'Action failed: ' + e.message, 'error');
		}
	},

	startAutoRefresh() {
		this.refresh();
		this.stopAutoRefresh();
		App.jobsTimer = setInterval(() => this.refresh(), 5000);
	},

	stopAutoRefresh() { clearInterval(App.jobsTimer); },
};

/* ── Output stage ─────────────────────────────────────────── */

const Output = {
	current: null,

	showProgress(phase, detail) {
		dom.outputProgress.hidden = false;
		dom.jobPhase.textContent = phase;
		dom.jobDetail.textContent = detail || '';
	},

	hideProgress() { dom.outputProgress.hidden = true; },

	async display(asset) {
		this.current = asset;
		try {
			const blob = await Api.get(`/assets/${asset.id}?action=download`, { blob: true });
			const url = URL.createObjectURL(blob);
			App.blobUrls.add(url);

			dom.outputEmpty.style.display = 'none';
			dom.btnDownload.hidden = false;
			dom.btnDownload.href = url;
			dom.btnDownload.download = `${asset.name}.${asset.format}`;

			if (asset.media === 'video') {
				dom.outputImage.hidden = true;
				dom.compareWrap.hidden = true;
				dom.outputVideo.src = url;
				dom.outputVideo.hidden = false;
				dom.viewSwitch.hidden = true;
			} else {
				dom.outputVideo.hidden = true;
				dom.outputImage.src = url;
				dom.outputImage.hidden = false;
				this.setupCompare(asset, url);
			}
		} catch (e) {
			toast('Could not download output: ' + e.message, 'error');
		}
	},

	async setupCompare(asset, resultUrl) {
		const target = App.assets.find(a => a.id === App.selectedTarget);
		if (!target || target.media !== 'image') { dom.viewSwitch.hidden = true; return; }
		const baseUrl = await Assets.captureUrl(target, 'frame', '1024x1024');
		if (!baseUrl) { dom.viewSwitch.hidden = true; return; }

		dom.viewSwitch.hidden = false;
		dom.compareBase.src = baseUrl;
		dom.compareTop.src = resultUrl;
		this.setView('result');
	},

	setView(view) {
		const comparing = view === 'compare' && !dom.viewSwitch.hidden;
		dom.viewResult.classList.toggle('is-active', !comparing);
		dom.viewCompare.classList.toggle('is-active', comparing);
		dom.compareWrap.hidden = !comparing;
		dom.outputImage.hidden = comparing || !dom.outputImage.src;
		if (comparing) {
			requestAnimationFrame(() => this.syncCompare());
		}
	},

	syncCompare() {
		const w = dom.compareWrap.clientWidth;
		if (!w) return;
		dom.compareBase.style.width = w + 'px';
		dom.compareTop.style.width = w + 'px';
		const pct = dom.compareSlider.value;
		dom.compareTopWrap.style.width = pct + '%';
	},
};

/* ── Live stream (WS /stream) ─────────────────────────────── */

const Stream = {
	ws: null,
	media: null,
	timer: null,
	frames: 0,
	fpsTimer: null,
	lastUrl: null,
	canvas: document.createElement('canvas'),

	async startWebcam() {
		if (!Session.connected) return toast('Connect to the API first.', 'error');
		try {
			this.media = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 960 } }, audio: false });
		} catch {
			return toast('Webcam not available.', 'error');
		}
		dom.streamInput.srcObject = this.media;
		dom.streamInput.play();
		dom.streamInputEmpty.style.display = 'none';
		this.connect(() => {
			this.timer = setInterval(() => this.sendFrame(), 125);
		});
		this.ui(true);
	},

	async sendImage(file) {
		if (!Session.connected) return toast('Connect to the API first.', 'error');
		const bitmap = await createImageBitmap(file);
		this.canvas.width = bitmap.width;
		this.canvas.height = bitmap.height;
		this.canvas.getContext('2d').drawImage(bitmap, 0, 0);
		// show the still in the input pane
		dom.streamInputEmpty.style.display = 'none';
		const still = document.createElement('img');
		still.className = 'stream-media';
		still.src = URL.createObjectURL(file);
		App.blobUrls.add(still.src);
		dom.streamInput.replaceWith(still);
		dom.streamInput = still;
		this.connect(() => {
			this.canvas.toBlob(b => b && this.ws.readyState === WebSocket.OPEN && this.ws.send(b), 'image/jpeg', 0.85);
		});
	},

	connect(onOpen) {
		this.closeSocket();
		this.ws = Api.openSocket('/stream');
		this.ws.binaryType = 'blob';
		this.ws.onopen = () => {
			onOpen();
			this.frames = 0;
			this.fpsTimer = setInterval(() => {
				dom.streamFps.textContent = this.frames ? `${this.frames} fps` : '';
				this.frames = 0;
			}, 1000);
		};
		this.ws.onmessage = async e => {
			const blob = e.data instanceof Blob ? e.data : new Blob([e.data]);
			const url = URL.createObjectURL(blob);
			if (this.lastUrl) { URL.revokeObjectURL(this.lastUrl); App.blobUrls.delete(this.lastUrl); }
			this.lastUrl = url;
			dom.streamOutput.src = url;
			dom.streamOutput.hidden = false;
			dom.streamOutputEmpty.style.display = 'none';
			this.frames++;
		};
		this.ws.onerror = () => toast('Stream socket error.', 'error');
		this.ws.onclose = () => this.ui(false);
	},

	sendFrame() {
		const v = dom.streamInput;
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !v.videoWidth) return;
		if (this.ws.bufferedAmount > 512 * 1024) return; // backpressure
		const scale = Math.min(1, 640 / v.videoWidth);
		this.canvas.width = Math.round(v.videoWidth * scale);
		this.canvas.height = Math.round(v.videoHeight * scale);
		this.canvas.getContext('2d').drawImage(v, 0, 0, this.canvas.width, this.canvas.height);
		this.canvas.toBlob(b => {
			if (b && this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(b);
		}, 'image/jpeg', 0.7);
	},

	ui(active) {
		dom.btnStreamStart.hidden = active;
		dom.btnStreamImage.hidden = active;
		dom.btnStreamStop.hidden = !active;
		if (!active) dom.streamFps.textContent = '';
	},

	closeSocket() {
		if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch { } this.ws = null; }
		clearInterval(this.fpsTimer);
	},

	stop() {
		clearInterval(this.timer);
		this.timer = null;
		this.closeSocket();
		if (this.media) { this.media.getTracks().forEach(t => t.stop()); this.media = null; }
		if (dom.streamInput.tagName === 'VIDEO') {
			dom.streamInput.srcObject = null;
		} else {
			const video = document.createElement('video');
			video.id = 'streamInput';
			video.className = 'stream-media';
			video.muted = true;
			video.playsInline = true;
			dom.streamInput.replaceWith(video);
			dom.streamInput = video;
		}
		dom.streamInputEmpty.style.display = '';
		dom.streamOutput.hidden = true;
		dom.streamOutputEmpty.style.display = '';
		this.ui(false);
	},
};

/* ── Readiness ────────────────────────────────────────────── */

function checkReadiness() {
	if (App.busy) return;
	const processors = App.options.processors || [];
	let ok = Session.connected && App.selectedTarget && processors.length > 0;
	let hint = '';

	if (!Session.connected) hint = 'Connect to the API first.';
	else if (!processors.length) hint = 'Select at least one processor.';
	else if (!App.selectedTarget) hint = 'Add a target image or video.';
	else {
		for (const [proc, kind] of Object.entries(SOURCE_RULES)) {
			if (processors.includes(proc)) {
				const has = [...App.selectedSources].some(id => {
					const a = App.assets.find(x => x.id === id);
					return a && (kind === 'image' ? a.media === 'image' : a.media === 'audio');
				});
				if (!has) {
					ok = false;
					hint = `${proc.replace(/_/g, ' ')} needs ${kind === 'image' ? 'an image' : 'an audio'} source.`;
				}
			}
		}
	}

	dom.btnRun.disabled = !ok;
	dom.runHint.textContent = ok ? `${processors.join(' → ')}` : hint;
}

/* ── Tabs, modals, wiring ─────────────────────────────────── */

function switchTab(name) {
	const batch = name === 'batch';
	dom.tabBtnBatch.classList.toggle('is-active', batch);
	dom.tabBtnStream.classList.toggle('is-active', !batch);
	dom.tabBtnBatch.setAttribute('aria-selected', batch);
	dom.tabBtnStream.setAttribute('aria-selected', !batch);
	dom.tabBatch.hidden = !batch;
	dom.tabStream.hidden = batch;
	if (!batch) Jobs.refresh();
}

function wireDropzone(zone, input, type) {
	zone.addEventListener('click', e => { if (!e.target.closest('.thumb')) input.click(); });
	zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
	zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('is-drag'); });
	zone.addEventListener('dragleave', () => zone.classList.remove('is-drag'));
	zone.addEventListener('drop', e => {
		e.preventDefault();
		zone.classList.remove('is-drag');
		Assets.upload(type, [...e.dataTransfer.files]);
	});
	input.addEventListener('change', () => { Assets.upload(type, [...input.files]); input.value = ''; });
}

async function connect() {
	Config.baseUrl = dom.cfgUrl.value.trim() || 'http://127.0.0.1:8000';
	Config.setApiKey(dom.cfgKey.value.trim(), dom.cfgRemember.checked);
	dom.settingsModal.hidden = true;
	try {
		await Session.connect();
		toast('Connected to FaceFusion API', 'ok');
	} catch (e) {
		toast('Connection failed: ' + e.message, 'error');
	}
}

function boot() {
	dom.cfgUrl.value = Config.baseUrl;
	dom.cfgKey.value = Config.apiKey;
	dom.cfgRemember.checked = !!localStorage.getItem('ff.apiKey');

	dom.btnSettings.onclick = () => { dom.settingsModal.hidden = false; dom.cfgUrl.focus(); };
	dom.btnSettingsClose.onclick = () => { dom.settingsModal.hidden = true; };
	dom.btnConnect.onclick = connect;
	dom.btnDisconnect.onclick = () => Session.disconnect();
	dom.settingsModal.addEventListener('click', e => { if (e.target === dom.settingsModal) dom.settingsModal.hidden = true; });
	dom.btnFacesClose.onclick = () => { dom.facesModal.hidden = true; };
	dom.facesModal.addEventListener('click', e => { if (e.target === dom.facesModal) dom.facesModal.hidden = true; });
	document.addEventListener('keydown', e => {
		if (e.key === 'Escape') { dom.settingsModal.hidden = true; dom.facesModal.hidden = true; }
	});

	wireDropzone(dom.zoneSource, dom.inputSource, 'source');
	wireDropzone(dom.zoneTarget, dom.inputTarget, 'target');
	dom.btnRun.onclick = () => Jobs.runPipeline();
	dom.btnJobsRefresh.onclick = () => Jobs.refresh();

	dom.tabBtnBatch.onclick = () => switchTab('batch');
	dom.tabBtnStream.onclick = () => switchTab('stream');
	dom.btnStreamStart.onclick = () => Stream.startWebcam();
	dom.btnStreamImage.onclick = () => dom.inputStreamImage.click();
	dom.inputStreamImage.onchange = () => { if (dom.inputStreamImage.files[0]) Stream.sendImage(dom.inputStreamImage.files[0]); dom.inputStreamImage.value = ''; };
	dom.btnStreamStop.onclick = () => Stream.stop();

	dom.viewResult.onclick = () => Output.setView('result');
	dom.viewCompare.onclick = () => Output.setView('compare');
	dom.compareSlider.oninput = () => Output.syncCompare();
	window.addEventListener('resize', () => { if (!dom.compareWrap.hidden) Output.syncCompare(); });

	dom.optionFilter.oninput = () => Options.filter(dom.optionFilter.value);

	// capabilities are public — render options even before connecting
	Options.load().catch(() => {
		dom.optionsGroups.innerHTML = '<div class="options-placeholder">API unreachable — check the server, then reconnect. Options will load automatically afterwards.</div>';
	});
	if (Config.wasConnected) connect(); else dom.settingsModal.hidden = false;
}

document.addEventListener('DOMContentLoaded', boot);
