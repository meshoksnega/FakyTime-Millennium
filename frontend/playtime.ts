/**
 * Playtime override engine.
 *
 * Steam's library UI reads playtime from two in-memory objects:
 *   - appStore overview   -> `minutes_playtime_forever`  (header box, hover cards, sorting, filters)
 *   - appDetailsStore     -> `nPlaytimeForever`          (game details page)
 *
 * For every configured app we "pin" those properties to a fake value. The preferred
 * way is to wrap the property in a getter/setter (Steam's own writes still go through,
 * so the real value is kept and MobX reactivity keeps working). If that isn't allowed
 * on this Steam build, we fall back to assigning the value and re-applying it whenever
 * Steam overwrites it.
 *
 * Everything lives in this Steam client's memory only. Nothing is sent anywhere.
 */

const LOG = '[FakyTime]';
const SWEEP_MS = 750;

type Mode = 'mobx' | 'accessor' | 'assign';

interface Pin {
	obj: any;
	key: string;
	mode: Mode;
	fake: number;
	/** Real value as Steam knows it (kept up to date). */
	readReal(): number;
	/** Undo the override and put the real value back. */
	restore(): void;
	/** Make MobX observers (React components) re-render. */
	nudge(): void;
	/** assign-mode only: re-apply if Steam overwrote the value. */
	reapply(): void;
}

const pinsByApp = new Map<number, Pin[]>();
let wanted = new Map<number, number>(); // appid -> fake minutes
let enabled = true;
let timer: number | undefined;

// ---------------------------------------------------------------------------
// Steam store access (all defensive: internals change between client builds)
// ---------------------------------------------------------------------------

function getOverview(appid: number): any | null {
	try {
		return (window as any).appStore?.GetAppOverviewByAppID?.(appid) ?? null;
	} catch {
		return null;
	}
}

function getDetails(appid: number): any | null {
	try {
		const store = (window as any).appDetailsStore;
		return store?.GetAppDetails?.(appid) ?? store?.GetAppData?.(appid)?.details ?? null;
	} catch {
		return null;
	}
}

export function storesReady(): boolean {
	return !!(window as any).appStore?.GetAppOverviewByAppID;
}

export interface LibraryApp {
	appid: number;
	name: string;
	minutes: number;
}

/** All apps in the user's library (best effort), used for the search box. */
export function listLibraryApps(): LibraryApp[] {
	const w = window as any;
	let apps: any[] = [];
	try {
		apps = w.collectionStore?.allAppsCollection?.allApps ?? w.appStore?.allApps ?? [];
	} catch {
		apps = [];
	}
	const out: LibraryApp[] = [];
	for (const ov of apps) {
		if (!ov || typeof ov.appid !== 'number') continue;
		out.push({ appid: ov.appid, name: ov.display_name ?? `App ${ov.appid}`, minutes: getRealMinutes(ov.appid) ?? 0 });
	}
	return out;
}

export function getAppName(appid: number): string | null {
	return getOverview(appid)?.display_name ?? null;
}

/** Real playtime in minutes (ignores our override), or null if unknown. */
export function getRealMinutes(appid: number): number | null {
	const pin = pinsByApp.get(appid)?.find((p) => p.key === 'minutes_playtime_forever');
	if (pin) return pin.readReal();
	const v = getOverview(appid)?.minutes_playtime_forever;
	return typeof v === 'number' ? v : null;
}

// ---------------------------------------------------------------------------
// Pinning
// ---------------------------------------------------------------------------

function findDescriptor(obj: any, key: string): { desc: PropertyDescriptor; own: boolean } | null {
	let cur = obj;
	while (cur) {
		const desc = Object.getOwnPropertyDescriptor(cur, key);
		if (desc) return { desc, own: cur === obj };
		cur = Object.getPrototypeOf(cur);
	}
	return null;
}

/** MobX stores its bookkeeping under a symbol named "mobx administration". */
function getMobxAdmin(obj: any): any | null {
	try {
		for (const s of Object.getOwnPropertySymbols(obj)) {
			if (s.description === 'mobx administration') return obj[s];
		}
	} catch {
		/* ignore */
	}
	return null;
}

/**
 * Preferred path for MobX observables (Steam's stores are MobX).
 * Each observable prop is backed by an ObservableValue "box" in `adm.values_`.
 * We wrap that box's `get()` so reads return the fake value, while Steam's writes
 * still update the real value and MobX reactivity stays intact. The object itself
 * (possibly a Proxy) is never redefined, which is what crashed v1.0.0.
 */
function tryMobxPin(obj: any, key: string, fake: number): Pin | null {
	const adm = getMobxAdmin(obj);
	let box: any;
	try {
		box = adm?.values_?.get?.(key);
	} catch {
		return null;
	}
	if (!box || typeof box.get !== 'function' || !('value_' in box)) return null;
	if (Object.prototype.hasOwnProperty.call(box, 'get')) return null; // already wrapped by someone

	const origGet = box.get;
	const pin: Pin = {
		obj,
		key,
		mode: 'mobx',
		fake,
		readReal: () => box.value_,
		restore() {
			try {
				delete box.get;
			} catch (e) {
				console.warn(LOG, 'restore failed for', key, e);
			}
			pin.nudge();
		},
		nudge() {
			try {
				box.reportChanged?.();
			} catch {
				/* ignore */
			}
		},
		reapply() {},
	};

	box.get = function (this: any, ...args: any[]) {
		let real: any;
		try {
			real = origGet.apply(this, args);
		} catch (e) {
			if (enabled) return pin.fake;
			throw e;
		}
		return enabled ? pin.fake : real;
	};

	let ok = false;
	try {
		ok = obj[key] === fake;
	} catch {
		ok = false;
	}
	if (!ok) {
		pin.restore();
		return null;
	}
	return pin;
}

/** For plain (non-MobX) objects only. Never used on MobX proxies. */
function tryAccessorPin(obj: any, key: string, fake: number): Pin | null {
	if (getMobxAdmin(obj)) return null;
	const found = findDescriptor(obj, key);
	if (!found) return null;
	const { desc, own } = found;
	if (own && desc.configurable === false) return null;

	let readReal: () => number;
	let writeReal: (v: number) => void;
	if (desc.get || desc.set) {
		readReal = () => desc.get?.call(obj);
		writeReal = (v) => desc.set?.call(obj, v);
	} else {
		let value = desc.value;
		readReal = () => value;
		writeReal = (v) => {
			value = v;
		};
	}

	const pin: Pin = {
		obj,
		key,
		mode: 'accessor',
		fake,
		readReal,
		restore() {
			try {
				if (own) {
					Object.defineProperty(obj, key, desc.get || desc.set ? desc : { ...desc, value: readReal() });
				} else {
					delete obj[key];
				}
			} catch (e) {
				console.warn(LOG, 'restore failed for', key, e);
			}
			pin.nudge();
		},
		nudge() {
			if (!(desc.get || desc.set)) return;
			try {
				const r = readReal();
				if (typeof r === 'number') {
					writeReal(r + 1);
					writeReal(r);
				}
			} catch {
				/* ignore */
			}
		},
		reapply() {},
	};

	try {
		Object.defineProperty(obj, key, {
			configurable: true,
			enumerable: desc.enumerable ?? true,
			get() {
				if (enabled) return pin.fake;
				return readReal();
			},
			set(v: number) {
				try {
					writeReal(v);
				} catch {
					/* ignore */
				}
			},
		});
	} catch {
		return null;
	}

	// Some objects accept the define but ignore it. Verify.
	let ok = false;
	try {
		ok = obj[key] === fake;
	} catch {
		ok = false;
	}
	if (!ok) {
		pin.restore();
		return null;
	}
	return pin;
}

function assignPin(obj: any, key: string, fake: number): Pin {
	let real = obj[key];
	const pin: Pin = {
		obj,
		key,
		mode: 'assign',
		fake,
		readReal: () => {
			const cur = obj[key];
			if (cur !== pin.fake) real = cur; // Steam updated it
			return real;
		},
		restore() {
			try {
				obj[key] = pin.readReal();
			} catch (e) {
				console.warn(LOG, 'restore failed for', key, e);
			}
		},
		nudge() {},
		reapply() {
			const cur = obj[key];
			if (!enabled) {
				if (cur === pin.fake && cur !== real) obj[key] = real;
				return;
			}
			if (cur !== pin.fake) {
				real = cur;
				obj[key] = pin.fake;
			}
		},
	};
	try {
		obj[key] = fake;
	} catch (e) {
		console.warn(LOG, 'assign failed for', key, e);
	}
	return pin;
}

function pin(appid: number, obj: any, key: string, fake: number) {
	if (!obj || !(key in obj)) return;
	const list = pinsByApp.get(appid) ?? [];

	// Already pinned on this exact object?
	const existing = list.find((p) => p.obj === obj && p.key === key);
	if (existing) {
		if (existing.fake !== fake) {
			existing.fake = fake;
			existing.mode === 'assign' ? existing.reapply() : existing.nudge();
		} else if (existing.mode === 'assign') {
			existing.reapply();
		}
		return;
	}

	// Steam replaced the object -> drop pins pointing at the stale one.
	const stale = list.filter((p) => p.key === key && p.obj !== obj);
	for (const s of stale) list.splice(list.indexOf(s), 1);

	let p = tryMobxPin(obj, key, fake) ?? tryAccessorPin(obj, key, fake);
	if (p) p.nudge();
	else p = assignPin(obj, key, fake);

	console.log(LOG, `app ${appid}: ${key} -> ${fake} min (mode: ${p.mode}, real: ${p.readReal()})`);
	list.push(p);
	pinsByApp.set(appid, list);
}

function unpinApp(appid: number) {
	const list = pinsByApp.get(appid);
	if (!list) return;
	for (const p of list) p.restore();
	pinsByApp.delete(appid);
	console.log(LOG, `app ${appid}: restored real playtime`);
}

function sweep() {
	if (!storesReady()) return;

	// Remove overrides for apps no longer configured.
	for (const appid of [...pinsByApp.keys()]) {
		if (!wanted.has(appid)) unpinApp(appid);
	}

	for (const [appid, minutes] of wanted) {
		pin(appid, getOverview(appid), 'minutes_playtime_forever', minutes);
		pin(appid, getDetails(appid), 'nPlaytimeForever', minutes);
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Replace the full set of overrides. `apps` maps appid -> fake minutes. */
export function applyOverrides(apps: Record<string, number>, isEnabled: boolean) {
	const next = new Map<number, number>();
	for (const [id, minutes] of Object.entries(apps)) {
		const appid = Number(id);
		if (Number.isFinite(appid) && Number.isFinite(minutes) && minutes >= 0) next.set(appid, Math.round(minutes));
	}

	const enabledChanged = enabled !== isEnabled;
	wanted = isEnabled ? next : new Map();
	enabled = isEnabled;

	if (enabledChanged) {
		for (const list of pinsByApp.values()) for (const p of list) p.mode === 'assign' ? p.reapply() : p.nudge();
	}
	sweep();
}

export function startEngine() {
	if (timer !== undefined) return;
	sweep();
	timer = window.setInterval(sweep, SWEEP_MS);
}
