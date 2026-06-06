# mobygratis

An Ableton Live extension for browsing and importing tracks from [MobyGratis](https://mobygratis.com) directly into your Live Set.

## Architecture

### Extension Host
- Entry: `src/extension.ts`, bundled to `dist/extension.js`
- Registers a context-menu action "MobyGratis: browse & import" on scopes: `AudioClip`, `AudioTrack`, `MidiTrack`, `ClipSlot`, `Scene`
- Opens a WebView modal dialog served from a local HTTP server (`http://127.0.0.1:PORT/`)
- All HTTP requests to MobyGratis APIs are proxied through the local server (ExtensionHost sandbox strips Web API globals like `fetch`, `URL`, `URLSearchParams`)

### Local HTTP Server
Created in `startServer()` on a random port. Endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Serves the dialog HTML (replaces `__API_BASE__` placeholder) |
| GET | `/api/tracks` | Lists audio tracks in the Live Set (filtered via native `getObjectIsOfClass`) |
| GET | `/api/auth-status` | Returns `{ signedIn, email }` from stored Firebase idToken |
| POST | `/api/verify-magic-link` | Verifies Firebase email magic link, stores idToken |
| POST | `/api/sign-out` | Clears auth token |
| GET | `/api/preview/<uuid>` | Proxies to `https://mobygratis.com/api/preview/<uuid>` with Bearer token, returns pre-signed audio URL as plain text |
| POST | `/api/search` | Proxies to `https://mobygratis.com/api/search` |

### Authentication
- Firebase email magic link auth via Identity Toolkit REST API (`accounts:sendOobCode` + `accounts:signInWithEmailLink`)
- Token stored as module-level `authToken` (non-anonymous Firebase idToken)
- Anonymous tokens rejected by MobyGratis server

### Track Import Flow
1. User clicks Import in the dialog
2. Dialog sends `{ action: "import", slug, uuid, format }` via `closeWithResult`
3. `importTrack()` calls `POST https://mobygratis.com/api/fetch` with `id=<uuid>&format=WAV` + Bearer token
4. Parses response HTML for `<a href="...">` to get pre-signed Cloudflare R2 download URL
5. Downloads audio file via `getFile()` (supports `RIFF`/WAV and `FORM`/AIFF)
6. Imports into Live project via `context.resources.importIntoProject()`
7. Creates session clip: tries selected track's first empty clip slot; falls back to creating a new audio track
8. All steps wrapped in `withinProgressDialog` with abort support

### Track Preview
- Play button (▶) in track listing fetches `GET /api/preview/<uuid>` → proxies to `https://mobygratis.com/api/preview/<uuid>` with Bearer token → returns pre-signed Cloudflare R2 audio URL
- URL is set on a hidden `<audio>` element in the WebView for playback
- Clicking the same button again stops playback; clicking another track switches playback
- Requires sign-in (same as import)

## Key SDK Quirks

### ExtensionHost Sandbox
Node.js globals stripped: `fetch`, `URL`, `URLSearchParams`, `AbortController`.
Use `node:https` for HTTP, manual URL parsing via `parseUrl()`, custom query-string building via `qs()`.

### Track Type Resolution
Live 12 beta resolves existing audio tracks as `Track` base class (not `AudioTrack`) — `getObjectIsOfClass(handle, "AudioTrack")` returns false for pre-existing tracks. Freshly-created tracks via `song.createAudioTrack()` DO resolve as `AudioTrack`.

Workaround: filter tracks by calling `dataModel.getObjectIsOfClass()` directly, and fall back to creating a new track if clip slot creation fails on the selected track.

### File Format Detection
Some MobyGratis tracks return AIFF (starts with `FORM`) instead of WAV (`RIFF`). The download saves with `.aiff` extension and Live imports it correctly.

### Firebase
- API key: `AIzaSyCTwaxUqAP88DzfAkhVaaYAdpmfl_hh5wc`
- Auth domain: `mobygratis-2945d.firebaseapp.com`
- Uses `identitytoolkit.googleapis.com/v1` REST endpoints

## Build & Run

```sh
npm run build         # production bundle
npm run build:dev     # dev bundle with sourcemaps
npm start             # build + run in Extension Host
npm run package       # build + create .ablx archive
```

Extension Host path: `/Applications/Ableton Live 12 Beta.app/Contents/Helpers/ExtensionHost/ExtensionHostNodeModule.node`

## Dependency Versions

- `@ableton-extensions/sdk`: `^1.0.0-beta.0`
- Node.js: `>=24.14.1`
- ESM project (TypeScript), CJS bundle via esbuild (`platform: node`, `format: cjs`)
- HTML inlined via esbuild `loader: { ".html": "text" }`
