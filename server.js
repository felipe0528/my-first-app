import http from "node:http";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { URL } from "node:url";

const MAX_BODY_BYTES = 30 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const RETRY_MAX_ATTEMPTS = 5;
const PORT = Number(process.env.PORT || 3000);
const HOSTNAME = process.env.HOSTNAME || "0.0.0.0";

loadLocalEnv();

let cachedToken = null;

function loadLocalEnv() {
  if (!existsSync(".env")) return;
  const lines = readFileSync(".env", "utf8").split(/\r?\n/g);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    const error = new Error(`Falta configurar ${name}`);
    error.status = 503;
    throw error;
  }
  return value;
}

function normalizeRootPath(path) {
  const value = String(path || "").trim();
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  return withSlash.replace(/\/+$/g, "");
}

function pathRootHeader() {
  const namespaceId = requiredEnv("DROPBOX_PATH_ROOT_NAMESPACE_ID");
  const mode = process.env.DROPBOX_PATH_ROOT_MODE === "namespace_id" ? "namespace_id" : "root";
  if (mode === "namespace_id") return JSON.stringify({ ".tag": "namespace_id", namespace_id: namespaceId });
  return JSON.stringify({ ".tag": "root", root: namespaceId });
}

function sanitizeName(name) {
  return String(name || "archivo")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\\/:*?"<>|#\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "archivo";
}

function contentArgJson(value) {
  return JSON.stringify(value).replace(/[^\u0020-\u007e]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function retryDelayMs(retryAfter, attempt) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000) + 50 + Math.floor(Math.random() * 250);
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.min(Math.max(0, retryAt - Date.now()), 30_000) + 50 + Math.floor(Math.random() * 250);
  }
  return Math.min(800 * 2 ** attempt, 30_000) + 50 + Math.floor(Math.random() * 250);
}

function parseRetryAfterFromBody(text) {
  try {
    const payload = JSON.parse(text);
    return payload.retry_after ?? payload.error?.retry_after ?? null;
  } catch { return null; }
}

async function refreshToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const appKey = requiredEnv("DROPBOX_APP_KEY");
  const appSecret = requiredEnv("DROPBOX_APP_SECRET");
  const refreshTokenValue = requiredEnv("DROPBOX_REFRESH_TOKEN");
  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${appKey}:${appSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshTokenValue })
  });
  if (!response.ok) throw await dropboxError("oauth2.token", "oauth2/token", response);
  const payload = await response.json();
  cachedToken = { token: payload.access_token, expiresAt: Date.now() + Math.max(60, payload.expires_in || 14_400) * 1000 };
  return cachedToken.token;
}

async function dropboxError(operation, endpoint, response) {
  const body = await response.text().catch(() => "");
  let errorSummary = body || response.statusText || null;
  try {
    const parsed = JSON.parse(body);
    errorSummary = parsed.error_summary || JSON.stringify(parsed.error || parsed);
  } catch {}
  const error = new Error(`Dropbox fallo en ${operation}`);
  error.status = response.status;
  error.dropbox = {
    diagnosticId: randomUUID(), operation, endpoint, status: response.status,
    requestId: response.headers.get("x-dropbox-request-id"),
    retryAfter: response.headers.get("retry-after"),
    retryAfterFromBody: parseRetryAfterFromBody(body),
    errorSummary: errorSummary ? String(errorSummary).slice(0, 500) : null
  };
  return error;
}

async function dropboxApi(operation, endpoint, payload, { includePathRoot = true } = {}) {
  const headers = { Authorization: `Bearer ${await refreshToken()}`, "Content-Type": "application/json" };
  if (includePathRoot) headers["Dropbox-API-Path-Root"] = pathRootHeader();
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, { method: "POST", headers, body: payload === undefined ? "null" : JSON.stringify(payload) });
    if (response.ok) return response.json();
    const error = await dropboxError(operation, endpoint, response);
    if ((response.status === 429 || response.status >= 500) && attempt < RETRY_MAX_ATTEMPTS - 1) {
      const delayMs = retryDelayMs(error.dropbox.retryAfter || error.dropbox.retryAfterFromBody, attempt);
      console.warn(JSON.stringify({ op: "dropbox.retry", attempt: attempt + 1, delayMs, ...error.dropbox }));
      await sleep(delayMs);
      continue;
    }
    if (response.status === 429 || response.status >= 500) console.error(JSON.stringify({ op: "dropbox.failure", attempt: attempt + 1, ...error.dropbox }));
    throw error;
  }
}

async function dropboxContent(operation, endpoint, apiArgs, contents) {
  const headers = { Authorization: `Bearer ${await refreshToken()}`, "Dropbox-API-Arg": contentArgJson(apiArgs), "Dropbox-API-Path-Root": pathRootHeader(), "Content-Type": "application/octet-stream" };
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(`https://content.dropboxapi.com/2/${endpoint}`, { method: "POST", headers, body: new Uint8Array(contents) });
    if (response.ok) return response.json();
    const error = await dropboxError(operation, endpoint, response);
    if ((response.status === 429 || response.status >= 500) && attempt < RETRY_MAX_ATTEMPTS - 1) {
      const delayMs = retryDelayMs(error.dropbox.retryAfter || error.dropbox.retryAfterFromBody, attempt);
      console.warn(JSON.stringify({ op: "dropbox.retry", attempt: attempt + 1, delayMs, ...error.dropbox }));
      await sleep(delayMs);
      continue;
    }
    console.error(JSON.stringify({ op: "dropbox.failure", attempt: attempt + 1, ...error.dropbox }));
    throw error;
  }
}

async function createFolderIfNeeded(path) {
  try { return await dropboxApi("files.create_folder_v2", "files/create_folder_v2", { path, autorename: false }); }
  catch (error) {
    if (error.status === 409 && String(error.dropbox?.errorSummary || "").includes("conflict")) return { metadata: { path_display: path, existing: true } };
    throw error;
  }
}

async function ensureProbeFolder(root) {
  const probeRoot = `${root}/hostinger-probe`;
  const dateFolder = `${probeRoot}/${new Date().toISOString().slice(0, 10)}`;
  await createFolderIfNeeded(probeRoot);
  await createFolderIfNeeded(dateFolder);
  return dateFolder;
}

async function statusPayload() {
  const startedAt = Date.now();
  await refreshToken();
  const account = await dropboxApi("users.get_current_account", "users/get_current_account", undefined, { includePathRoot: false });
  const paymentsRoot = normalizeRootPath(requiredEnv("DROPBOX_PAYMENTS_ROOT_PATH"));
  const contractsRoot = normalizeRootPath(requiredEnv("DROPBOX_CONTRACTS_ROOT_PATH"));
  const paymentsMetadata = await dropboxApi("files.get_metadata.payments", "files/get_metadata", { path: paymentsRoot });
  const contractsMetadata = await dropboxApi("files.get_metadata.contracts", "files/get_metadata", { path: contractsRoot });
  return { ok: true, latencyMs: Date.now() - startedAt, node: process.version, pid: process.pid, namespaceId: requiredEnv("DROPBOX_PATH_ROOT_NAMESPACE_ID"), accountRootInfo: account.root_info, paymentsRoot: paymentsMetadata.path_display || paymentsRoot, contractsRoot: contractsMetadata.path_display || contractsRoot };
}

async function uploadFile(payload) {
  const configuredPassword = process.env.PROBE_UPLOAD_PASSWORD;
  if (configuredPassword && payload.password !== configuredPassword) { const error = new Error("Password invalido"); error.status = 403; throw error; }
  const target = payload.target === "contracts" ? "contracts" : "payments";
  const root = target === "contracts" ? normalizeRootPath(requiredEnv("DROPBOX_CONTRACTS_ROOT_PATH")) : normalizeRootPath(requiredEnv("DROPBOX_PAYMENTS_ROOT_PATH"));
  const filename = sanitizeName(payload.name);
  const buffer = Buffer.from(String(payload.base64 || ""), "base64");
  if (!buffer.length || buffer.length > MAX_FILE_BYTES) { const error = new Error("Archivo vacio o mayor a 20 MB"); error.status = 400; throw error; }
  const folder = await ensureProbeFolder(root);
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const path = `${folder}/${timestamp}-${filename}`;
  const uploaded = await dropboxContent("files.upload", "files/upload", { path, mode: { ".tag": "add" }, autorename: true, mute: true }, buffer);
  return { ok: true, target, bytes: buffer.length, uploaded: { name: uploaded.name, id: uploaded.id, rev: uploaded.rev, path_display: uploaded.path_display } };
}

function html() { return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dropbox Hostinger Probe</title><style>body{font-family:Arial,sans-serif;margin:32px;color:#182322;max-width:760px}label{display:block;font-weight:700;margin-top:16px}input,select,button{font:inherit;padding:10px;width:100%;box-sizing:border-box}button{margin-top:18px;background:#0b3b42;color:white;border:0;border-radius:6px;font-weight:700;cursor:pointer}pre{background:#f4f7f7;border:1px solid #dbe5e4;padding:14px;overflow:auto;white-space:pre-wrap}</style></head><body><h1>Dropbox Hostinger Probe</h1><p>Prueba minima de upload desde Hostinger hacia Dropbox.</p><p><a href="/health">Health</a> | <a href="/dropbox/status">Dropbox status</a></p><form id="form"><label>Password de prueba</label><input id="password" type="password" autocomplete="current-password"><label>Destino</label><select id="target"><option value="payments">Pagos/depositos</option><option value="contracts">Contratos</option></select><label>Archivo</label><input id="file" type="file" required><button type="submit">Subir a Dropbox</button></form><h2>Resultado</h2><pre id="result">Sin prueba aun.</pre><script>const form=document.getElementById('form');const result=document.getElementById('result');form.addEventListener('submit',async(event)=>{event.preventDefault();const file=document.getElementById('file').files[0];if(!file)return;result.textContent='Subiendo...';const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});const base64=String(dataUrl).split(',')[1]||'';const response=await fetch('/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('password').value,target:document.getElementById('target').value,name:file.name,type:file.type,base64})});const payload=await response.json().catch(()=>({error:'Respuesta no JSON'}));result.textContent=JSON.stringify({status:response.status,payload},null,2);});</script></body></html>`; }

async function readJson(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) { const error = new Error("Body mayor a 30 MB"); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response, status, payload) { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(payload, null, 2)); }
function sendHtml(response, body) { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(body); }
function publicError(error) { return { ok: false, error: error.message || "Error interno", status: error.status || 500, dropbox: error.dropbox || null }; }

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/") return sendHtml(response, html());
    if (request.method === "GET" && url.pathname === "/health") return sendJson(response, 200, { ok: true, node: process.version, pid: process.pid, uptimeSec: Math.floor(process.uptime()) });
    if (request.method === "GET" && url.pathname === "/dropbox/status") return sendJson(response, 200, await statusPayload());
    if (request.method === "POST" && url.pathname === "/upload") return sendJson(response, 200, await uploadFile(await readJson(request)));
    sendJson(response, 404, { ok: false, error: "Not found" });
  } catch (error) { const payload = publicError(error); sendJson(response, payload.status, payload); }
});

server.listen(PORT, HOSTNAME, () => { console.log(JSON.stringify({ op: "server.ready", port: PORT, hostname: HOSTNAME, pid: process.pid })); });
