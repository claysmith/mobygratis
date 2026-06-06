# Development Notes

## MobyGratis API Internals

### Search HTML Parsing
`POST /api/search` returns HTML tables. Track UUIDs are extracted from Alpine.js `@click` attributes:

```html
<button @click="$store.player.play('uuid-here', 'Track Title')">▶</button>
<button @click="$store.player.queueTrack('uuid-here', 'Track Title')">+</button>
```

The regex `/\$store\.player\.(?:play|queueTrack)\("([^"]+)"/` extracts the UUID from either `play()` or `queueTrack()` calls.

### Download Flow
1. `POST /api/fetch` with `id=<uuid>&format=WAV` (uppercase format!) + Firebase Bearer token
2. Response is HTML with `<a href="...">` containing a pre-signed Cloudflare R2 URL (valid ~600s)
3. HTML entities in the URL (`&#x2F;` → `/`, `&amp;` → `&`) must be decoded via `decodeHtmlEntities()`
4. Download the URL → validate magic bytes (`RIFF` = WAV, `FORM` = AIFF)

### Preview Flow
1. `GET /api/preview/<uuid>` with Firebase Bearer token
2. Response is **plain text** — the pre-signed Cloudflare R2 audio URL
3. No HTML parsing needed; the URL can be set directly on an `<audio>` element
4. R2 URLs support range requests and CORS, so they play directly in the WebView

### Player Store (Alpine.js)
MobyGratis uses a global `alpine.store('player', { ... })` with:

| Property/Method | Behavior |
|---|---|
| `play(uuid, title)` | Plays a track; shows sign-in dialog if not authenticated |
| `queueTrack(uuid, title)` | Adds to queue or plays immediately if nothing is playing |
| `playPause()` | Toggles play/pause on the current Bi (MediaPlayer) instance |
| `next()` | Plays next queued track |
| `close()` | Stops and hides player |
| `show`, `playing`, `loading` | Reactive state booleans |

The `play()` method:
1. Awaits `fbAuth.authStateReady()`
2. Gets Firebase idToken via `fbAuth.currentUser?.getIdToken()`
3. If no token, fetches `/dialog/signin` and shows sign-in modal
4. Fetches `/api/player-buttons` (POST with `id=<uuid>` + Bearer) for UI
5. Fetches `/api/preview/<uuid>` (GET + Bearer) for audio URL
6. Loads URL into `Bi` (MediaPlayer instance from live-radio-broadcaster library)

## Local Server Proxy Endpoints

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/search` | Proxies directly; WebView sends `application/x-www-form-urlencoded` body |
| POST | `/api/verify-magic-link` | Reads JSON `{ email, link }`, calls Firebase REST API |
| GET | `/api/auth-status` | Returns `{ signedIn: bool, email: string|null }` |
| POST | `/api/sign-out` | Nulls `authToken` and `authEmail` |
| GET | `/api/tracks` | Filters via `dataModel.getObjectIsOfClass(t.handle, "AudioTrack")` in Live API |
| GET | `/api/preview/<uuid>` | Returns raw URL as `text/plain`; requires auth |

## WebView State Management

### Play Button
- Each play button has `data-uuid` for targeted state updates
- `currentPreviewId` tracks which UUID is currently playing
- `setPlayButton(uuid, playing)` updates a specific button's icon (▶ / ■) and `playing` class
- `onended` and `onerror` handlers close over the UUID at call time to reset the correct button

### Auth-Dependent Controls
Both Import and Play buttons are disabled when `!isSignedIn`. `updateImportButtons()` toggles both sets — called after successful sign-in, sign-out, and initial `restoreAuth()`.

## ExtensionHost Sandbox Quirks

### Stripped Globals
`fetch`, `URL`, `URLSearchParams`, `AbortController`, `Request`, `Response` are all undefined in the ExtensionHost runtime. The `node:url` module gets tree-shaken by esbuild (it resolves to a browser polyfill stub). Use only `node:https`, `node:http`, `node:fs/promises`, etc.

### Custom URL Parsing
```js
function parseUrl(url) {
  const match = url.match(/^https?:\/\/([^:\/]+)(?::(\d+))?(\/.*)?$/);
  return {
    hostname: match[1],
    port: match[2] || (url.startsWith("https") ? "443" : "80"),
    path: match[3] || "/",
  };
}
```

### Query String Building
```js
function qs(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}
```

### Console Output
`console.log/warn/error` goes to the Live Extension Host log file (`ExtensionHost.txt`). Use it freely for debugging.

## Ableton Live 12 Beta Track Issues

- Existing (pre-saved) audio tracks resolve as the `Track` base class in the Live API
- `dataModel.getObjectIsOfClass(t.handle, "AudioTrack")` returns `false` for these tracks
- `ClipSlot.createAudioClip()` also fails on these tracks ("Failed to create clip")
- Freshly-created tracks via `song.createAudioTrack()` DO resolve as `AudioTrack` and work correctly

**Workaround**: Always filter with native `getObjectIsOfClass`; fall back to creating a new track if clip slot creation fails on the selected track.

## AIFF Handling

Some MobyGratis downloads return AIFF files (magic bytes `FORM`) instead of WAV (`RIFF`). The extension:
1. Checks leading 4 bytes after download
2. Saves with `.aiff` extension for AIFF files
3. Live imports both formats correctly via `context.resources.importIntoProject()`

## Build Pipeline

`build.ts` uses esbuild with:
- `platform: "node"` — targets Node.js runtime
- `format: "cjs"` — CommonJS output (ExtensionHost requires CJS)
- `loader: { ".html": "text" }` — inlines HTML as string
- Minification in production mode

HTML is served from a local HTTP server instead of `data:` URLs because `data:` URLs have opaque `null` origins that break CORS with MobyGratis APIs.
