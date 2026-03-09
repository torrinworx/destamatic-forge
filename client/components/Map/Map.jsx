import {
	Observer,
	Theme,
	ThemeContext,
	Button,
	Icon,
	Paper,
} from '@destamatic/ui';

Theme.define({
	map: {
		position: 'relative',
		width: '100%',
		height: '100%',
		overflow: 'clip',
	},

	map_canvas: {
		width: '100%',
		height: '100%',
	},

	map_overlay: {
		position: 'absolute',
		inset: 0,
		zIndex: 1000,
		pointerEvents: 'none',
	},

	map_overlay_content: {
		position: 'absolute',
		inset: 0,
		pointerEvents: 'none',
	},

	map_zoom: {
		position: 'absolute',
		top: 16,
		right: 16,
		display: 'flex',
		flexDirection: 'column',
		gap: 10,
		zIndex: 1100,
		pointerEvents: 'auto',
	},
});

const normalizeLatLng = (value, fallback = { lat: 0, lng: 0 }) => {
	if (!value) return fallback;
	if (Array.isArray(value) && value.length >= 2) return { lat: value[0], lng: value[1] };
	if (typeof value.lat === 'number' && typeof value.lng === 'number') return { lat: value.lat, lng: value.lng };
	return fallback;
};

const normalizeObserver = (value, fallback, mutable = true) => {
	if (value instanceof Observer) return value;
	if (!mutable) return Observer.immutable(value ?? fallback);
	return Observer.mutable(value ?? fallback);
};

const normalizeListObserver = (value) => {
	if (value instanceof Observer) return value;
	if (value?.observer instanceof Observer) return value.observer;
	return Observer.mutable(Array.isArray(value) ? value : []);
};

const safeList = (list) => Array.isArray(list) ? [...list] : (list ? [...list] : []);

const addLayerItem = (map, item) => {
	if (!item || !map) return null;

	let resolved = item;
	if (typeof item === 'function') resolved = item(map);
	if (!resolved) return null;

	const layer = resolved?.layer ?? resolved;
	if (layer?.addTo) layer.addTo(map);

	return {
		layer,
		cleanup: resolved?.cleanup,
	};
};

const removeLayerItem = (map, item) => {
	if (!item) return;
	if (item.cleanup) item.cleanup();
	const layer = item.layer ?? item;
	if (layer?.remove) layer.remove();
	else if (layer?.removeFrom) layer.removeFrom(map);
	else if (map?.removeLayer && layer) map.removeLayer(layer);
};

const addControlItem = (map, item) => {
	if (!item || !map) return null;

	let resolved = item;
	if (typeof item === 'function') resolved = item(map);
	if (!resolved) return null;

	const control = resolved?.control ?? resolved;
	if (control?.addTo) control.addTo(map);

	return {
		control,
		cleanup: resolved?.cleanup,
	};
};

const removeControlItem = (map, item) => {
	if (!item) return;
	if (item.cleanup) item.cleanup();
	const control = item.control ?? item;
	if (control?.remove) control.remove();
	else if (control?.removeFrom) control.removeFrom(map);
	else if (map?.removeControl && control) map.removeControl(control);
};

const ZoomControls = ({ mapRef }) => {
	const handleZoom = (delta) => {
		const map = mapRef.get();
		if (!map) return;
		const currentZoom = map.getZoom();
		map.setZoom(currentZoom + delta);
	};

	return <Paper theme="map_zoom" style={{ padding: 8, width: 'max-content', height: 'auto' }}>
		<Button
			type="contained"
			icon={<Icon name="feather:plus" size={20} />}
			onClick={() => handleZoom(1)}
		/>
		<Button
			type="contained"
			icon={<Icon name="feather:minus" size={20} />}
			onClick={() => handleZoom(-1)}
		/>
	</Paper>;
};

export default ThemeContext.use(h => {
	const Map = ({
		center = { lat: 0, lng: 0 },
		zoom = 13,
		bounds = null,
		mapRef = null,
		layers = null,
		controls = null,
		showZoom = true,
		syncCenterFromMap = true,
		tileLayer = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
		tileLayerOptions = { attribution: '&copy; OpenStreetMap contributors' },
		onReady = null,
		onClick = null,
		onMove = null,
		onZoom = null,
		onBoundsChange = null,
		style,
		children,
	}, cleanup, mounted) => {
		const mapContainer = Observer.mutable(null);
		const mapObserver = mapRef instanceof Observer ? mapRef : Observer.mutable(null);
		let leaflet = null;

		const centerObserver = normalizeObserver(center, { lat: 0, lng: 0 }, true);
		const zoomObserver = normalizeObserver(zoom, 13, true);
		const boundsObserver = bounds ? normalizeObserver(bounds, null, true) : null;
		const layersObserver = normalizeListObserver(layers);
		const controlsObserver = normalizeListObserver(controls);

		let syncingFromMap = false;
		let activeLayers = [];
		let activeControls = [];

		const applyLayers = (map, list) => {
			activeLayers.forEach(item => removeLayerItem(map, item));
			activeLayers = [];
			safeList(list).forEach(item => {
				const result = addLayerItem(map, item);
				if (result) activeLayers.push(result);
			});
		};

		const applyControls = (map, list) => {
			activeControls.forEach(item => removeControlItem(map, item));
			activeControls = [];
			safeList(list).forEach(item => {
				const result = addControlItem(map, item);
				if (result) activeControls.push(result);
			});
		};

		mounted(() => {
			if (typeof window === 'undefined') return;
			const container = mapContainer.get();
			if (!container) return;

			let cancelled = false;
			let map = null;

			const handleMove = () => {
				const currentMap = mapObserver.get();
				if (!currentMap) return;

				const nextCenter = currentMap.getCenter();
				const nextBounds = currentMap.getBounds();

				if (syncCenterFromMap && centerObserver && !centerObserver.isImmutable?.()) {
					syncingFromMap = true;
					centerObserver.set({ lat: nextCenter.lat, lng: nextCenter.lng });
					syncingFromMap = false;
				}

				if (boundsObserver && !boundsObserver.isImmutable?.()) {
					syncingFromMap = true;
					boundsObserver.set(nextBounds);
					syncingFromMap = false;
				}

				onMove?.(currentMap);
				onBoundsChange?.(nextBounds, currentMap);
			};

			const handleZoom = () => {
				const currentMap = mapObserver.get();
				if (!currentMap) return;

				const nextZoom = currentMap.getZoom();
				const nextBounds = currentMap.getBounds();

				if (zoomObserver && !zoomObserver.isImmutable?.()) {
					syncingFromMap = true;
					zoomObserver.set(nextZoom);
					syncingFromMap = false;
				}

				onZoom?.(nextZoom, currentMap);
				onBoundsChange?.(nextBounds, currentMap);
			};

			(async () => {
				const module = await import('leaflet');
				await import('leaflet/dist/leaflet.css');
				if (cancelled) return;
				leaflet = module.default ?? module;

				const initialCenter = normalizeLatLng(centerObserver.get());
				const initialZoom = zoomObserver.get() ?? 13;
				map = leaflet.map(container, {
					attributionControl: false,
					zoomControl: false,
				}).setView([initialCenter.lat, initialCenter.lng], initialZoom);

				mapObserver.set(map);

				leaflet.tileLayer(tileLayer, tileLayerOptions).addTo(map);

				map.on('moveend', handleMove);
				map.on('zoomend', handleZoom);
				if (onClick) map.on('click', (event) => onClick(event, map));

				applyLayers(map, layersObserver.get?.() ?? []);
				applyControls(map, controlsObserver.get?.() ?? []);
				onReady?.(map);
			})();

			cleanup(() => {
				cancelled = true;
				if (!map) return;
				activeLayers.forEach(item => removeLayerItem(map, item));
				activeControls.forEach(item => removeControlItem(map, item));
				map.remove();
			});
		});

		cleanup(centerObserver.effect((next) => {
			if (syncingFromMap) return;
			const map = mapObserver.get();
			if (!map) return;

			const value = normalizeLatLng(next, null);
			if (!value) return;

			const current = map.getCenter();
			if (Math.abs(current.lat - value.lat) < 1e-7 && Math.abs(current.lng - value.lng) < 1e-7) return;

			map.setView([value.lat, value.lng], map.getZoom());
		}));

		cleanup(zoomObserver.effect((next) => {
			if (syncingFromMap) return;
			const map = mapObserver.get();
			if (!map) return;
			if (!Number.isFinite(next)) return;
			if (map.getZoom() === next) return;

			map.setZoom(next);
		}));

		if (boundsObserver) cleanup(boundsObserver.effect((next) => {
			if (syncingFromMap) return;
			const map = mapObserver.get();
			if (!map || !next) return;
			map.fitBounds(next);
		}));

		cleanup(layersObserver.effect((next) => {
			const map = mapObserver.get();
			if (!map) return;
			applyLayers(map, next);
		}));

		cleanup(controlsObserver.effect((next) => {
			const map = mapObserver.get();
			if (!map) return;
			applyControls(map, next);
		}));

		return <div theme="map" style={style}>
			<div ref={mapContainer} theme="map_canvas" />
			<div theme="map_overlay">
				<div theme="map_overlay_content">
					<div style={{ pointerEvents: 'auto' }}>{children}</div>
				</div>
				{showZoom ? <ZoomControls mapRef={mapObserver} /> : null}
			</div>
		</div>;
	};

	return Map;
});
