import { Synthetic } from "destam/Events.js";
import Observer, { watchGovernor } from "destam/Observer.js";

export const asyncSwitch = (obs, asyncFn) => {
	let cache;

	return Observer(
		() => cache,
		null,
		(listener) => {
			let runId = 0;
			let disposed = false;

			let runCleanups = [];

			const cleanupRun = () => {
				while (runCleanups.length) {
					try {
						runCleanups.pop()();
					} catch {
						// todo? 
					}
				}
			};

			const run = () => {
				cleanupRun();

				const myRun = ++runId;
				let cancelled = false;

				const onCleanup = (fn) => {
					if (typeof fn === "function") runCleanups.push(fn);
				};

				onCleanup(() => {
					cancelled = true;
				});

				Promise.resolve()
					.then(() => asyncFn(obs.get(), onCleanup))
					.then((val) => {
						if (disposed) return;
						if (cancelled) return;
						if (myRun !== runId) return;

						const prev = cache;
						cache = val;
						listener([Synthetic(prev, cache)]);
					})
					.catch(() => {
						// todo
					});
			};

			const stopParent = obs.register_(run, watchGovernor);
			run();

			return () => {
				disposed = true;
				stopParent();
				cleanupRun();
			};
		}
	).memo();
};
