export const defaults = {
	// If set to false, the scheduler module will not register any jobs.
	schedule: {
		// Run every 30 days by default.
		// Users can override via moduleConfig['posts/Scheduler'].schedule.every (ms) or .schedule.cron.
		every: 1000 * 60 * 60 * 24 * 30,
		runOnStart: false,
		tz: 'UTC',
	},

	// Max number of posts to delete per tick.
	batchSize: 500,
};

const normalizeEvery = (every, fallback) => {
	if (typeof every === 'number' && Number.isFinite(every) && every > 0) return every;
	if (typeof every === 'string') {
		const n = Number(every.trim());
		if (Number.isFinite(n) && n > 0) return n;
	}
	return fallback;
};

export default ({ webCore }) => {
	const cfg = webCore?.config || {};

	// Allow disabling schedule without disabling the whole module.
	if (cfg.schedule === false) return {};

	const batchSize = Number.isFinite(cfg.batchSize) && cfg.batchSize > 0
		? Math.floor(cfg.batchSize)
		: defaults.batchSize;

	const tz = typeof cfg.schedule?.tz === 'string' && cfg.schedule.tz.trim()
		? cfg.schedule.tz.trim()
		: defaults.schedule.tz;

	const runOnStart = cfg.schedule?.runOnStart === true;
	const cron = typeof cfg.schedule?.cron === 'string' && cfg.schedule.cron.trim()
		? cfg.schedule.cron.trim()
		: null;

	const every = cron
		? null
		: normalizeEvery(cfg.schedule?.every, defaults.schedule.every);

	const findExpiredBatch = async (odb, now) => {
		return odb.driver.findMany({
			collection: 'posts',
			filter: { 'index.deleteAt': { $lte: now } },
			options: { limit: batchSize },
		});
	};

	const cleanup = async ({ odb }) => {
		if (!odb) throw new Error('posts/Scheduler: odb not provided');

		const now = Date.now();
		let deleted = 0;

		for (;;) {
			const posts = await findExpiredBatch(odb, now);
			if (!posts || posts.length === 0) break;

			for (const post of posts) {
				// $odb.remove() disposes the handle too.
				await post.$odb.remove();
				deleted++;
			}

			// If we didn't fill the batch, we likely drained all matches.
			if (posts.length < batchSize) break;
		}

		return { ok: true, deleted };
	};

	return {
		schedule: {
			name: 'cleanup',
			fn: cleanup,
			runOnStart,
			tz,
			...(cron ? { cron } : { every }),
		},
	};
};
