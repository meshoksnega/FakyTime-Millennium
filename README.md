# FakyTime

A Millennium plugin that shows custom ("fake") playtime hours for games in your **local** Steam library.

It's purely cosmetic and local. Steam's servers, your profile, the store pages and your friends still see your real playtime.

## Requirements

- Millennium >= v3.4.0
- Node.js (npm). The upstream template uses Bun, but npm works too.

## Build & install

```powershell
npm install
npm run build
```

`starlight pack` compiles the plugin and installs it into `Steam\millennium\plugins\fakytime.star`. Then:

1. Open Steam → **Millennium** settings → **Plugins** and enable **FakyTime**. Restart Steam if it asks.
2. Open FakyTime's settings page, search for a game, click **Add**, then type the hours you want shown.

For live development, run `npm run dev`. It rebuilds and reloads on every save.

## How it works

The Steam library reads playtime from in-memory stores in the client UI:

| Store | Property | Used by |
| --- | --- | --- |
| `appStore` overview | `minutes_playtime_forever` | Header "Play/Usage time" box, hover cards, sort by hours played |
| `appDetailsStore` details | `nPlaytimeForever` | Game details page |

For each configured game, `frontend/playtime.ts` pins those properties to your value:

1. **MobX box wrap (normal path):** Steam's stores are MobX observables. Each property is backed by an `ObservableValue` in the object's MobX administration (`adm.values_`). The plugin wraps that box's `get()`, so reads return your value while Steam's writes still update the real one. The store object itself is never redefined. Doing that on a MobX *proxy* breaks MobX and crashes the game page, which is what happened in v1.0.0.
2. **Getter wrapper:** used only for plain, non-MobX objects.
3. **Assign and re-apply:** last resort. The plugin writes the value directly and writes it again whenever Steam overwrites it.

Settings are stored in Millennium's plugin config, with a localStorage backup.

## Troubleshooting

Check `Steam\millennium\logs\fakytime_log.log`. Each pinned value logs a line like
`[FakyTime] app 365670: minutes_playtime_forever -> 62520 min (mode: accessor, real: 62520)`.
