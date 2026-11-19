import { definePlugin, DialogButton, Field, TextField, ToggleField } from 'millennium';
import { useEffect, useMemo, useReducer, useState } from 'react';
import { applyOverrides, getAppName, getRealMinutes, listLibraryApps, startEngine } from './playtime';
import { defaultState, FakyState, loadState, saveState } from './storage';

// ---------------------------------------------------------------------------
// Tiny shared store (plugin runtime <-> settings page)
// ---------------------------------------------------------------------------

let state: FakyState = defaultState();
let loaded = false;
const listeners = new Set<() => void>();

function commit(next: FakyState, persist = true) {
	state = next;
	applyOverrides(state.apps, state.enabled);
	if (persist) saveState(state);
	listeners.forEach((l) => l());
}

function useFakyState(): FakyState {
	const [, rerender] = useReducer((x: number) => x + 1, 0);
	useEffect(() => {
		listeners.add(rerender);
		return () => {
			listeners.delete(rerender);
		};
	}, []);
	return state;
}

function setAppMinutes(appid: number, minutes: number) {
	commit({ ...state, apps: { ...state.apps, [appid]: minutes } });
}

function removeApp(appid: number) {
	const apps = { ...state.apps };
	delete apps[appid];
	commit({ ...state, apps });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatHours(minutes: number | null): string {
	if (minutes === null) return '?';
	const h = Math.round((minutes / 60) * 10) / 10;
	return `${h.toLocaleString()} h`;
}

/** "1337", "12.5", "12,5", "1 000" -> minutes, or null if invalid */
function parseHours(text: string): number | null {
	const cleaned = text.replace(/\s/g, '').replace(',', '.');
	if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
	const h = parseFloat(cleaned);
	return Number.isFinite(h) ? Math.round(h * 60) : null;
}

const ClockIcon = () => (
	<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
		<circle cx="12" cy="12" r="9" />
		<path d="M12 7v5l3 2" />
	</svg>
);

// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------

const HoursInput = ({ appid, minutes }: { appid: number; minutes: number }) => {
	const [text, setText] = useState(String(Math.round((minutes / 60) * 10) / 10));
	const valid = parseHours(text) !== null;

	return (
		<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
			<div style={{ width: 120 }}>
				<TextField
					value={text}
					onChange={(e) => {
						const v = e.target.value;
						setText(v);
						const m = parseHours(v);
						if (m !== null) setAppMinutes(appid, m);
					}}
					style={valid ? undefined : { outline: '1px solid #c33' }}
				/>
			</div>
			<span style={{ opacity: 0.7 }}>hours</span>
			<DialogButton style={{ minWidth: 0, width: 'auto', padding: '0 12px' }} onClick={() => removeApp(appid)}>
				Remove
			</DialogButton>
		</div>
	);
};

const AddGame = ({ existing }: { existing: Record<string, number> }) => {
	const [query, setQuery] = useState('');
	const library = useMemo(() => listLibraryApps(), []);

	const results = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		const out: { appid: number; name: string }[] = [];

		if (/^\d+$/.test(q)) {
			const appid = Number(q);
			out.push({ appid, name: getAppName(appid) ?? `App ${appid}` });
		}
		for (const app of library) {
			if (out.length >= 8) break;
			if (app.name.toLowerCase().includes(q) && !out.some((o) => o.appid === app.appid)) out.push(app);
		}
		return out.filter((r) => !(String(r.appid) in existing));
	}, [query, library, existing]);

	return (
		<>
			<TextField
				label="Add a game"
				description="Type a game name from your library, or an App ID."
				value={query}
				onChange={(e) => setQuery(e.target.value)}
			/>
			{results.map((r) => (
				<Field key={r.appid} label={r.name} description={`App ID ${r.appid} · real: ${formatHours(getRealMinutes(r.appid))}`} indentLevel={1}>
					<DialogButton
						style={{ minWidth: 0, width: 'auto', padding: '0 16px' }}
						onClick={() => {
							setAppMinutes(r.appid, getRealMinutes(r.appid) ?? 0);
							setQuery('');
						}}
					>
						Add
					</DialogButton>
				</Field>
			))}
		</>
	);
};

const SettingsContent = () => {
	const s = useFakyState();
	const entries = Object.entries(s.apps)
		.map(([id, minutes]) => ({ appid: Number(id), minutes, name: getAppName(Number(id)) ?? `App ${id}` }))
		.sort((a, b) => a.name.localeCompare(b.name));

	if (!loaded) return <Field label="Loading FakyTime settings…" />;

	return (
		<>
			<ToggleField
				label="Show fake playtime"
				description="Changes the hours shown in your Steam library on this PC only. Steam's servers, your profile and your friends still see your real playtime."
				checked={s.enabled}
				onChange={(checked) => commit({ ...s, enabled: checked })}
			/>

			<AddGame existing={s.apps} />

			{entries.length === 0 ? (
				<Field label="No games yet" description="Add a game above, then type the hours you want the library to show." />
			) : (
				entries.map((e) => (
					<Field key={e.appid} label={e.name} description={`App ID ${e.appid} · real: ${formatHours(getRealMinutes(e.appid))}`}>
						<HoursInput appid={e.appid} minutes={e.minutes} />
					</Field>
				))
			)}
		</>
	);
};

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

async function initializePlugin() {
	startEngine();
	const saved = await loadState();
	loaded = true;
	commit(saved, false);
	console.log('[FakyTime] loaded', Object.keys(saved.apps).length, 'override(s), enabled:', saved.enabled);
}

export default definePlugin(() => {
	initializePlugin();

	return {
		title: 'FakyTime',
		icon: <ClockIcon />,
		content: <SettingsContent />,
	};
});
