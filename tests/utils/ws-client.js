import WebSocket from 'ws';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export const createWsClient = async ({
	port,
	token,
	host = '127.0.0.1',
	waitForAuth = true,
	authTimeoutMs = 500,
	connectTimeoutMs = 2000,
} = {}) => {
	if (!port) throw new Error('createWsClient: port is required');

	const url = new URL(`ws://${host}:${port}`);
	if (token != null) url.searchParams.set('token', token);

	const ws = new WebSocket(url.toString());
	let lastAuth = null;
	const pending = new Map();
	let nextId = 1;

	ws.on('message', (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}

		if (msg?.name === 'auth') lastAuth = msg;

		if (msg?.id && pending.has(msg.id)) {
			const { resolve } = pending.get(msg.id);
			pending.delete(msg.id);
			resolve(msg);
		}
	});

	const openPromise = new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('error', reject);
	});

	if (Number.isFinite(connectTimeoutMs) && connectTimeoutMs > 0) {
		await Promise.race([
			openPromise,
			new Promise((_, reject) => {
				setTimeout(() => reject(new Error('Timed out waiting for websocket open')), connectTimeoutMs);
			}),
		]);
	} else {
		await openPromise;
	}

	const waitForAuthResult = async (timeoutMs = 500) => {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (lastAuth) return lastAuth;
			await sleep(10);
		}
		return lastAuth;
	};

	if (waitForAuth) {
		await waitForAuthResult(authTimeoutMs);
	}

	const send = (name, props = {}, { timeoutMs = 2000 } = {}) => {
		const id = nextId++;
		const payload = { name, props, id };
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify(payload), (err) => {
				if (err) {
					pending.delete(id);
					reject(err);
				}
			});

			if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
				setTimeout(() => {
					if (!pending.has(id)) return;
					pending.delete(id);
					reject(new Error(`Timeout waiting for response to ${name}`));
				}, timeoutMs);
			}
		});
	};

	const close = ({ timeoutMs = 500 } = {}) => new Promise((resolve) => {
		if (ws.readyState === WebSocket.CLOSED) return resolve();
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			resolve();
		};
		const timer = setTimeout(() => {
			try { ws.terminate(); } catch { }
			finish();
		}, timeoutMs);
		ws.once('close', () => {
			clearTimeout(timer);
			finish();
		});
		try {
			ws.close(1000, '');
		} catch {
			clearTimeout(timer);
			finish();
		}
	});

	return { ws, send, waitForAuth: waitForAuthResult, close };
};
