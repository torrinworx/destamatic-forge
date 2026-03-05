import { WebSocketServer } from 'ws';
import { OObject } from 'destam';

import createODB from '../odb/index.js';
import memoryDriver from '../odb/drivers/memory.js';

import createValidation from './validate.js';
import { default as syncNet } from './sync.js';
import Modules from './modules.js';
import http from './servers/http.js';
import { parse } from '../common/clone.js';
import createSchedule from './schedule.js';

const core = async ({
	server = null,
	root,
	modulesDir,
	env,
	port,
	moduleConfig,
	odbDriver,
	odbDriverProps,
	odbThrottleMs,
	testMode = false,
} = {}) => {
	server = server ? server() : http();

	if (env === 'production') server.production({ root });
	else {
		const { createServer: createViteServer } = await import('vite');
		const vite = await createViteServer({ server: { middlewareMode: 'html' } });
		server.development({ vite, root });
	}

	const driver = odbDriver ?? memoryDriver;
	let odb = await createODB({
		driver,
		throttleMs: odbThrottleMs ?? 100,
		driverProps: odbDriverProps,
	});

	// Wrap ODB so validators run automatically on open/findOne/findMany
	const validation = createValidation(odb);
	odb = validation.odb;
	const { registerValidator } = validation;

	const scheduler = createSchedule({
		onError: (err, job) => console.error(`schedule error (${job.name}):`, err),
	});

	const modProps = {
		serverProps: server.props,
		odb,
		env,
		server,
		registerValidator,
	};

	const modules = await Modules(modulesDir, {
		...modProps,
		moduleConfig,
		registerSchedule: (name, scheduleDef, ctx = {}) => {
			if (typeof name !== 'string' || !name) throw new Error('registerSchedule(name, ...) name must be a non-empty string');
			return scheduler.registerSchedule(name, scheduleDef, {
				...modProps,
				...ctx,
			});
		},
	});

	// module-provided validators
	for (const [name, mod] of Object.entries(modules)) {
		const v = mod?.validate;
		if (!v) continue;

		if (typeof v !== 'object') throw new Error(`Module "${name}" validate must be an object`);
		if (typeof v.table !== 'string' || !v.table) throw new Error(`Module "${name}" validate.table must be a string`);
		if (typeof v.register !== 'function') throw new Error(`Module "${name}" validate.register must be a function`);

		const produced = (v.register.length === 0) ? await v.register() : v.register;
		const list = Array.isArray(produced) ? produced : [produced];

		for (const fn of list) {
			if (typeof fn !== 'function') throw new Error(`Module "${name}" validate.register must produce a function (or array)`);
			registerValidator(v.table, fn);
		}
	}

	// schedulers
	for (const [name, mod] of Object.entries(modules)) {
		const defs = mod?.schedule ?? null;
		if (!defs) continue;

		const list = Array.isArray(defs) ? defs : [defs];

		for (let i = 0; i < list.length; i++) {
			const def = list[i];
			const id = def?.name || String(i);
			scheduler.registerSchedule(`${name}:${id}`, def, modProps);
		}
	}

	const nodeServer = await server.listen(port);
	const actualPort = typeof nodeServer?.address === 'function'
		? nodeServer.address()?.port
		: null;
	const wss = new WebSocketServer({ server: nodeServer });

	wss.on('connection', async (ws, req) => {
		const send = obj => {
			if (ws.readyState === 1) ws.send(JSON.stringify(obj));
		};

		const resolveIp = req => {
			const forwarded = req?.headers?.['x-forwarded-for'];
			if (typeof forwarded === 'string' && forwarded.trim()) {
				return forwarded.split(',')[0].trim();
			}
			if (Array.isArray(forwarded) && forwarded.length) {
				return forwarded[0].split(',')[0].trim();
			}
			return req?.socket?.remoteAddress || req?.connection?.remoteAddress || null;
		};

		const clientIp = resolveIp(req);

		const normalizeToken = t => {
			if (typeof t !== 'string') return null;
			t = t.trim();
			if (!t || t === 'null' || t === 'undefined') return null;
			return t;
		};

		const getTokenFromReq = req => {
			try {
				const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
				return normalizeToken(url.searchParams.get('token'));
			} catch {
				return null;
			}
		};

		const resolveAuth = async token => {
			const session = await odb.findOne({
				collection: 'sessions',
				query: { filter: { field: 'uuid', op: 'eq', value: token } },
			});
			if (!session) return null;

			const expires = typeof session.expires === 'number'
				? session.expires
				: +new Date(session.expires);

			if (!expires || Date.now() >= expires) return null;
			if (session.status === false) return null;

			const userKey = typeof session.user === 'string' ? session.user : null;
			if (!userKey) return null;

			const user = await odb.findOne({
				collection: 'users',
				query: { filter: { field: 'id', op: 'eq', value: userKey } },
			});
			if (!user) return null;

			const state = await odb.open({
				collection: 'state',
				query: { filter: { field: 'user', op: 'eq', value: userKey } },
				value: OObject({ user: userKey }),
			});

			const sync = OObject({ state });
			return { session, user, sync };
		};

		let authAttempt = 0;
		let authed = false;
		let token = getTokenFromReq(req);

		let user = null;
		let sync = null;

		let syncStarted = false;
		let stopSync = null;

		const onConCleanups = [];
		const ranOnCon = new Set();

		const addCleanup = ret => {
			if (!ret) return;
			if (typeof ret === 'function') {
				onConCleanups.push(ret);
				return;
			}
			if (Array.isArray(ret)) {
				for (const item of ret) addCleanup(item);
			}
		};

		const runModuleOnCon = async () => {
			for (const [name, mod] of Object.entries(modules)) {
				if (ranOnCon.has(name)) continue;
				if (typeof mod?.onCon !== 'function') continue;

				if (!authed && mod.authenticated !== false) continue;

				ranOnCon.add(name);

				try {
					const ret = await mod.onCon({
						sync,
						user,
						token,
						...modProps,
					});
					addCleanup(ret);
				} catch (err) {
					console.error(`module onCon error (${name})`, err);
				}
			}
		};

		const startSyncOnce = () => {
			if (syncStarted) return;
			syncStarted = true;

			Promise.resolve()
				.then(() => syncNet(() => authed === true, ws, sync))
				.then(ret => {
					if (typeof ret === 'function') stopSync = ret;
				})
				.catch(err => {
					console.error('syncNet error:', err);
					try { ws.close(); } catch { }
				});
		};

		const setAuthToken = async nextToken => {
			nextToken = normalizeToken(nextToken);
			token = nextToken;

			const myAttempt = ++authAttempt;

			authed = false;
			user = null;
			sync = null;

			if (!token) {
				send({ name: 'auth', ok: false });
				await runModuleOnCon();
				return false;
			}

			let auth;
			try {
				auth = await resolveAuth(token);
			} catch (e) {
				console.error('auth resolve error:', e);
				send({ name: 'auth', ok: false });
				await runModuleOnCon();
				return false;
			}

			if (myAttempt !== authAttempt) return false;

			if (!auth) {
				send({ name: 'auth', ok: false });
				await runModuleOnCon();
				return false;
			}

			authed = true;
			user = auth.user;
			sync = auth.sync;

			startSyncOnce();

			send({ name: 'auth', ok: true, token });

			await runModuleOnCon();

			return true;
		};

		await setAuthToken(token);

		ws.on('message', async raw => {
			let msg;
			try {
				msg = parse(raw);
			} catch {
				return send({ error: 'Bad message format' });
			}

			if (msg?.name === 'sync') {
				if (!authed) return send({ error: 'Not authenticated yet (wait for auth.ok)' });
				return;
			}

			if (!authed && msg?.token) {
				await setAuthToken(msg.token);
			}

			const module = modules[msg?.name];
			if (!module?.onMsg) {
				return send({ error: `Module not found: ${msg?.name}`, id: msg?.id });
			}

			if (!authed && module.authenticated !== false) {
				return send({ error: `Unauthorized`, id: msg?.id });
			}

			try {
				const result = await module.onMsg(
					msg.props,
					{
						sync,
						user,
						token,
						ip: clientIp,
						...modProps,
					}
				);

				send({ result, id: msg.id });
			} catch (e) {
				console.error(`module error (${msg?.name})`, e);
				send({ error: e.message, id: msg?.id });
			}
		});

		ws.isAlive = true;
		ws.on('pong', () => { ws.isAlive = true; });

		ws.on('close', () => {
			try { stopSync?.(); } catch { }
			for (const fn of onConCleanups) {
				try { fn(); } catch { }
			}
		});
	});

	const interval = setInterval(() => {
		for (const ws of wss.clients) {
			if (ws.isAlive === false) {
				try { ws.terminate(); } catch { }
				continue;
			}
			ws.isAlive = false;
			try { ws.ping(); } catch { }
		}
	}, 30000);

	wss.on('close', () => clearInterval(interval));

	const closeWithTimeout = (fn, timeoutMs = 1000) => new Promise((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			resolve();
		};
		const timer = setTimeout(finish, timeoutMs);
		try {
			fn(() => {
				clearTimeout(timer);
				finish();
			});
		} catch {
			clearTimeout(timer);
			finish();
		}
	});

	const shutdown = async () => {
		try { scheduler.stopAll(); } catch { }
		try { clearInterval(interval); } catch { }

		for (const ws of wss.clients) {
			try { ws.terminate(); } catch { }
		}
		try { await closeWithTimeout(cb => wss.close(cb), testMode ? 500 : 2000); } catch { }

		try { await odb.close?.(); } catch { }

		if (nodeServer) {
			try { await closeWithTimeout(cb => nodeServer.close(cb), testMode ? 500 : 2000); } catch { }
		}

		try { await server.close?.(); } catch { }

		if (!testMode) process.exit(0);
	};

	if (!testMode) {
		process.on('SIGINT', shutdown);
		process.on('SIGTERM', shutdown);
	}

	if (testMode) {
		return {
			shutdown,
			server,
			odb,
			modules,
			wss,
			nodeServer,
			port: actualPort ?? port,
		};
	}
};

export default core;
