// paginate.js
// Generic capped window paginator (extend-only).
// Works with any backend as long as you provide a `source` with keyset methods.
//
// Expected record shape (from source):
//   { key: string, cursor: number, id: string }    // cursor usually createdAt; id breaks ties
//
// Expected ordering from source results:
//   Always return records in chronological order (oldest -> newest).
//
// Page signal shape (recommended):
//   page: OObject({
//     follow: true,
//     want: null,        // 'older' | 'newer' | null
//     pageSize: 50,
//     cap: 200,
//     anchor: null,      // optional: {cursor,id} or {id} for jump; used only when follow=false
//   })
//
// Usage pattern:
//   - scroll near top:    page.want = 'older'
//   - scroll near bottom: page.want = 'newer' (only if follow=false)
//   - at bottom:          page.follow = true
//   - scroll away:        page.follow = false
//
// Note: UI should handle scroll-jump compensation when prepending.

const noop = () => { };
const clampInt = (n, d) => (Number.isFinite(n) ? Math.max(0, n | 0) : d);

export default function paginate({
	array,               // OArray to append/prepend into
	signal,              // Observer of the page object (usually page.observer)
	source,              // { tail, older, newer, around? }
	attach,              // async (record) => { item, remove? | dispose? } | item
	changes = null,      // optional Observer (ex: chat.observer.path('seq'))
	throttle = 80,

	// record helpers
	getKey = r => r?.key,
	getCursor = r => r?.cursor,
	getId = r => r?.id,

	// called when follow=false and new messages arrive (discord-style "new messages" indicator)
	onNewWhileUnfollowed = null,
} = {}) {
	if (!array) throw new Error('paginate requires { array }');
	if (!signal) throw new Error('paginate requires { signal }');
	if (!source) throw new Error('paginate requires { source }');
	if (typeof source.tail !== 'function') throw new Error('paginate: source.tail(limit) required');
	if (typeof source.older !== 'function') throw new Error('paginate: source.older(beforeTuple, limit) required');
	if (typeof source.newer !== 'function') throw new Error('paginate: source.newer(afterTuple, limit) required');
	if (typeof attach !== 'function') throw new Error('paginate requires { attach(record) }');

	// key -> { item, dispose, cursor, id }
	const attached = new Map();
	// ordered keys matching `array` order (oldest -> newest)
	const orderedKeys = [];

	let req = 0;
	let disposed = false;
	let newerAvailable = false;

	const pathWant = typeof signal.path === 'function' ? signal.path('want') : null;
	const pathFollow = typeof signal.path === 'function' ? signal.path('follow') : null;

	const disposeKey = async (k) => {
		const rec = attached.get(k);
		if (!rec) return;
		attached.delete(k);
		try { await rec.dispose?.(); } catch { }
	};

	let lastWantKey = null;

	const wantKeyOf = (want) => {
		if (!want) return null;
		if (typeof want === 'string') return want; // 'older' | 'newer'
		if (typeof want === 'object') {
			// allow { dir:'older', seq:123 } style commands
			const dir = want.dir ?? want.want;
			const seq = want.seq ?? want.at ?? want.ts ?? '';
			return `${dir}:${seq}`;
		}
		return String(want);
	};

	const trimToCap = async (cap, dropFrom /* 'start' | 'end' */) => {
		cap = clampInt(cap, 200);
		const extra = orderedKeys.length - cap;
		if (extra <= 0) return;

		if (dropFrom === 'start') {
			const dropKeys = orderedKeys.splice(0, extra);
			array.splice(0, extra);
			for (const k of dropKeys) await disposeKey(k);
		} else {
			const start = orderedKeys.length - extra;
			const dropKeys = orderedKeys.splice(start, extra);
			array.splice(array.length - extra, extra);
			for (const k of dropKeys) await disposeKey(k);
		}
	};

	const boundary = () => {
		const oldestKey = orderedKeys[0];
		const newestKey = orderedKeys[orderedKeys.length - 1];
		const oldest = oldestKey ? attached.get(oldestKey) : null;
		const newest = newestKey ? attached.get(newestKey) : null;
		return {
			oldest: oldest ? { cursor: oldest.cursor, id: oldest.id } : null,
			newest: newest ? { cursor: newest.cursor, id: newest.id } : null,
		};
	};

	const normalizeAttachResult = (res) => {
		if (!res) return null;
		// allow attach() to return just an item
		if (!res.item && res.dispose == null && res.remove == null) {
			return { item: res, dispose: null };
		}
		const dispose = res.dispose ?? res.remove ?? null;
		return { item: res.item, dispose };
	};

	const attachRecords = async (records, where /* 'prepend' | 'append' */) => {
		const items = [];
		const keys = [];

		for (const r of records) {
			if (disposed) return { items: [], keys: [] };

			const k = getKey(r);
			if (!k) continue;
			if (attached.has(k)) continue; // dedupe

			const cursor = getCursor(r);
			const id = getId(r);

			const myReq = req;
			const out = normalizeAttachResult(await attach(r));
			if (disposed || myReq !== req) {
				// canceled; clean up what we created
				try { await out?.dispose?.(); } catch { }
				return { items: [], keys: [] };
			}
			if (!out?.item) {
				try { await out?.dispose?.(); } catch { }
				continue;
			}

			attached.set(k, { item: out.item, dispose: out.dispose, cursor, id });
			items.push(out.item);
			keys.push(k);
		}

		if (!keys.length) return { items: [], keys: [] };

		if (where === 'prepend') {
			orderedKeys.splice(0, 0, ...keys);
			array.splice(0, 0, ...items);
		} else {
			orderedKeys.push(...keys);
			array.splice(array.length, 0, ...items);
		}

		return { items, keys };
	};

	const replaceWithRecords = async (records) => {
		// full reset (only used for initial / anchor jump)
		const myReq = req;
		const oldKeys = orderedKeys.splice(0, orderedKeys.length);
		array.splice(0, array.length);

		// dispose old
		for (const k of oldKeys) await disposeKey(k);

		if (disposed || myReq !== req) return;
		await attachRecords(records, 'append');
	};

	const fetchInitial = async (spec) => {
		const pageSize = clampInt(spec?.pageSize, 50);
		const cap = clampInt(spec?.cap, 200);
		const limit = Math.min(cap, pageSize);

		// if not following and anchor exists and source supports around(), prefer it
		if (!spec?.follow && spec?.anchor && typeof source.around === 'function') {
			return await source.around(spec.anchor, limit);
		}

		return await source.tail(limit);
	};

	const step = async (reason /* 'signal' | 'changes' */) => {
		const spec = signal.get();
		const pageSize = clampInt(spec?.pageSize, 50);
		const cap = clampInt(spec?.cap, 200);

		// If follow toggled on (or we get any signal update while follow=true),
		// snap window back to tail. This keeps the model simple and predictable.
		if (spec?.follow && reason === 'signal') {
			lastWantKey = null;
			newerAvailable = false;

			const records = await fetchInitial(spec);
			await replaceWithRecords(records);
			await trimToCap(cap, 'start'); // drop oldest
			return;
		}

		// Changes while unfollowed: don't mutate the list, just notify UI
		// so it can show "new messages" / "scroll to latest".
		if (!spec?.follow && reason === 'changes') {
			newerAvailable = true;
			onNewWhileUnfollowed?.();
			return;
		}

		// Initial fill if empty (handles follow=false startup too)
		if (!orderedKeys.length) {
			const records = await fetchInitial(spec);
			await replaceWithRecords(records);
			await trimToCap(cap, 'start');
			return;
		}

		// Follow=true: on changes, fetch newer than newest and append.
		if (spec?.follow && reason === 'changes') {
			const { newest } = boundary();
			if (!newest) return;

			const records = await source.newer(newest, pageSize);
			await attachRecords(records, 'append');
			await trimToCap(cap, 'start'); // drop oldest if over cap
			return;
		}

		// Manual paging commands
		const want = spec?.want;
		const wantKey = wantKeyOf(want);

		// If UI doesn't clear `want`, ignore repeats so we don't spam fetches.
		if (wantKey && wantKey === lastWantKey) return;

		// Support either 'older' or {dir:'older', seq:...} style
		const wantDir =
			typeof want === 'string' ? want :
				(want && typeof want === 'object' ? (want.dir ?? want.want) : null);

		if (wantDir === 'older') {
			lastWantKey = wantKey;

			const { oldest } = boundary();
			if (!oldest) return;

			const records = await source.older(oldest, pageSize);
			await attachRecords(records, 'prepend');
			await trimToCap(cap, 'end'); // loading older => drop newest if over cap
			return;
		}

		if (wantDir === 'newer') {
			lastWantKey = wantKey;

			const { newest } = boundary();
			if (!newest) return;

			newerAvailable = false;

			const records = await source.newer(newest, pageSize);
			await attachRecords(records, 'append');
			await trimToCap(cap, 'start'); // loading newer => drop oldest if over cap
			return;
		}

		// Optional: anchor jump when follow=false and source supports around().
		// Only do this on 'signal' changes (not on 'changes' ticks).
		if (!spec?.follow && spec?.anchor && typeof source.around === 'function' && reason === 'signal') {
			lastWantKey = null;

			const limit = Math.min(cap, pageSize);
			const records = await source.around(spec.anchor, limit);
			await replaceWithRecords(records);
			await trimToCap(cap, 'start');
		}
	};

	const run = (reason) => {
		const myReq = ++req;
		Promise.resolve()
			.then(async () => {
				if (disposed || myReq !== req) return;
				await step(reason);
			})
			.catch(e => console.error('paginate error:', e));
	};

	const stopSignal = signal.throttle(throttle).watch(() => run('signal'));
	const stopChanges = changes ? changes.watch(() => run('changes')) : noop;

	// initial
	run('signal');

	const stop = () => {
		disposed = true;
		stopSignal?.();
		stopChanges?.();

		(async () => {
			const keys = orderedKeys.splice(0, orderedKeys.length);
			array.splice(0, array.length);
			for (const k of keys) await disposeKey(k);
			attached.clear();
		})();
	};

	// convenience info for UI (optional)
	stop.getNewerAvailable = () => newerAvailable;

	return stop;
}
