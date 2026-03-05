import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runODBDriverTests } from './utils/driver-suite.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const driversDir = path.resolve(__dirname, '..', 'odb', 'drivers');

const driverConfigs = {
	mongodb: { driverProps: { test: true } },
	indexeddb: { driverProps: { test: true } },
	memory: { driverProps: { test: true } },
};

const entries = await readdir(driversDir, { withFileTypes: true });
const driverFiles = entries
	.filter(entry => entry.isFile() && entry.name.endsWith('.js'))
	.map(entry => entry.name)
	.sort();

for (const file of driverFiles) {
	const name = file.replace(/\.js$/, '');
	const moduleUrl = pathToFileURL(path.join(driversDir, file)).href;
	const mod = await import(moduleUrl);
	const driver = mod?.default || mod?.driver || mod;
	const config = driverConfigs[name] || {};

	runODBDriverTests({
		name,
		driver,
		...config,
	});
}
