import { OArray, OObject } from 'destam';

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

export default ({ strings, webCore }) => {
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
		onMessage: async ({ name, description, tags, image, images }, { user, odb }) => {
			if (nameEnabled) {
				if (typeof name !== 'string' || name.length > safeNameMaxLen) {
					return {
						error: `Invalid name. Must be a string and no more than ${safeNameMaxLen} characters.`,
					};
				}
			}

			if (descEnabled) {
				if (typeof description !== 'string' || description.length > safeDescMaxLen) {
					return {
						error: `Invalid description. Must be a string and no more than ${safeDescMaxLen} characters.`,
					};
				}
			} else {
				description = '';
			}

			// tags
			let tagList = [];
			if (tagsEnabled) {
				tagList =
					tags == null ? [] :
						Array.isArray(tags) ? tags :
							[...tags]; // supports OArray/iterables

				if (!tagList.every(t => typeof t === 'string')) {
					return { error: 'Invalid tags. Must be an array of strings.' };
				}
			} else {
				// ignore tags if disabled
				tagList = [];
			}

			// images
			let imageList = [];
			if (imagesEnabled) {
				// support `images` (preferred) and legacy `image`
				const provided = images ?? image;
				const coerced = coerceImages(provided);
				if (coerced === null || !coerced.every(x => typeof x === 'string')) {
					return { error: 'Invalid images. Must be a string or an array of strings.' };
				}
				imageList = coerced;
			} else {
				imageList = [];
			}

			const check = async (label, text) => {
				const r = await strings(text);
				if (!r.ok) return { error: `${label} violates moderation rules.`, details: r.reason };
				return null;
			};

			if (nameEnabled) {
				const badName = await check('Name', name);
				if (badName) return badName;
			}

			const badDesc = await check('Description', description);
			if (badDesc) return badDesc;

			if (tagsEnabled) {
				for (let i = 0; i < tagList.length; i++) {
					const badTag = await check(`Tag "${tagList[i]}"`, tagList[i]);
					if (badTag) return { ...badTag, tagIndex: i };
				}
			}

			const now = Date.now();

			const value = {
				user: user.observer.id.toHex(),
				description,
				tags: OArray(tagList),
				images: OArray(imageList),
				createdAt: now,
				modifiedAt: now,
			};

			if (nameEnabled) value.name = name;

			const post = await odb.open({
				collection: 'posts',
				value: OObject(value),
			});

			await post.$odb.flush();

			return post.$odb.key;
		},
	};
};
