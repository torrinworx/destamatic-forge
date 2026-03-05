import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { core } from '../../server/index.js';
import httpServer from '../../server/servers/http.js';

import {
	createModuleIndex,
	resolveModuleOrder,
	buildModuleConfig,
	getDefaultModulesDir,
} from './module-graph.js';

const toArray = value => (Array.isArray(value) ? value : (value ? [value] : []));

const defaultRoot = () => {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = path.dirname(__filename);
	return path.resolve(__dirname, '..', '..');
};

export const startCoreTest = async ({
	modules,
	modulesDir,
	moduleConfig,
	serverFactory,
	odbDriver,
	odbDriverProps,
	odbThrottleMs = 0,
	root,
	env = 'production',
	port = 0,
} = {}) => {
	const customDirs = toArray(modulesDir);
	const dirs = [...customDirs, getDefaultModulesDir()];
	const { index } = await createModuleIndex(dirs);

	let enabled = null;
	let resolvedModules = null;
	if (modules && toArray(modules).length) {
		const { order, visited } = await resolveModuleOrder(modules, index);
		enabled = visited;
		resolvedModules = order;
	}

	const effectiveModuleConfig = enabled
		? buildModuleConfig({ index, enabled, overrides: moduleConfig })
		: (moduleConfig || {});

	const server = serverFactory ?? httpServer;
	const handles = await core({
		server,
		root: root || defaultRoot(),
		env,
		port,
		modulesDir: customDirs.length ? customDirs : undefined,
		moduleConfig: effectiveModuleConfig,
		odbDriver,
		odbDriverProps,
		odbThrottleMs,
		testMode: true,
	});

	return {
		...handles,
		resolvedModules,
		moduleConfig: effectiveModuleConfig,
	};
};
