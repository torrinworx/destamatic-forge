const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export const defaults = {
	route: '/api/geo/search',
	baseUrl: 'https://nominatim.openstreetmap.org/search',
	userAgent: '',
	referer: null,
	acceptLanguage: 'en',
	email: null,
	minQueryLength: 3,
	maxResults: 8,
	cacheTtlMs: 1000 * 60 * 60 * 24,
	cacheMaxSize: 512,
	globalRateLimitMs: 1000,
	ipRateLimitMs: 1000,
	requestTimeoutMs: 8000,
	attributionText: '© OpenStreetMap contributors',
	messages: {
		missingQuery: 'Missing search query',
		queryTooShort: 'Query is too short',
		rateLimited: 'Rate limited, please try again shortly',
		upstreamError: 'Geocoding service error',
		internalError: 'Internal error',
	},
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const normalizeQuery = (q) => {
	if (typeof q !== 'string') return '';
	return q.trim().replace(/\s+/g, ' ');
};

const createCache = (maxSize) => {
	const store = new Map();

	const get = (key, ttlMs) => {
		const item = store.get(key);
		if (!item) return null;
		if (ttlMs > 0 && Date.now() - item.ts > ttlMs) {
			store.delete(key);
			return null;
		}
		return item.value;
	};

	const set = (key, value) => {
		store.set(key, { ts: Date.now(), value });
		if (store.size <= maxSize) return;
		const firstKey = store.keys().next().value;
		if (firstKey) store.delete(firstKey);
	};

	return { get, set };
};

export default ({ config } = {}) => {
	const messages = isPlainObject(config.messages)
		? { ...defaults.messages, ...config.messages }
		: defaults.messages;

	const baseUrl = typeof config.baseUrl === 'string' && config.baseUrl ? config.baseUrl : defaults.baseUrl;
	const userAgent = typeof config.userAgent === 'string' && config.userAgent ? config.userAgent : defaults.userAgent;
	const referer = typeof config.referer === 'string' && config.referer ? config.referer : defaults.referer;
	const acceptLanguage = typeof config.acceptLanguage === 'string' && config.acceptLanguage ? config.acceptLanguage : defaults.acceptLanguage;
	const email = typeof config.email === 'string' && config.email ? config.email : defaults.email;
	const minQueryLength = Number.isFinite(config.minQueryLength)
		? Math.max(1, Math.floor(config.minQueryLength))
		: defaults.minQueryLength;
	const maxResults = Number.isFinite(config.maxResults)
		? clamp(Math.floor(config.maxResults), 1, 50)
		: defaults.maxResults;
	const cacheTtlMs = Number.isFinite(config.cacheTtlMs)
		? Math.max(0, Math.floor(config.cacheTtlMs))
		: defaults.cacheTtlMs;
	const cacheMaxSize = Number.isFinite(config.cacheMaxSize)
		? clamp(Math.floor(config.cacheMaxSize), 1, 5000)
		: defaults.cacheMaxSize;
	const globalRateLimitMs = Number.isFinite(config.globalRateLimitMs)
		? Math.max(0, Math.floor(config.globalRateLimitMs))
		: defaults.globalRateLimitMs;
	const ipRateLimitMs = Number.isFinite(config.ipRateLimitMs)
		? Math.max(0, Math.floor(config.ipRateLimitMs))
		: defaults.ipRateLimitMs;
	const requestTimeoutMs = Number.isFinite(config.requestTimeoutMs)
		? Math.max(1000, Math.floor(config.requestTimeoutMs))
		: defaults.requestTimeoutMs;
	const attributionText = typeof config.attributionText === 'string' && config.attributionText
		? config.attributionText
		: defaults.attributionText;

	const cache = createCache(cacheMaxSize);
	let lastGlobalAt = 0;
	const lastIpAt = new Map();

	const checkRate = (ip) => {
		const now = Date.now();
		if (globalRateLimitMs > 0 && now - lastGlobalAt < globalRateLimitMs) {
			return { ok: false, retryAfterMs: globalRateLimitMs - (now - lastGlobalAt) };
		}

		if (ipRateLimitMs > 0 && ip) {
			const prev = lastIpAt.get(ip) || 0;
			if (now - prev < ipRateLimitMs) {
				return { ok: false, retryAfterMs: ipRateLimitMs - (now - prev) };
			}
		}

		lastGlobalAt = now;
		if (ip) lastIpAt.set(ip, now);
		return { ok: true };
	};

	return {
		authenticated: false,
		onMessage: async ({ q, limit } = {}, { ip } = {}) => {
			try {
				const query = normalizeQuery(q);
				if (!query) return { ok: false, error: messages.missingQuery };
				if (query.length < minQueryLength) return { ok: false, error: messages.queryTooShort };

				const rate = checkRate(ip);
				if (!rate.ok) {
					return { ok: false, error: messages.rateLimited, retryAfterMs: rate.retryAfterMs };
				}

				const safeLimit = Number.isFinite(parseInt(limit, 10))
					? clamp(parseInt(limit, 10), 1, maxResults)
					: maxResults;

				const cacheKey = `${query.toLowerCase()}|${safeLimit}`;
				const cached = cache.get(cacheKey, cacheTtlMs);
				if (cached) {
					return { ok: true, results: cached, attribution: attributionText, cached: true };
				}

				const params = new URLSearchParams({
					format: 'json',
					addressdetails: '1',
					limit: String(safeLimit),
					q: query,
				});
				if (acceptLanguage) params.set('accept-language', acceptLanguage);
				if (email) params.set('email', email);

				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

				let response;
				try {
					response = await fetch(`${baseUrl}?${params.toString()}`, {
						headers: {
							'User-Agent': userAgent,
							...(referer ? { Referer: referer } : {}),
						},
						signal: controller.signal,
					});
				} finally {
					clearTimeout(timeout);
				}

				if (!response?.ok) {
					return { ok: false, error: messages.upstreamError };
				}

				const data = await response.json();
				if (!Array.isArray(data)) {
					return { ok: false, error: messages.upstreamError };
				}

				const results = data.map(item => ({
					label: item?.display_name ?? '',
					lat: parseFloat(item?.lat),
					lng: parseFloat(item?.lon),
					type: item?.type ?? item?.class ?? '',
					raw: item,
				})).filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lng));

				cache.set(cacheKey, results);
				return { ok: true, results, attribution: attributionText, cached: false };
			} catch (err) {
				if (err?.name === 'AbortError') {
					return { ok: false, error: messages.upstreamError };
				}
				console.error('nominatim search error:', err);
				return { ok: false, error: messages.internalError };
			}
		},
	};
};
