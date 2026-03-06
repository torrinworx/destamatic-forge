import { probeState } from '../Probe.js';

export default () => ({
	authenticated: true,
	onConnection: async () => {
		probeState.onConnection += 1;
	},
	onMessage: async (props) => {
		probeState.onMessage += 1;
		probeState.lastProps = props ?? null;
		return { ok: true };
	},
});
