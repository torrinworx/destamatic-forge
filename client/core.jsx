import { OObject, UUID, Observer } from 'destam';

import { default as syncNet } from './sync.js';
import { webcoreToken, setWebcoreToken, clearWebcoreToken } from './cookies.js';

let ws = null;
let connectPromise = null;

const pending = new Map(); // id -> { resolve, reject, timeout }

export const wsConnected = Observer.mutable(false);
export const wsAuthed = Observer.mutable(false);
export const wsAuthKnown = Observer.mutable(false); // "have we received an auth packet yet?"

let syncStarted = false;
let stopSync = null;

const send = (obj) => {
	if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket not connected.');
	ws.send(JSON.stringify(obj));
};


// origin url stuff here is temp. Not really sure how to setup this stuff so that we don't need to hard code a url.
// I want to setup an env variable thing for this , that just get's attached to window on build or dev mode. But idk
// how that would work. this works for testing for now: 
const readBackendOriginMeta = () => {
	if (typeof document === 'undefined') return null;
	const meta = document.querySelector('meta[name="destamatic-backend-origin"]');
	return meta?.content?.trim() || null;
};

const getBackendOriginOverride = () => {
	// Honor explicit overrides from meta tags or host globals so embeds/tests can target custom backends.
	const metaOrigin = readBackendOriginMeta();
	if (metaOrigin) return metaOrigin;

	const globalDestamatic = window.DESTAMATIC;
	const globalBackendOrigin = globalDestamatic?.backendOrigin;
	if (typeof globalBackendOrigin === 'string' && globalBackendOrigin.trim()) {
		return globalBackendOrigin.trim();
	}

	if (typeof window.DESTAMATIC_BACKEND_ORIGIN === 'string' && window.DESTAMATIC_BACKEND_ORIGIN.trim()) {
		return window.DESTAMATIC_BACKEND_ORIGIN.trim();
	}

	if (typeof window.__DESTAMATIC_BACKEND_ORIGIN__ === 'string' && window.__DESTAMATIC_BACKEND_ORIGIN__.trim()) {
		return window.__DESTAMATIC_BACKEND_ORIGIN__.trim();
	}

	return null;
};

const isLikelyAndroidWebView = () => {
	// Heuristic that catches Android WebViews so we can route through the adb proxy when needed.
	const ua = navigator.userAgent || '';
	return /Android/i.test(ua) && /\b(wv|; wv\b|Version\/\d+\.\d+|WebView)/i.test(ua);
};

const getEmbeddedHostBackendOrigin = () => {
	// Embedded hosts like Tauri or Android WebViews reach the server via adb proxy instead of window.location.
	if (window.__TAURI__) return 'http://127.0.0.1:3002';
	if (isLikelyAndroidWebView()) return 'http://127.0.0.1:3002';
	return null;
};

const resolveBackendOrigin = () => {
	// Always derive BACKEND_ORIGIN from the override/embedded helpers to keep detection in one place.
	return getBackendOriginOverride() ?? getEmbeddedHostBackendOrigin() ?? window.location.origin;
};

const BACKEND_ORIGIN = resolveBackendOrigin();

const wsURL = () => {
	const token = webcoreToken.get() || '';
	const u = new URL(BACKEND_ORIGIN);

	u.protocol = (u.protocol === 'https:') ? 'wss:' : 'ws:';
	u.pathname = '/';
	u.search = '';

	if (token) u.searchParams.set('token', token);
	return u.toString();
};

const cleanupSocket = (reason = 'socket closed') => {
	wsConnected.set(false);
	wsAuthed.set(false);
	wsAuthKnown.set(false);

	// stop sync wiring if any
	try { stopSync?.(); } catch { }
	stopSync = null;
	syncStarted = false;

	// reject all pending requests
	for (const [id, p] of pending) {
		clearTimeout(p.timeout);
		p.reject(new Error(reason));
		pending.delete(id);
	}

	ws = null;
};

const startSyncOnce = (state) => {
	if (syncStarted) return;

	const socket = ws;
	if (!socket || socket.readyState !== WebSocket.OPEN) return;

	syncStarted = true;

	Promise.resolve()
		.then(() => syncNet(state, socket))
		.then(ret => {
			if (typeof ret === 'function') stopSync = ret;
		})
		.catch(err => {
			console.error('syncNet error:', err);
			try { socket.close(); } catch { }
		});
};

let reconnectTimer = null;
let reconnectDelay = 500; // start at 0.5s
const reconnectDelayMax = 10000; // cap at 10s

const shouldReconnect = () =>
	document.visibilityState === "visible" && navigator.onLine;

const scheduleReconnect = () => {
	if (reconnectTimer) return;       // already scheduled
	if (!shouldReconnect()) return;   // wait for visibility/online events

	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;

		initWS()
			.then(() => {
				reconnectDelay = 500; // reset backoff on success
			})
			.catch(() => {
				reconnectDelay = Math.min(reconnectDelay * 2, reconnectDelayMax);
				scheduleReconnect();
			});
	}, reconnectDelay);
};

// set these ONCE (module init time, not inside onClose)
window.addEventListener("online", scheduleReconnect);
document.addEventListener("visibilitychange", scheduleReconnect);

export const initWS = async () => {
	if (ws && ws.readyState === WebSocket.OPEN) return ws;
	if (connectPromise) return connectPromise;

	connectPromise = new Promise((resolve, reject) => {
		const socket = new WebSocket(wsURL());
		ws = socket;

		const isCurrent = () => ws === socket;

		const onOpen = () => {
			if (!isCurrent()) return;
			wsConnected.set(true);
			resolve(socket);
		};

		const onError = (err) => {
			if (!isCurrent()) return;
			reject(err);
		};

		const onClose = () => {
			if (!isCurrent()) return;
			cleanupSocket("socket closed");
			scheduleReconnect();
		};

		const onMessage = (event) => {
			if (!isCurrent()) return;

			let msg;
			try { msg = JSON.parse(event.data); } catch { return; }

			if (msg?.name === 'auth') {
				wsAuthKnown.set(true);
				wsAuthed.set(!!msg.ok);

				if (!msg.ok && webcoreToken.get()) clearWebcoreToken();
				return;
			}

			if (msg?.id && pending.has(msg.id)) {
				const p = pending.get(msg.id);
				pending.delete(msg.id);
				clearTimeout(p.timeout);

				if (msg.error) p.reject(new Error(msg.error));
				else p.resolve(msg.result);
			}
		};

		socket.addEventListener('open', onOpen, { once: true });
		socket.addEventListener('error', onError, { once: true });
		socket.addEventListener('close', onClose);
		socket.addEventListener('message', onMessage);
	}).finally(() => {
		connectPromise = null;
	});

	return connectPromise;
};

export const closeWS = () => {
	try { ws?.close(); } catch { }
};

export const modReq = (name, props, { timeout = 60000 } = {}) => {
	if (name === 'sync') {
		return Promise.reject(new Error(`modReq('sync') is not supported; 'sync' is reserved.`));
	}

	return new Promise(async (resolve, reject) => {
		try {
			await initWS();
			if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket not connected.');

			const id = UUID().toHex();

			const t = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`Request timed out: ${name}`));
			}, timeout);

			pending.set(id, { resolve, reject, timeout: t });

			send({
				name,
				id,
				props: props || null,
				token: webcoreToken.get() || '',
			});
		} catch (err) {
			reject(err);
		}
	});
};

export const reconnectWS = async () => {
	const socket = ws;
	try { socket?.close(); } catch { }

	// reset immediately (don't wait for close event)
	cleanupSocket('reconnect');

	await initWS();
};

let singletonState = null;
let singletonStatePromise = null;

export const syncState = async () => {
	if (singletonState) return singletonState;
	if (singletonStatePromise) return singletonStatePromise;

	singletonStatePromise = (async () => {
		await initWS();

		const state = OObject({
			sync: null,
			connected: wsConnected,
			authed: wsAuthed,
			authKnown: wsAuthKnown,
		});

		// if we ever become authed, start syncNet once
		wsAuthed.watch(e => {
			if (e.value) {
				startSyncOnce(state);
			} else {
				// auth lost -> stop network wiring
				try { stopSync?.(); } catch { }
				stopSync = null;
				syncStarted = false;
				state.sync = null;
			}
		});

		// If server already told us we're authed before watchers attached, start now
		if (wsAuthed.get()) startSyncOnce(state);

		await wsAuthKnown.defined(v => v === true);

		state.enter = async ({ email, name, password }) => {
			const response = await modReq('auth/Enter', {
				email: email.get(),
				name: name?.get(),
				password: password.get(),
			});

			if (response?.token) {
				setWebcoreToken(response.token);
				await reconnectWS();
			}

			return response;
		};

		state.leave = async () => {
			clearWebcoreToken();
			state.sync = null;
			await reconnectWS();
		};

		state.check = async (email) =>
			await modReq('auth/Check', { email: email.get() });

		state.modReq = modReq;

		singletonState = state;
		return state;
	})();

	return singletonStatePromise;
};
