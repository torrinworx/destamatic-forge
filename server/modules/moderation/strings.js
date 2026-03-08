export const defaults = {
	url: 'https://api.openai.com/v1/moderations',
	model: 'omni-moderation-latest',
	apiKeyEnv: 'OPENAI_API_KEY',

	// Block if any category score meets/exceeds its threshold.
	thresholds: {
		'harassment/threatening': 0.20,
		'hate/threatening': 0.10,
		'self-harm/instructions': 0.10,
		'sexual/minors': 0.01,
		'illicit/violent': 0.20,
		'violence/graphic': 0.30,
	},
};

const isPlainObject = v => {
	if (!v || typeof v !== 'object') return false;
	if (Array.isArray(v)) return false;
	return Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null;
};

/**
 * Moderates a string for a general business/public marketplace vibe (LinkedIn/Fiverr/TaskRabbit).
 * Returns: { ok: boolean, flagged: boolean, categories, scores, reason, raw }
 */
const strings = async (input, { url, model, thresholds, apiKey, apiKeyEnv }) => {
	// Basic sanity (don’t waste API calls)
	if (typeof input !== "string") {
		return { ok: false, flagged: true, reason: "Input must be a string." };
	}

	const text = input.trim();
	if (!text) {
		return { ok: true, flagged: false, reason: "Empty string." };
	}

	if (!apiKey) {
		return { ok: false, flagged: true, reason: `Missing API key env var: ${apiKeyEnv}` };
	}

	let resp;
	try {
		resp = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				input,
			}),
		});
	} catch (e) {
		return { ok: false, flagged: true, reason: `Moderation request failed: ${e.message}` };
	}

	if (!resp.ok) {
		const errText = await resp.text().catch(() => "");
		return {
			ok: false,
			flagged: true,
			reason: `Moderation HTTP ${resp.status}${errText ? `: ${errText}` : ""}`,
		};
	}

	const data = await resp.json();
	const result = data?.results?.[0];
	if (!result) {
		return { ok: false, flagged: true, reason: "Unexpected moderation response.", raw: data };
	}

	const { flagged, categories = {}, category_scores: scores = {} } = result;

	// If the model already flagged it, block it.
	if (flagged) {
		return {
			ok: false,
			flagged: true,
			categories,
			scores,
			reason: "Model flagged content.",
			raw: data,
		};
	}

	// block if certain categories exceed thresholds
	for (const [cat, threshold] of Object.entries(thresholds)) {
		if (typeof threshold !== 'number' || !Number.isFinite(threshold)) continue;
		const score = typeof scores[cat] === "number" ? scores[cat] : 0;
		if (score >= threshold) {
			return {
				ok: false,
				flagged: true,
				categories,
				scores,
				reason: `Score threshold hit for ${cat} (${score.toFixed(3)} >= ${threshold}).`,
				raw: data,
			};
		}
	}

	return { ok: true, flagged: false, categories, scores, reason: "Passed.", raw: data };
};

const makeConfig = (cfg) => {
	const { url, model, apiKeyEnv, thresholds } = cfg;
	if (typeof url !== 'string' || !url) {
		throw new Error('Invalid moderation config: url must be a non-empty string.');
	}
	if (typeof model !== 'string' || !model) {
		throw new Error('Invalid moderation config: model must be a non-empty string.');
	}
	if (typeof apiKeyEnv !== 'string' || !apiKeyEnv) {
		throw new Error('Invalid moderation config: apiKeyEnv must be a non-empty string.');
	}
	if (!isPlainObject(thresholds)) {
		throw new Error('Invalid moderation config: thresholds must be an object.');
	}

	return {
		url,
		model,
		apiKeyEnv,
		thresholds,
		apiKey: process.env?.[apiKeyEnv] || null,
	};
};

export default ({ config }) => {
	let cfg;
	try {
		cfg = makeConfig(config);
	} catch (e) {
		throw new Error(`moderation/strings: ${e.message}`);
	}
	return {
		internal: (input) => strings(input, cfg),
	};
};
