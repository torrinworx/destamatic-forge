import path from "path";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

const deepMerge = (base, override) => {
	if (override === undefined) return isPlainObject(base) ? { ...base } : base;
	if (!isPlainObject(base) || !isPlainObject(override)) return override;

	const out = { ...base };
	for (const [k, v] of Object.entries(override)) {
		if (v === undefined) continue;
		const bv = base[k];
		out[k] = (isPlainObject(bv) && isPlainObject(v)) ? deepMerge(bv, v) : v;
	}
	return out;
};

/**
 * Recursively find all files within the given directories.
 * Returns an array of objects: [{ directory, filePath }, ...]
 */
const findFiles = async (directories) => {
	const dirs = Array.isArray(directories) ? directories : [directories];

	const recurseDirectory = async (dir) => {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		const results = await Promise.all(
			entries.map(async (entry) => {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					return recurseDirectory(fullPath);
				} else if (entry.name.endsWith(".js")) {
					return { directory: dir, filePath: fullPath };
				}
				return null;
			})
		);
		return results.flat().filter(Boolean);
	}

	const allFiles = [];
	for (const dir of dirs) {
		const found = await recurseDirectory(dir);
		allFiles.push(...found);
	}
	return allFiles;
};

/**
 * Discover module metadata:
 *    - moduleName (based on relative path)
 *    - deps (named export)
 *    - factory (default export)
 */
const mapModules = async (directories, disabledNames, logProgress = true) => {
	const moduleFiles = await findFiles(directories);
	let processedCount = 0;
	const modulesMap = {};

	const disabled = disabledNames instanceof Set ? disabledNames : new Set();

	await Promise.all(
		moduleFiles.map(async ({ directory, filePath }) => {
			try {
				const moduleRoot = directories.find(dir => filePath.startsWith(dir));
				if (!moduleRoot) throw new Error(`Unable to resolve module root for: ${filePath}`);
				const relativePath = path.relative(moduleRoot, filePath);
				const moduleName = relativePath.replace(/\\/g, "/").replace(/\.js$/, "");

				// Allow disabling modules by name (prevents import/registration entirely)
				if (disabled.has(moduleName)) {
					processedCount++;
					if (logProgress) process.stdout.write(`\rProcessed ${processedCount}/${moduleFiles.length} module files...`);
					return;
				}

				const mod = await import(filePath);
				const hasFactory = typeof mod.default === "function";
				if (!hasFactory) {
				processedCount++;
				if (logProgress) process.stdout.write(`\rProcessed ${processedCount}/${moduleFiles.length} module files...`);
				return;
			}

				// TODO: if module is a web-core default module and user specifies their own
				// override the webcore one with the user defined one to allow for customization.
				if (modulesMap[moduleName]) {
					throw new Error(`Duplicate module name found: "${moduleName}". Each module name must be unique.`);
				}

				const deps = Array.isArray(mod.deps) ? mod.deps : [];
				const defaults = isPlainObject(mod.defaults) ? mod.defaults : null;

				modulesMap[moduleName] = {
					directory,
					filePath,
					deps,
					factory: mod.default,
					defaults,
				};

			processedCount++;
			if (logProgress) process.stdout.write(`\rProcessed ${processedCount}/${moduleFiles.length} module files...`);
		} catch (err) {
			console.error(`Failed to discover module at ${filePath}:`, err);
		}
	})
);

	if (logProgress) process.stdout.write("\n");
	return modulesMap;
}

/**
 * Sort modules based on dependencies. Assume each dep
 * is a moduleName in modulesMap. Throws if a cycle or
 * unresolved dependency is found.
 */
const topoSort = (modulesMap, disabledNames) => {
	const allNames = Object.keys(modulesMap);
	const disabled = disabledNames instanceof Set ? disabledNames : new Set();

	// adjacencyList: for A depends on B, we add an edge B->A
	const adjacencyList = {};
	const inDegree = {};

	// Initialize adjacency lists and inDegree counts
	for (const name of allNames) {
		adjacencyList[name] = [];
		inDegree[name] = 0;
	}

	// Build the graph
	for (const name of allNames) {
		const { deps } = modulesMap[name];
		for (const d of deps) {
			if (!modulesMap[d]) {
				if (disabled.has(d)) {
					throw new Error(`Module "${name}" depends on disabled module "${d}".`);
				}
				throw new Error(`Module "${name}" depends on "${d}", but "${d}" was not found.`);
			}
			adjacencyList[d].push(name);
			inDegree[name]++;
		}
	}

	// Collect all nodes with inDegree=0 in a queue
	const queue = [];
	for (const name of allNames) {
		if (inDegree[name] === 0) {
			queue.push(name);
		}
	}

	const sorted = [];
	while (queue.length) {
		const current = queue.shift();
		sorted.push(current);

		for (const neighbor of adjacencyList[current]) {
			inDegree[neighbor]--;
			if (inDegree[neighbor] === 0) {
				queue.push(neighbor);
			}
		}
	}

	// If we didn't process all modules, there is a cycle
	if (sorted.length !== allNames.length) {
		throw new Error(
			"Detected a cycle in module dependencies; cannot topologically sort."
		);
	}

	return sorted;
};

/**
 * Instantiate modules in topological order.  
 *    - Instead of providing all modules in one object, we convert
 *      each dependency, e.g. "stripe/payment", into an injection like:
 *        payment: (args) => instantiated["stripe/payment"].internal(args)
 *    - Also pass "props" (global extra data) for convenience.
 */
const instantiateModules = async (modulesMap, sortedNames, props) => {
	const moduleConfig = isPlainObject(props?.moduleConfig) ? props.moduleConfig : {};
	const logProgress = props?.logProgress !== false;
	const baseProps = isPlainObject(props) ? { ...props } : {};
	delete baseProps.moduleConfig;

	const instantiated = {};
	const total = sortedNames.length;
	let loadedCount = 0;

	for (const name of sortedNames) {
		if (moduleConfig[name] === false) {
			// Defensive: discovery should have skipped, but keep consistent semantics.
			continue;
		}
		const { deps, factory, defaults } = modulesMap[name];
		if (!factory) {
			console.warn(
				`\nNo valid default export function for module "${name}". Skipping instantiation.`
			);
			continue;
		}

		const userCfg = moduleConfig[name];
		if (userCfg !== undefined && !isPlainObject(userCfg)) {
			throw new Error(
				`\nInvalid moduleConfig for "${name}": expected a plain object, undefined, or false (to disable).`
			);
		}

		const effectiveConfig = deepMerge(defaults || {}, userCfg || {});

		// Build the injection object
		const injection = {
			...baseProps,
			webCore: {
				name,
				config: effectiveConfig,
			},
		};

		for (const depName of deps) {
			const depInstance = instantiated[depName];
			if (!depInstance) {
				throw new Error(`\nCannot instantiate "${name}" - missing dependency "${depName}".`);
			}

			const shortName = depName.split("/").pop();

			if (typeof depInstance.internal !== "function") {
				throw new Error(
					`\nDependency "${depName}" does not have an internal() method, but is expected to be called as a function.`
				);
			}

			injection[shortName] = (...args) => {
				return depInstance.internal(...args);
			};
		}

		const instance = await factory(injection);

		if (instance && typeof instance !== "object") {
			throw new Error(`\nModule "${name}" did not return a valid object from its default function.`);
		}

		instantiated[name] = instance;
		loadedCount++;
		if (logProgress) process.stdout.write(`\rLoaded ${loadedCount}/${total} modules...`);
	}

	if (logProgress) process.stdout.write("\n");
	return instantiated;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const Modules = async (dirs, props = {}) => {
	const directories = [
		...(Array.isArray(dirs) ? dirs : (dirs != null ? [dirs] : [])),
		path.resolve(__dirname, "modules"),
	];

	const moduleConfig = isPlainObject(props?.moduleConfig) ? props.moduleConfig : {};
	const disabledNames = new Set(
		Object.entries(moduleConfig)
			.filter(([, v]) => v === false)
			.map(([k]) => k)
	);

	const logProgress = props?.logProgress !== false;
	const modulesMap = await mapModules(directories, disabledNames, logProgress);
	const sortedNames = topoSort(modulesMap, disabledNames);
	return await instantiateModules(modulesMap, sortedNames, props);
};

export default Modules;
