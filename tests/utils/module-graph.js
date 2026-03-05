import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const toArray = value => (Array.isArray(value) ? value : (value ? [value] : []));

const resolveModuleName = (moduleRoot, filePath) => {
	const relativePath = path.relative(moduleRoot, filePath);
	return relativePath.replace(/\\/g, '/').replace(/\.js$/, '');
};

export const getDefaultModulesDir = () => {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = path.dirname(__filename);
	return path.resolve(__dirname, '..', '..', 'server', 'modules');
};

const findModuleFiles = async (directories) => {
	const dirs = toArray(directories).filter(Boolean);
	const files = [];

	const walk = async (dir) => {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith('.js')) {
				files.push(fullPath);
			}
		}
	};

	for (const dir of dirs) {
		await walk(dir);
	}

	return { dirs, files };
};

export const createModuleIndex = async (directories) => {
	const { dirs, files } = await findModuleFiles(directories);
	const index = new Map();

	for (const filePath of files) {
		const moduleRoot = dirs.find(dir => filePath.startsWith(dir));
		if (!moduleRoot) continue;
		const moduleName = resolveModuleName(moduleRoot, filePath);
		if (index.has(moduleName)) {
			throw new Error(`Duplicate module name found: "${moduleName}"`);
		}
		index.set(moduleName, filePath);
	}

	return { index, dirs };
};

export const resolveModuleOrder = async (entryNames, index) => {
	const entries = toArray(entryNames);
	const visiting = new Set();
	const visited = new Set();
	const order = [];
	const depCache = new Map();

	const loadDeps = async (name) => {
		if (depCache.has(name)) return depCache.get(name);
		const filePath = index.get(name);
		if (!filePath) throw new Error(`Module "${name}" was not found.`);
		const mod = await import(pathToFileURL(filePath).href);
		const deps = Array.isArray(mod?.deps) ? mod.deps : [];
		depCache.set(name, deps);
		return deps;
	};

	const visit = async (name) => {
		if (visited.has(name)) return;
		if (visiting.has(name)) throw new Error(`Detected a cycle in module dependencies at "${name}".`);
		visiting.add(name);
		const deps = await loadDeps(name);
		for (const dep of deps) {
			if (!index.has(dep)) throw new Error(`Module "${name}" depends on "${dep}", but it was not found.`);
			await visit(dep);
		}
		visiting.delete(name);
		visited.add(name);
		order.push(name);
	};

	for (const name of entries) {
		await visit(name);
	}

	return { order, visited, depCache };
};

export const buildModuleConfig = ({ index, enabled, overrides } = {}) => {
	const config = { ...(overrides || {}) };
	const enabledSet = enabled instanceof Set ? enabled : new Set(toArray(enabled));

	for (const name of index.keys()) {
		if (!enabledSet.has(name) && config[name] === undefined) {
			config[name] = false;
		}
	}

	return config;
};
