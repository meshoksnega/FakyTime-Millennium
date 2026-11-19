import { pluginConfig } from 'millennium';

export interface FakyState {
	enabled: boolean;
	/** appid -> fake playtime in minutes */
	apps: Record<string, number>;
}

const CONFIG_KEY = 'state';
const LOCAL_KEY = 'fakytime.state.v1';

export const defaultState = (): FakyState => ({ enabled: true, apps: {} });

function sanitize(raw: any): FakyState | null {
	if (!raw || typeof raw !== 'object') return null;
	const apps: Record<string, number> = {};
	if (raw.apps && typeof raw.apps === 'object') {
		for (const [k, v] of Object.entries(raw.apps)) {
			const n = Number(v);
			if (/^\d+$/.test(k) && Number.isFinite(n) && n >= 0) apps[k] = n;
		}
	}
	return { enabled: raw.enabled !== false, apps };
}

/** Load from Millennium's plugin config, falling back to localStorage. */
export async function loadState(): Promise<FakyState> {
	try {
		const raw = await pluginConfig.get<unknown>(CONFIG_KEY);
		const fromConfig = sanitize(typeof raw === 'string' ? JSON.parse(raw) : raw);
		if (fromConfig) return fromConfig;
	} catch (e) {
		console.warn('[FakyTime] pluginConfig.get failed, using localStorage', e);
	}
	try {
		const raw = localStorage.getItem(LOCAL_KEY);
		const fromLocal = raw ? sanitize(JSON.parse(raw)) : null;
		if (fromLocal) return fromLocal;
	} catch {
		/* ignore */
	}
	return defaultState();
}

/** Save to both places so a failure in one doesn't lose your settings. */
export async function saveState(state: FakyState): Promise<void> {
	try {
		localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
	} catch {
		/* ignore */
	}
	try {
		await pluginConfig.set(CONFIG_KEY, JSON.stringify(state));
	} catch (e) {
		console.warn('[FakyTime] pluginConfig.set failed (saved to localStorage only)', e);
	}
}
