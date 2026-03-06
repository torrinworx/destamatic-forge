import { Delete, OObject, OArray } from 'destam';
import { Obridge, clone } from '../../../common/index.js';

const normalizeName = v => (typeof v === 'string' ? v.trim() : '');
const normalizeImage = v => {
	if (v == null) return null;
	if (typeof v !== 'string') return null;
	const s = v.trim();
	return s.length ? s : null;
};
const normalizeRole = v => (v === 'admin' ? 'admin' : null);
const normalizeUserId = v => (typeof v === 'string' && v.trim() ? v : null);
const normalizeDescription = v => (typeof v === 'string' ? v.trim() : '');
const normalizeEmailVerified = v => v === true;

const ensureOObject = v => (v instanceof OObject ? v : OObject(v && typeof v === 'object' ? v : {}));
const ensurePlainObject = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const normalizeDomain = (value) => {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return null;
	return trimmed.replace(/^https?:\/\//, '').replace(/\/$/, '');
};
const ensureAllowedDomains = (configValue) => {
	if (configValue === false) return false;
	if (!Array.isArray(configValue)) return [];
	const result = [];
	for (const entry of configValue) {
		const domain = normalizeDomain(entry);
		if (domain && !result.includes(domain)) result.push(domain);
	}
	return result;
};
const matchesAllowedDomain = (host, allowedDomain) => {
	if (!host || !allowedDomain) return false;
	if (host === allowedDomain) return true;
	return host.endsWith(`.${allowedDomain}`);
};
const normalizeSocialLinkValue = (value, allowedDomains) => {
	if (allowedDomains === false) return false;
	if (!Array.isArray(allowedDomains) || allowedDomains.length === 0) return null;
	if (typeof value !== 'string') return null;
	let input = value.trim();
	if (!input) return null;
	if (!/^https?:\/\//i.test(input)) input = `https://${input}`;
	let url;
	try {
		url = new URL(input);
	} catch (err) {
		return null;
	}
	const host = url.hostname?.toLowerCase?.();
	if (!allowedDomains.some(domain => matchesAllowedDomain(host, domain))) return null;
	url.protocol = 'https:';
	url.hash = '';
	return url.toString();
};
const normalizeSocialLinks = (value, allowedDomains) => {
	if (allowedDomains === false) return false;
	if (!Array.isArray(allowedDomains) || allowedDomains.length === 0) return [];
	const input = Array.isArray(value) ? value : [];
	const seen = new Set();
	const out = [];
	for (const entry of input) {
		const normalized = normalizeSocialLinkValue(typeof entry === 'string' ? entry : '', allowedDomains);
		if (normalized && !seen.has(normalized)) {
			seen.add(normalized);
			out.push(normalized);
		}
	}
	return out;
};

const bridged = new WeakSet();

export const defaults = {
	enabled: true,
	throttleMs: 200,
	userToProfile: {
		enabled: true,
		allow: [
			['id'],
			['name'],
			['role'],
			['image'],
			['description'],
			['emailVerified'],
			['socialLinks'],
		],
	},
	profileToUser: {
		enabled: true,
		allow: [
			['name'],
			['image'],
			['description'],
			['socialLinks'],
		],
	},
	socialLinks: [
		'instagram.com',
		'linkedin.com',
		'github.com',
		'x.com',
	],
};

const normalizeUserValue = (key, value, socialLinkDomains) => {
	switch (key) {
		case 'name':
			return normalizeName(value);
		case 'role':
			return normalizeRole(value);
		case 'image':
			return normalizeImage(value);
		case 'id':
			return normalizeUserId(value);
		case 'description':
			return normalizeDescription(value);
		case 'emailVerified':
			return normalizeEmailVerified(value);
		case 'socialLinks':
			return normalizeSocialLinks(value, socialLinkDomains);
		default:
			return value;
	}
};

export default ({ odb, webCore }) => ({
	validate: {
		table: 'state',

		register: async state => {
			if (!state || typeof state !== 'object') return;

			const cfg = ensurePlainObject(webCore.config);
			const throttleMs = Number.isFinite(cfg.throttleMs) && cfg.throttleMs >= 0 ? Math.floor(cfg.throttleMs) : 0;

			const userToProfileCfg = ensurePlainObject(cfg.userToProfile);
			const profileToUserCfg = ensurePlainObject(cfg.profileToUser);
			const socialLinksConfig = cfg.socialLinks === undefined ? defaults.socialLinks : cfg.socialLinks;
			const allowedSocialDomains = ensureAllowedDomains(socialLinksConfig);
			const socialLinksEnabled = allowedSocialDomains !== false && allowedSocialDomains.length > 0;

			const userToProfileEnabled = userToProfileCfg.enabled !== false;
			const profileToUserEnabled = profileToUserCfg.enabled !== false;

			if (!userToProfileEnabled && !profileToUserEnabled) return;

			const prepareProfile = (value) => {
				const next = ensureOObject(value);

				if (!('id' in next)) next.id = null;
				if (!('name' in next)) next.name = '';
				if (!('role' in next)) next.role = null;
				if (!('image' in next)) next.image = null;
				if (!('description' in next)) next.description = '';
				if (!('emailVerified' in next)) next.emailVerified = false;
				if (!('socialLinks' in next)) next.socialLinks = socialLinksEnabled ? OArray([]) : false;

				next.name = normalizeName(next.name);
				next.role = normalizeRole(next.role);
				next.image = normalizeImage(next.image);
				next.description = normalizeDescription(next.description);
				next.emailVerified = normalizeEmailVerified(next.emailVerified);
				if (socialLinksEnabled) {
					const normalized = normalizeSocialLinks(next.socialLinks, allowedSocialDomains);
					next.socialLinks = next.socialLinks instanceof OArray
						? (next.socialLinks.splice(0, next.socialLinks.length, ...normalized), next.socialLinks)
						: OArray(normalized);
				} else {
					next.socialLinks = false;
				}

				return next;
			};

			state.profile = prepareProfile(state.profile);
			const profile = state.profile;

			const userId = typeof state.user === 'string' && state.user ? state.user : profile.id;
			if (typeof userId !== 'string' || !userId) return;

			const user = await odb.findOne({
				collection: 'users',
				query: { filter: { field: 'id', op: 'eq', value: userId } },
			});
			if (!user) return;


			const canonicalFromUser = (targetProfile) => {
				const id = user.id ?? user.$odb?.key ?? userId;
				const canonicalId = normalizeUserId(id);
				targetProfile.id = canonicalId;
				targetProfile.name = normalizeName(user.name);
				targetProfile.role = normalizeRole(user.role);
				targetProfile.image = normalizeImage(user.image);
				targetProfile.description = normalizeDescription(user.description);
				targetProfile.emailVerified = normalizeEmailVerified(user.emailVerified);
				if (socialLinksEnabled) {
					const normalizedSocialLinks = normalizeSocialLinks(user.socialLinks, allowedSocialDomains);
					if (!(user.socialLinks instanceof OArray)) {
						user.socialLinks = OArray(normalizedSocialLinks);
					} else {
						user.socialLinks.splice(0, user.socialLinks.length, ...normalizedSocialLinks);
					}
					targetProfile.socialLinks = clone(user.socialLinks);
				} else {
					targetProfile.socialLinks = false;
				}
				state.user = canonicalId;
			};

			canonicalFromUser(profile);

			if (bridged.has(state)) return;
			bridged.add(state);

			const flushState = async () => {
				try {
					await state.$odb?.flush?.();
				} catch (err) {
					console.error('state validator flush error:', err);
				}
			};

			const flushUser = async () => {
				try {
					await user.$odb?.flush?.();
				} catch (err) {
					console.error('state validator user flush error:', err);
				}
			};

			const transform = (delta, dir) => {
				if (!delta || !Array.isArray(delta.path) || delta.path.length === 0) return null;
				const key = delta.path[0];

				if (key === 'socialLinks') {
					if (delta instanceof Delete) return delta;
					if (delta.path.length > 1) {
						const normalized = normalizeSocialLinkValue(delta.value, allowedSocialDomains);
						if (!normalized) return null;
						delta.value = normalized;
						return delta;
					}

					const normalized = normalizeSocialLinks(delta.value, allowedSocialDomains);
					if (normalized === false) {
						delta.value = false;
						return delta;
					}
					delta.value = OArray(normalized);
					return delta;
				}

				if (dir === 'AtoB') {
					if (!['id', 'name', 'role', 'image', 'description', 'emailVerified', 'socialLinks'].includes(key)) return null;
					if (delta instanceof Delete) return delta;
					const normalized = normalizeUserValue(key, delta.value, allowedSocialDomains);
					if (key === 'id') state.user = normalized;
					delta.value = normalized;
					return delta;
				}

				if (dir === 'BtoA') {
					if (!['name', 'image', 'description', 'socialLinks'].includes(key)) return null;
					if (delta instanceof Delete) return delta;
					const normalized = normalizeUserValue(key, delta.value, allowedSocialDomains);
					delta.value = normalized;
					return delta;
				}

				return delta;
			};

			const userToProfileAllow = Array.isArray(userToProfileCfg.allow)
				? userToProfileCfg.allow
				: undefined;
			const profileToUserAllow = Array.isArray(profileToUserCfg.allow)
				? profileToUserCfg.allow
				: undefined;

			let stopBridge = null;

			const startBridge = (nextProfile) => {
				if (!nextProfile) return;
				const prepared = prepareProfile(nextProfile);
				if (prepared !== nextProfile) state.profile = prepared;

				if (stopBridge) {
					try { stopBridge(); } catch (err) {
						console.error('state validator bridge cleanup error:', err);
					}
				}

				stopBridge = Obridge({
					a: user.observer,
					b: prepared.observer,
					aToB: userToProfileEnabled,
					bToA: profileToUserEnabled,
					throttle: throttleMs,
					allowAtoB: userToProfileAllow,
					allowBtoA: profileToUserAllow,
					transform,
					flushA: profileToUserEnabled ? flushUser : null,
					flushB: userToProfileEnabled ? flushState : null,
				});
			};

			startBridge(profile);

			const stopProfileWatch = state.observer
				.path('profile')
				.watchCommit((commit) => {
					for (const delta of commit) {
						if (!Array.isArray(delta?.path)) continue;
						if (delta.path.length !== 1 || delta.path[0] !== 'profile') continue;
						startBridge(state.profile);
					}
				});

			return () => {
				try { stopProfileWatch?.(); } catch (err) {
					console.error('state validator profile watch cleanup error:', err);
				}
				if (stopBridge) {
					try {
						stopBridge();
					} catch (err) {
						console.error('state validator bridge cleanup error:', err);
					}
				}
				bridged.delete(state);
			};
		},
	},
});
