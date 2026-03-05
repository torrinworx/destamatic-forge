import test from 'node:test';
import assert from 'node:assert/strict';

import { OObject, OArray } from 'destam';

import paginate from '../common/paginate.js';
import createODB from '../odb/index.js';
import memoryDriver from '../odb/drivers/memory.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const parseIntEnv = (value, fallback) => {
	const num = Number.parseInt(value, 10);
	return Number.isFinite(num) ? num : fallback;
};

const stressEnabled = process.env.CHAT_STRESS === '1' || process.env.CHAT_STRESS === 'true';
const defaultClients = 25;
const defaultMessages = 50;
const defaultMessagesPerClient = 1;
const defaultPageSize = 10;
const defaultCap = 40;
const defaultBatchSize = 5;
const stressClients = 100;
const stressMessages = 120;
const stressMessagesPerClient = 2;
const stressBatchSize = 25;

const clientCount = parseIntEnv(process.env.CHAT_CLIENTS, stressEnabled ? stressClients : defaultClients);
const messageCount = parseIntEnv(process.env.CHAT_MESSAGES, stressEnabled ? stressMessages : defaultMessages);
const messagesPerClient = parseIntEnv(
	process.env.CHAT_MESSAGES_PER_CLIENT,
	stressEnabled ? stressMessagesPerClient : defaultMessagesPerClient
);
const batchSize = parseIntEnv(process.env.CHAT_BATCH, stressEnabled ? stressBatchSize : defaultBatchSize);
const pageSize = parseIntEnv(process.env.CHAT_PAGE_SIZE, defaultPageSize);
const cap = parseIntEnv(process.env.CHAT_CAP, defaultCap);

const defaultWaitTimeout = stressEnabled
	? parseIntEnv(
		process.env.CHAT_WAIT_TIMEOUT,
		Math.min(60000, Math.max(5000, clientCount * 20))
	)
	: 1500;
const defaultWaitInterval = stressEnabled ? 10 : 5;

async function waitFor(fn, { timeout = defaultWaitTimeout, interval = defaultWaitInterval } = {}) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (fn()) return;
		await sleep(interval);
	}
	throw new Error('waitFor: condition not met in time');
}

function decodeStateTree(st) {
	if (!st) return null;
	if (st && typeof st === 'object' && !st.OBJECT_TYPE) return st;

	if (st.OBJECT_TYPE === 'observer_object' && Array.isArray(st.vals)) {
		const out = {};
		for (const { name, val } of st.vals) out[name] = val;
		return out;
	}

	throw new Error('Unknown state_tree encoding: ' + JSON.stringify(st).slice(0, 200));
}

function makeMessageSource({ driver, chatId }) {
	const queryAllChrono = async () => {
		const recs = await driver.rawFindMany({ collection: 'messages', filter: { chatId } });

		const docs = recs
			.map(r => decodeStateTree(r.state_tree))
			.filter(Boolean)
			.map(d => ({
				msgId: d.msgId,
				chatId: d.chatId,
				userId: d.userId,
				text: d.text,
				createdAt: d.createdAt,
				key: d.msgId,
				cursor: d.createdAt,
				id: d.msgId,
			}));

		docs.sort((a, b) => (a.createdAt - b.createdAt) || a.msgId.localeCompare(b.msgId));
		return docs;
	};

	return {
		tail: async (limit) => {
			const all = await queryAllChrono();
			return all.slice(Math.max(0, all.length - limit));
		},
		older: async (beforeTuple, limit) => {
			const all = await queryAllChrono();
			const idx = all.findIndex(r => r.msgId === beforeTuple.id);
			if (idx <= 0) return [];
			return all.slice(Math.max(0, idx - limit), idx);
		},
		newer: async (afterTuple, limit) => {
			const all = await queryAllChrono();
			const idx = all.findIndex(r => r.msgId === afterTuple.id);
			if (idx < 0) return [];
			return all.slice(idx + 1, idx + 1 + limit);
		},
	};
}

async function createMessage({ odb, chatId, userId, createdAt, msgId, text }) {
	const doc = await odb.open({
		collection: 'messages',
		query: { filter: { field: 'msgId', op: 'eq', value: msgId } },
		value: OObject({ msgId, chatId, userId, createdAt, text }),
	});
	await doc.$odb.flush();
	await doc.$odb.dispose();
}

async function createChat({ odb, chatId, creatorId }) {
	const chat = await odb.open({
		collection: 'chats',
		query: { filter: { field: 'chatId', op: 'eq', value: chatId } },
		value: OObject({ chatId, creatorId, seq: 0, title: 'Chat' }),
	});
	await chat.$odb.flush();
	return chat;
}

async function createClient({ odb, driver, chatDoc, chatId, userId, pageSize = 3, cap = 6 }) {
	const messages = OArray([]);
	const page = OObject({
		follow: true,
		want: null,
		pageSize,
		cap,
		anchor: null,
	});

	const source = makeMessageSource({ driver, chatId });

	const stop = paginate({
		array: messages,
		signal: page.observer,
		source,
		changes: chatDoc.observer.path('seq'),
		throttle: 0,
		attach: async (record) => {
			const doc = await odb.findOne({
				collection: 'messages',
				query: { filter: { field: 'msgId', op: 'eq', value: record.msgId } },
			});

			if (!doc) return null;

			return {
				item: doc,
				dispose: async () => {
					await doc.$odb.dispose();
				},
			};
		},
	});

	const findMessage = (msgId) => messages.find(m => m.msgId === msgId) || null;

	const editMessage = async (msgId, nextText) => {
		const doc = findMessage(msgId);
		if (!doc || doc.userId !== userId) return false;
		doc.text = nextText;
		await doc.$odb.flush();
		return true;
	};

	return { messages, page, stop, userId, findMessage, editMessage };
}

test('chat pagination + live updates (ODB + paginate)', { skip: 'proof of concept, skipping.' }, async () => {
	const driver = await memoryDriver({ test: true });
	const odb = await createODB({ driver, throttleMs: 0 });

	const chatId = 'chat_1';
	const users = Array.from({ length: Math.max(clientCount, 2) }, (_, i) =>
		`user_${String(i + 1).padStart(3, '0')}`
	);
	const userA = users[0];
	const userB = users[1];

	const chatDoc = await createChat({ odb, chatId, creatorId: userA });

	let n = 0;
	const nextMsgId = () => `m_${String(++n).padStart(3, '0')}`;
	const nextCreatedAt = () => n;

	const effectivePageSize = Math.max(pageSize, batchSize);
	const effectiveCap = Math.max(cap, effectivePageSize, batchSize);
	const seededCount = Math.max(messageCount, effectivePageSize * 2 + 2);
	for (let i = 0; i < seededCount; i++) {
		const userId = users[i % users.length];
		await createMessage({
			odb,
			chatId,
			userId,
			createdAt: nextCreatedAt(),
			msgId: nextMsgId(),
			text: `hello from ${userId} #${i + 1}`,
		});
	}

	const clients = [];
	for (let i = 0; i < clientCount; i++) {
		clients.push(await createClient({
			odb,
			driver,
			chatDoc,
			chatId,
			userId: users[i],
			pageSize: effectivePageSize,
			cap: effectiveCap,
		}));
	}

	const clientA = clients[0];
	const clientB = clients[1];

	assert.notEqual(clientA.messages, clientB.messages);

	const initialWindowSize = Math.min(effectivePageSize, effectiveCap);
	await waitFor(() => clients.every(client => client.messages.length === initialWindowSize));

	const sampleClients = clientCount <= 10
		? clients
		: [clients[0], clients[1], clients[2], clients[3], clients[4], clients[clientCount - 1]];

	for (const client of sampleClients) {
		assert.ok(client.messages.every(item => item && item.$odb));
	}

	const sampleIds = clientA.messages.slice(0, Math.min(3, clientA.messages.length)).map(m => m.msgId);
	for (const msgId of sampleIds) {
		const ref = clientA.findMessage(msgId);
		assert.ok(ref);
		for (const client of sampleClients) {
			assert.equal(client.findMessage(msgId), ref);
		}
	}

	const newMsgId = nextMsgId();
	await createMessage({
		odb,
		chatId,
		userId: userB,
		createdAt: nextCreatedAt(),
		msgId: newMsgId,
		text: 'live from B',
	});

	chatDoc.seq += 1;
	await chatDoc.$odb.flush();

	await waitFor(() => sampleClients.every(client =>
		client.messages[client.messages.length - 1]?.msgId === newMsgId
	));

	const bMessage = clientA.findMessage(newMsgId);
	assert.ok(bMessage);

	const denied = await clientA.editMessage(newMsgId, 'attempted hijack');
	assert.equal(denied, false);
	assert.equal(bMessage.text, 'live from B');

	const allowed = await clientB.editMessage(newMsgId, 'edited by B');
	assert.equal(allowed, true);

	await waitFor(() => clientA.findMessage(newMsgId)?.text === 'edited by B');
	assert.equal(clientB.findMessage(newMsgId)?.text, 'edited by B');

	if (messagesPerClient > 0) {
		const totalMessages = clientCount * messagesPerClient;
		let pending = [];
		let lastBatchId = null;

		for (let i = 0; i < totalMessages; i++) {
			const ownerIndex = i % clientCount;
			const userId = users[ownerIndex];
			const msgId = nextMsgId();
			await createMessage({
				odb,
				chatId,
				userId,
				createdAt: nextCreatedAt(),
				msgId,
				text: `load from ${userId} #${i + 1}`,
			});

			pending.push({ msgId, ownerIndex });
			lastBatchId = msgId;

			const batchReady = pending.length >= batchSize || i === totalMessages - 1;
			if (!batchReady) continue;

			chatDoc.seq += 1;
			await chatDoc.$odb.flush();

			await waitFor(() => clients.every(client =>
				client.messages[client.messages.length - 1]?.msgId === lastBatchId
			));

			for (const { msgId: batchMsgId, ownerIndex: owner } of pending) {
				const ownerClient = clients[owner];
				const updatedText = `edited by ${users[owner]} ${batchMsgId}`;
				const ok = await ownerClient.editMessage(batchMsgId, updatedText);
				assert.equal(ok, true);
				await waitFor(() => sampleClients.every(client =>
					client.findMessage(batchMsgId)?.text === updatedText
				));
			}

			pending = [];
		}
	}

	clientA.page.follow = false;
	clientA.page.want = { dir: 'older', seq: 1 };

	const totalCount = seededCount + 1 + (clientCount * messagesPerClient);
	const availableOlder = Math.max(0, totalCount - effectiveCap);
	const pulledOlder = Math.min(effectivePageSize, availableOlder);
	const expectedLength = Math.min(effectiveCap, totalCount);
	const expectedStart = totalCount <= effectiveCap
		? 1
		: totalCount - effectiveCap - pulledOlder + 1;
	const expectedEndId = totalCount <= effectiveCap
		? totalCount
		: totalCount - pulledOlder;

	await waitFor(() =>
		clientA.messages.length === expectedLength &&
		clientA.messages[0].msgId === `m_${String(expectedStart).padStart(3, '0')}`
	);
	assert.equal(clientA.messages[0].msgId, `m_${String(expectedStart).padStart(3, '0')}`);
	assert.equal(clientA.messages[clientA.messages.length - 1].msgId, `m_${String(expectedEndId).padStart(3, '0')}`);

	for (const client of clients) {
		client.stop();
	}

	await chatDoc.$odb.dispose();
	await odb.close();
});
