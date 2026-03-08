import { OArray } from 'destam';

export const deps = ['moderation/strings'];

export const defaults = {
	name: { maxLength: 40 },
	description: { maxLength: 2000 },
	tags: true,
	images: true,
};

const coerceImages = (input) => {
	if (input == null) return [];
	if (typeof input === 'string') return [input];
	if (Array.isArray(input)) return input;
	if (typeof input?.[Symbol.iterator] === 'function') return [...input];
	return null;
};

export default ({ strings, webCore, extensions }) => {
	const nameCfg = webCore.config.name;
	const descCfg = webCore.config.description;

	const tagsCfg = webCore.config.tags;
	const imagesCfg = webCore.config.images;

	const nameEnabled = nameCfg !== false;
	const descEnabled = descCfg !== false;
	const tagsEnabled = tagsCfg !== false;
	const imagesEnabled = imagesCfg !== false;

	const nameMaxLen =
		nameEnabled &&
			nameCfg &&
			typeof nameCfg === 'object' &&
			typeof nameCfg.maxLength === 'number'
			? nameCfg.maxLength
			: defaults.name.maxLength;

	const descMaxLen =
		descEnabled &&
			descCfg &&
			typeof descCfg === 'object' &&
			typeof descCfg.maxLength === 'number'
			? descCfg.maxLength
			: defaults.description.maxLength;

	const safeNameMaxLen =
		Number.isFinite(nameMaxLen) && nameMaxLen > 0
			? Math.floor(nameMaxLen)
			: defaults.name.maxLength;

	const safeDescMaxLen =
		Number.isFinite(descMaxLen) && descMaxLen > 0
			? Math.floor(descMaxLen)
			: defaults.description.maxLength;

	return {
		onMessage: async (props, { user, odb }) => {
			const p = props || {};
			const { id } = p;
			if (typeof id !== 'string' || !id.trim()) {
				return { error: 'Invalid id. Must be a non-empty string.' };
			}

			const post = await odb.findOne({
				collection: 'posts',
				query: { filter: { field: 'id', op: 'eq', value: id } },
			});

			if (!post) return { error: 'Post not found.' };
			if (post.deleteAt != null) return { error: 'Post is deleted.' };

			const userId = user.observer.id.toHex();
			if (!userId) return { error: 'Unauthorized' };
			if (post.user !== userId) return { error: 'Unauthorized' };

			const check = async (label, text) => {
				const r = await strings(text);
				if (!r.ok) return { error: `${label} violates moderation rules.`, details: r.reason };
				return null;
			};

			const now = Date.now();
			let changed = false;
			let extensionPatch = null;
			if (typeof extensions?.postUpdate === 'function') {
				const result = await extensions.postUpdate({
					props: p,
					post,
					ctx: { user, odb },
				});
				if (result?.error) return { error: result.error };
				if (result && typeof result === 'object') extensionPatch = result;
			}

			// name
			if ('name' in p) {
				if (!nameEnabled) {
					// ignore when disabled
				} else {
					const { name } = p;
					if (typeof name !== 'string' || name.length > safeNameMaxLen) {
						return {
							error: `Invalid name. Must be a string and no more than ${safeNameMaxLen} characters.`,
						};
					}
					const badName = await check('Name', name);
					if (badName) return badName;

					post.name = name;
					changed = true;
				}
			}

			// description
			if ('description' in p) {
				if (!descEnabled) {
					// ignore when disabled
				} else {
					let { description } = p;
					if (typeof description !== 'string' || description.length > safeDescMaxLen) {
						return {
							error: `Invalid description. Must be a string and no more than ${safeDescMaxLen} characters.`,
						};
					}

					const badDesc = await check('Description', description);
					if (badDesc) return badDesc;

					post.description = description;
					changed = true;
				}
			}

			// tags
			if ('tags' in p) {
				if (!tagsEnabled) {
					// ignore when disabled
				} else {
					const { tags } = p;
					const tagList =
						tags == null ? [] :
							Array.isArray(tags) ? tags :
								[...tags];

					if (!tagList.every(t => typeof t === 'string')) {
						return { error: 'Invalid tags. Must be an array of strings.' };
					}

					for (let i = 0; i < tagList.length; i++) {
						const badTag = await check(`Tag "${tagList[i]}"`, tagList[i]);
						if (badTag) return { ...badTag, tagIndex: i };
					}

					post.tags = OArray(tagList);
					changed = true;
				}
			}

			// images
			if ('images' in p || 'image' in p) {
				if (!imagesEnabled) {
					// ignore when disabled
				} else {
					const provided = ('images' in p) ? p.images : p.image;
					const coerced = coerceImages(provided);
					if (coerced === null || !coerced.every(x => typeof x === 'string')) {
						return { error: 'Invalid images. Must be a string or an array of strings.' };
					}
					post.images = OArray(coerced);
					changed = true;
				}
			}

			if (extensionPatch) {
				for (const [key, val] of Object.entries(extensionPatch)) {
					post[key] = val;
					changed = true;
				}
			}

			if (!changed) {
				return { ok: true, id: post.$odb?.key ?? id };
			}

			post.modifiedAt = now;
			await post.$odb.flush();

			return { ok: true, id: post.$odb?.key ?? id };
		},
	};
};
