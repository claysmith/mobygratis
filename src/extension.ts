import { createServer, type Server } from "node:http";
import https from "node:https";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { initialize, type ActivationContext } from "@ableton-extensions/sdk";
import bundledInterface from "../ui/interface.html";

const FIREBASE_API_KEY = "AIzaSyCTwaxUqAP88DzfAkhVaaYAdpmfl_hh5wc";
const FIREBASE_AUTH_URL = "https://identitytoolkit.googleapis.com/v1";

let authToken: string | null = null;
let authEmail: string | null = null;
let authExpireTimer: ReturnType<typeof setTimeout> | null = null;
let server: Server | null = null;
let appContext: ReturnType<typeof initialize> | null = null;

function extractParam(url: string, name: string): string | null {
  const match = url.match(new RegExp(`[?&]${name}=([^&]*)`));
  return match ? decodeURIComponent(match[1].replace(/\+/g, " ")) : null;
}

function qs(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&#x2F;/g, "/").replace(/&amp;/g, "&");
}

function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function parseUrl(url: string): { hostname: string; port: string; path: string } {
  const match = url.match(/^https?:\/\/([^:\/]+)(?::(\d+))?(\/.*)?$/);
  if (!match) throw new Error(`Invalid URL: ${url}`);
  return {
    hostname: match[1],
    port: match[2] || (url.startsWith("https") ? "443" : "80"),
    path: match[3] || "/",
  };
}

async function postText(
  url: string,
  contentType: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const u = parseUrl(url);
  return new Promise((resolve, reject) => {
    const opts: https.RequestOptions = {
      hostname: u.hostname,
      port: u.port,
      path: u.path,
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "Content-Length": Buffer.byteLength(body).toString(),
        ...headers,
      },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, text: data }),
      );
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function getText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const u = parseUrl(url);
  return new Promise((resolve, reject) => {
    const opts: https.RequestOptions = {
      hostname: u.hostname,
      port: u.port,
      path: u.path,
      method: "GET",
      headers,
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.end();
  });
}

async function getFile(url: string): Promise<Buffer> {
  const u = parseUrl(url);
  return new Promise((resolve, reject) => {
    const opts: https.RequestOptions = {
      hostname: u.hostname,
      port: u.port,
      path: u.path,
      method: "GET",
      timeout: 300000,
    };
    const req = https.request(opts, (res) => {
      // Follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log(`MobyGratis: getFile redirect ${res.statusCode} -> ${res.headers.location}`);
        req.destroy();
        resolve(getFile(res.headers.location));
        return;
      }
      console.log(`MobyGratis: getFile status=${res.statusCode}, content-length=${res.headers["content-length"]}`);
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const total = chunks.reduce((s, c) => s + c.length, 0);
        console.log(`MobyGratis: getFile received ${total} bytes`);
        resolve(Buffer.concat(chunks));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Download timeout")); });
    req.end();
  });
}

async function verifyMagicLink(email: string, link: string) {
  const oobCode = extractParam(link, "oobCode");
  if (!oobCode) {
    throw new Error("No oobCode in magic link");
  }

  const verifyRes = await postText(
    `${FIREBASE_AUTH_URL}/accounts:signInWithEmailLink?key=${FIREBASE_API_KEY}`,
    "application/json",
    JSON.stringify({ email, oobCode, returnSecureToken: true }),
  );

  if (verifyRes.status !== 200) {
    throw new Error(`Verification failed: ${verifyRes.text}`);
  }

  const tokenData = JSON.parse(verifyRes.text) as { idToken: string; refreshToken: string; email: string };
  authToken = tokenData.idToken;
  authEmail = tokenData.email;

  // Auto sign-out when the Firebase idToken expires
  if (authExpireTimer) clearTimeout(authExpireTimer);
  const payload = decodeJwtPayload(tokenData.idToken);
  if (payload?.exp) {
    const expiresInMs = payload.exp * 1000 - Date.now();
    if (expiresInMs > 0) {
      authExpireTimer = setTimeout(() => {
        authToken = null;
        authEmail = null;
        authExpireTimer = null;
        console.log("MobyGratis: session expired, auto signed out");
      }, expiresInMs);
    }
  }

  console.log(`MobyGratis: signed in as ${authEmail}`);
}

async function createSessionClip(
  targetTrack: any,
  filePath: string,
): Promise<any> {
  const slots = targetTrack.clipSlots as any[];
  let slot = slots.find((s: any) => !s.clip);
  if (!slot) {
    slot = slots[0];
    if (slot?.clip) await slot.deleteClip();
  }
  return slot.createAudioClip({ filePath, isWarped: false });
}

async function importTrack(
  context: ReturnType<typeof initialize>,
  slug: string,
  uuid: string,
  format: string,
  targetTrackIndex: number,
) {
  try {
    if (!authToken) throw new Error("Not signed in. Use sign-in first.");
    const tempDir = context.environment.tempDirectory || tmpdir();
    const safeSlug = slug.replace(/[^a-z0-9-]/g, "");
    const ext = format === "MP3" ? "mp3" : "wav";
    const filePath = `${tempDir}/${safeSlug}.${ext}`;

    const targetTrack = context.application.song.tracks[targetTrackIndex];
    if (!targetTrack) throw new Error(`Track ${targetTrackIndex} not found`);

    await context.ui.withinProgressDialog(
      "Downloading…",
      { progress: 0 },
      async (update, signal) => {
        const headers: Record<string, string> = {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Bearer ${authToken}`,
        };

        await update("Fetching download link…", 5);
        if (signal.aborted) return;

        console.log(`MobyGratis: fetching download link for ${uuid} (${format})`);
        const fetchRes = await postText(
          "https://mobygratis.com/api/fetch",
          "application/x-www-form-urlencoded",
          `id=${encodeURIComponent(uuid)}&format=${encodeURIComponent(format)}`,
          headers,
        );

        if (fetchRes.status !== 200) {
          throw new Error(`Fetch failed: ${fetchRes.status} ${fetchRes.text.slice(0, 200)}`);
        }

        const hrefMatch = fetchRes.text.match(/href="([^"]+)"/);
        if (!hrefMatch) {
          throw new Error(`No download URL in response: ${fetchRes.text.slice(0, 300)}`);
        }

        const downloadUrl = decodeHtmlEntities(hrefMatch[1]);

        await update("Downloading audio file…", 10);
        if (signal.aborted) return;

        console.log(`MobyGratis: downloading from ${downloadUrl.substring(0, 80)}...`);
        const audioData = await getFile(downloadUrl);

        const fmt = audioData.toString("ascii", 0, 4);
        if (fmt !== "RIFF" && fmt !== "FORM") {
          throw new Error(
            `Downloaded non-audio data (${audioData.length} bytes, first=${audioData.toString("ascii", 0, 20)})`,
          );
        }

        await update("Importing into project…", 60);
        if (signal.aborted) return;

        const actualExt = fmt === "FORM" ? "aiff" : ext;
        const actualPath = actualExt === ext ? filePath : `${tempDir}/${safeSlug}.${actualExt}`;
        await writeFile(actualPath, audioData);
        console.log(`MobyGratis: wrote ${actualPath} (${audioData.length} bytes)`);

        const imported = await context.resources.importIntoProject(actualPath);
        console.log(`MobyGratis: imported to ${imported}`);

        await update("Creating clip…", 80);
        if (signal.aborted) return;

        try {
          const clip = await createSessionClip(targetTrack, imported);
          console.log(`MobyGratis: created clip ${clip.name} on track ${targetTrackIndex}`);
        } catch (slotErr) {
          console.log(`MobyGratis: session slot failed on track ${targetTrackIndex}, creating new track:`, slotErr);
          const newTrack = await context.application.song.createAudioTrack();
          const clip = await newTrack.clipSlots[0].createAudioClip({ filePath: imported, isWarped: false });
          console.log(`MobyGratis: created clip ${clip.name} on new track`);
        }
      },
    );
  } catch (err) {
    console.error("MobyGratis: import failed", err);
  }
}

async function startServer(html: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer((req, res) => {
      const pathname = (req.url ?? "/").split("?")[0].split("#")[0];

      if (req.method === "GET" && (pathname === "/" || pathname === "")) {
        const host = req.headers.host ?? "127.0.0.1";
        const served = html.replace("__API_BASE__", `http://${host}`);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(served);
        return;
      }

      if (req.method === "GET" && pathname === "/api/tracks" && appContext) {
        (async () => {
          try {
            const allTracks = appContext!.application.song.tracks;
            const tracks = allTracks
              .map((t, i) => ({ t, i }))
              .filter(({ t }) => (t as any).dataModel?.getObjectIsOfClass?.(t.handle, "AudioTrack"))
              .map(({ i }) => ({
                index: i,
                name: allTracks[i].name || `Track ${i + 1}`,
              }));

            if (tracks.length === 0) {
              const newTrack = await appContext!.application.song.createAudioTrack();
              const all = appContext!.application.song.tracks;
              const newIdx = all.indexOf(newTrack);
              tracks.push({
                index: newIdx >= 0 ? newIdx : all.length - 1,
                name: newTrack.name || `Track ${all.length}`,
              });
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(tracks));
          } catch (err: any) {
            console.error("MobyGratis: tracks error", err);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
        })();
        return;
      }

      if (req.method === "POST" && pathname === "/api/verify-magic-link") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", async () => {
          try {
            const { email, link } = JSON.parse(body);
            await verifyMagicLink(email, link);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, email }));
          } catch (err: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/sign-out") {
        authToken = null;
        authEmail = null;
        if (authExpireTimer) { clearTimeout(authExpireTimer); authExpireTimer = null; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "GET" && pathname === "/api/auth-status" && appContext) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ signedIn: authToken !== null, email: authEmail }));
        return;
      }

      if (req.method === "POST" && pathname === "/api/search") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", async () => {
          try {
            const searchRes = await postText(
              "https://mobygratis.com/api/search",
              "application/x-www-form-urlencoded",
              body,
            );
            res.writeHead(searchRes.status, { "Content-Type": "text/html" });
            res.end(searchRes.text);
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/api/preview/")) {
        const uuid = pathname.slice("/api/preview/".length);
        if (uuid) {
          (async () => {
            try {
              if (!authToken) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Not signed in" }));
                return;
              }
              console.log(`MobyGratis: fetching preview URL for ${uuid}`);
              const previewUrl = await getText(
                `https://mobygratis.com/api/preview/${uuid}`,
                { Authorization: `Bearer ${authToken}` },
              );
              console.log(`MobyGratis: preview URL: ${previewUrl.substring(0, 80)}...`);
              res.writeHead(200, { "Content-Type": "text/plain" });
              res.end(previewUrl);
            } catch (err: any) {
              console.error("MobyGratis: preview error", err);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            }
          })();
        } else {
          res.writeHead(400);
          res.end("No UUID");
        }
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      server = s;
      resolve((s.address() as any).port);
    });
  });
}

function stopServer() {
  if (server) {
    server.close();
    server = null;
  }
}

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.1");
  appContext = context;

  context.commands.registerCommand("mobygratis.showDialog", async () => {
    try {
      const port = await startServer(bundledInterface);
      const url = `http://127.0.0.1:${port}/`;

      const result = await context.ui.showModalDialog(url, 750, 520);
      stopServer();

      if (!result) return;
      const data = JSON.parse(result);
      if (data.action === "import" && data.slug && data.uuid) {
        importTrack(context, data.slug, data.uuid, data.format || "WAV", data.trackIndex ?? 0);
      }
    } catch (err: any) {
      console.error("MobyGratis: dialog failed", err);
      stopServer();
    }
  });

  for (const scope of ["AudioClip", "AudioTrack", "MidiTrack", "ClipSlot", "Scene"] as const) {
    context.ui.registerContextMenuAction(
      scope,
      "MobyGratis: browse & import",
      "mobygratis.showDialog",
    );
  }
}
