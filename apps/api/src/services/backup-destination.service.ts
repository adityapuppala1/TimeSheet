/**
 * WHAT: where a backup is written, and the six ways of writing it — the API host's own disk, an
 * S3-compatible bucket, Azure Blob Storage, Google Drive, OneDrive, or SFTP.
 *
 * ONE INTERFACE, SIX ADAPTERS. Everything above this file (the scheduler, the retention sweep, the
 * restore, the console) speaks only `put` / `list` / `download` / `remove` / `test`. That is what
 * lets "which cloud is this customer's data in?" be a row in a table rather than a branch through
 * the whole backup path.
 *
 * SECRETS. Nothing that authenticates is ever stored in `config`. Every credential lives in one
 * AES-256-GCM blob (`utils/encryption.ts`) that is decrypted here, used, and never returned by any
 * route — the console gets booleans like `hasSecret`, never the value. `describeSecret` exists so a
 * screen can say WHICH fields are set without revealing them.
 *
 * WHY S3 IS THE ONE THAT MATTERS MOST. `endpoint` + `forcePathStyle` make the same adapter work
 * against Amazon S3, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces and MinIO — so
 * "S3-compatible" covers most of what an operator will actually point this at, including a bucket
 * inside their own VPC.
 *
 * WHY GOOGLE DRIVE AND ONEDRIVE NEED NO SDK. Both are plain REST with an OAuth refresh token: one
 * token exchange, then a resumable upload. Pulling in `googleapis` (~40MB) and `@microsoft/graph`
 * to make two HTTP calls each would be a worse trade than the twenty lines below. The operator
 * registers their own app and pastes a refresh token, which is also the only shape that works for
 * a self-hosted install where we are not the OAuth client.
 *
 * NOTHING HERE THROWS PAST ITS OWN BOUNDARY WITHOUT CONTEXT. Every failure is turned into an
 * `AppError` naming the destination and what it was doing, because the single most common support
 * question about a backup is "why did it not run", and "AccessDenied" on its own does not answer it.
 */
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { AppError } from "../middleware/error.js";
import { decryptSecret, encryptSecret } from "../utils/encryption.js";

export type BackupDestinationKind = "LOCAL" | "S3" | "AZURE_BLOB" | "GOOGLE_DRIVE" | "ONEDRIVE" | "SFTP";

export interface StoredObject {
  key: string;
  bytes: number;
  modifiedAt: Date;
}

export interface DestinationRecord {
  id: string;
  name: string;
  kind: BackupDestinationKind;
  config: unknown;
  encryptedSecret: string | null;
  prefix: string | null;
}

/** Every adapter implements exactly this. */
interface Adapter {
  put(object: { key: string; filePath: string; bytes: number }): Promise<{ location: string }>;
  list(prefix: string): Promise<StoredObject[]>;
  download(key: string, toFilePath: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Prove the credentials work and the target is writable, without leaving anything behind. */
  test(): Promise<string>;
}

/* ------------------------------------------------------------------------------------------ */
/* Config + secret shapes                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * What each kind stores, split into what is safe to show (`config`) and what is not (`secret`).
 * The console's form is generated from `DESTINATION_FIELDS` below, so adding a kind is one entry
 * here and one adapter — never a form edited in two places.
 */
export interface DestinationFieldSpec {
  key: string;
  label: string;
  hint?: string;
  /** Secret fields are write-only: sent on save, never returned. */
  secret?: boolean;
  optional?: boolean;
  placeholder?: string;
}

export const DESTINATION_FIELDS: Record<BackupDestinationKind, { label: string; blurb: string; fields: DestinationFieldSpec[] }> = {
  LOCAL: {
    label: "This server's disk",
    blurb: "A directory on the API host. The only destination that needs no credentials — and the only one that is not off-site, so it protects you from a dropped database and not from a lost server.",
    fields: [{ key: "directory", label: "Directory", placeholder: "/var/backups/timesphere", hint: "Created if it does not exist. The API process must be able to write to it." }]
  },
  S3: {
    label: "S3-compatible bucket",
    blurb: "Amazon S3, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces or MinIO — anything that speaks the S3 API. Leave the endpoint blank for Amazon.",
    fields: [
      { key: "bucket", label: "Bucket", placeholder: "acme-timesphere-backups" },
      { key: "region", label: "Region", placeholder: "eu-west-1" },
      { key: "endpoint", label: "Endpoint", optional: true, placeholder: "https://s3.eu-central-003.backblazeb2.com", hint: "Only for non-Amazon providers." },
      { key: "forcePathStyle", label: "Force path-style URLs", optional: true, hint: "Needed by MinIO and some self-hosted gateways. Type true or false." },
      { key: "accessKeyId", label: "Access key ID", secret: true },
      { key: "secretAccessKey", label: "Secret access key", secret: true }
    ]
  },
  AZURE_BLOB: {
    label: "Azure Blob Storage",
    blurb: "A container in an Azure storage account. Paste either a full connection string or an account name plus key.",
    fields: [
      { key: "container", label: "Container", placeholder: "timesphere-backups" },
      { key: "accountName", label: "Account name", optional: true, placeholder: "acmebackups" },
      { key: "connectionString", label: "Connection string", secret: true, optional: true, hint: "Preferred. If set, the account name and key below are ignored." },
      { key: "accountKey", label: "Account key", secret: true, optional: true }
    ]
  },
  GOOGLE_DRIVE: {
    label: "Google Drive",
    blurb: "A folder in Drive, through an OAuth app you register. Paste the client id, secret and a refresh token with the drive.file scope.",
    fields: [
      { key: "folderId", label: "Folder ID", placeholder: "1A2b3C4d…", hint: "From the folder's URL in Drive." },
      { key: "clientId", label: "OAuth client ID", secret: true },
      { key: "clientSecret", label: "OAuth client secret", secret: true },
      { key: "refreshToken", label: "Refresh token", secret: true, hint: "Obtained once, offline, with access_type=offline." }
    ]
  },
  ONEDRIVE: {
    label: "OneDrive / SharePoint",
    blurb: "A folder in OneDrive or a SharePoint document library, through a Microsoft Entra app registration with Files.ReadWrite.",
    fields: [
      { key: "folderPath", label: "Folder path", placeholder: "/TimeSphere Backups", hint: "Relative to the drive root." },
      { key: "driveId", label: "Drive ID", optional: true, hint: "Blank uses the signed-in account's own drive." },
      { key: "tenantId", label: "Directory (tenant) ID", secret: true },
      { key: "clientId", label: "Application (client) ID", secret: true },
      { key: "clientSecret", label: "Client secret", secret: true },
      { key: "refreshToken", label: "Refresh token", secret: true, optional: true, hint: "Delegated flow. Leave blank to use application permissions with the client secret alone." }
    ]
  },
  SFTP: {
    label: "SFTP server",
    blurb: "Your own backup server over SSH. Authenticate with a password or a private key — the key is stored encrypted like every other secret here.",
    fields: [
      { key: "host", label: "Host", placeholder: "backup.acme.internal" },
      { key: "port", label: "Port", optional: true, placeholder: "22" },
      { key: "directory", label: "Remote directory", placeholder: "/srv/backups/timesphere" },
      { key: "username", label: "Username", secret: true },
      { key: "password", label: "Password", secret: true, optional: true },
      { key: "privateKey", label: "Private key (PEM)", secret: true, optional: true },
      { key: "passphrase", label: "Key passphrase", secret: true, optional: true }
    ]
  }
};

type Secrets = Record<string, string>;

export function encryptDestinationSecret(secrets: Secrets): string {
  return encryptSecret(JSON.stringify(secrets));
}

function readSecrets(record: DestinationRecord): Secrets {
  if (!record.encryptedSecret) return {};
  try {
    const parsed: unknown = JSON.parse(decryptSecret(record.encryptedSecret));
    return parsed && typeof parsed === "object" ? (parsed as Secrets) : {};
  } catch {
    // A rotated ENCRYPTION_KEY is the usual cause, and it is worth a clear error rather than a
    // confusing auth failure three calls later.
    throw new AppError(500, `The credentials for "${record.name}" could not be decrypted — was ENCRYPTION_KEY rotated without re-entering them?`);
  }
}

/** Which secret fields are set, for a screen that must say so without revealing them. */
export function describeSecret(record: DestinationRecord): Record<string, boolean> {
  const spec = DESTINATION_FIELDS[record.kind];
  let secrets: Secrets = {};
  try {
    secrets = readSecrets(record);
  } catch {
    secrets = {};
  }
  return Object.fromEntries(spec.fields.filter((f) => f.secret).map((f) => [f.key, Boolean(secrets[f.key])]));
}

function cfg(record: DestinationRecord): Record<string, string> {
  const raw = record.config;
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, v === null || v === undefined ? "" : String(v)]));
}

/** `<prefix>/<key>`, with no leading slash and no doubled separators — every adapter's key space. */
function fullKey(record: DestinationRecord, key: string): string {
  const prefix = (record.prefix ?? "").replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${key}` : key;
}

/* ------------------------------------------------------------------------------------------ */
/* LOCAL                                                                                       */
/* ------------------------------------------------------------------------------------------ */

function localAdapter(record: DestinationRecord): Adapter {
  const root = path.resolve(cfg(record).directory || "");
  if (!root) throw new AppError(422, `"${record.name}" has no directory configured.`);

  /** Resolve a key under the root and refuse anything that escapes it. */
  const resolve = (key: string) => {
    const full = path.resolve(root, fullKey(record, key));
    if (path.relative(root, full).startsWith("..")) throw new AppError(400, "That key does not resolve inside the destination directory.");
    return full;
  };

  return {
    async put({ key, filePath }) {
      const target = resolve(key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(filePath, target);
      return { location: target };
    },
    async list(prefix) {
      const base = path.resolve(root, fullKey(record, prefix).replace(/[^/]*$/, ""));
      const wanted = fullKey(record, prefix);
      const out: StoredObject[] = [];
      const walk = async (dir: string) => {
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) await walk(full);
          else {
            const key = path.relative(root, full).split(path.sep).join("/");
            if (key.startsWith(wanted)) {
              const stat = await fs.stat(full);
              out.push({ key: key.slice((record.prefix ?? "").replace(/^\/+|\/+$/g, "").length).replace(/^\//, ""), bytes: stat.size, modifiedAt: stat.mtime });
            }
          }
        }
      };
      await walk(base).catch(() => undefined);
      return out;
    },
    async download(key, toFilePath) {
      await fs.copyFile(resolve(key), toFilePath);
    },
    async remove(key) {
      await fs.rm(resolve(key), { force: true });
    },
    async test() {
      await fs.mkdir(root, { recursive: true });
      const probe = path.join(root, `.timesphere-write-test-${Date.now()}`);
      await fs.writeFile(probe, "ok");
      await fs.rm(probe, { force: true });
      return `${root} is writable.`;
    }
  };
}

/* ------------------------------------------------------------------------------------------ */
/* S3-compatible                                                                               */
/* ------------------------------------------------------------------------------------------ */

async function s3Adapter(record: DestinationRecord): Promise<Adapter> {
  const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } = await import("@aws-sdk/client-s3");
  const c = cfg(record);
  const secrets = readSecrets(record);
  if (!c.bucket) throw new AppError(422, `"${record.name}" has no bucket configured.`);

  const client = new S3Client({
    region: c.region || "us-east-1",
    ...(c.endpoint ? { endpoint: c.endpoint } : {}),
    // MinIO and several self-hosted gateways cannot do virtual-hosted-style addressing.
    forcePathStyle: c.forcePathStyle === "true",
    ...(secrets.accessKeyId && secrets.secretAccessKey
      ? { credentials: { accessKeyId: secrets.accessKeyId, secretAccessKey: secrets.secretAccessKey } }
      : // No keys configured falls through to the SDK's own chain — which is what an install
        // running on EC2/ECS with an instance role actually wants, and is a legitimate setup.
        {})
  });

  return {
    async put({ key, filePath, bytes }) {
      await client.send(
        new PutObjectCommand({
          Bucket: c.bucket,
          Key: fullKey(record, key),
          Body: createReadStream(filePath),
          ContentLength: bytes,
          ContentType: "application/sql"
        })
      );
      return { location: `s3://${c.bucket}/${fullKey(record, key)}` };
    },
    async list(prefix) {
      const out: StoredObject[] = [];
      let token: string | undefined;
      const base = (record.prefix ?? "").replace(/^\/+|\/+$/g, "");
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: c.bucket, Prefix: fullKey(record, prefix), ContinuationToken: token }));
        for (const item of page.Contents ?? []) {
          if (!item.Key) continue;
          out.push({ key: base ? item.Key.slice(base.length + 1) : item.Key, bytes: item.Size ?? 0, modifiedAt: item.LastModified ?? new Date(0) });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async download(key, toFilePath) {
      const res = await client.send(new GetObjectCommand({ Bucket: c.bucket, Key: fullKey(record, key) }));
      if (!res.Body) throw new AppError(502, "The object came back empty.");
      await pipeline(res.Body as Readable, createWriteStream(toFilePath));
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: c.bucket, Key: fullKey(record, key) }));
    },
    async test() {
      // HeadBucket proves both the credentials and that this bucket is the one they reach.
      await client.send(new HeadBucketCommand({ Bucket: c.bucket }));
      return `Reached bucket ${c.bucket}${c.endpoint ? ` at ${c.endpoint}` : ""}.`;
    }
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Azure Blob                                                                                  */
/* ------------------------------------------------------------------------------------------ */

async function azureAdapter(record: DestinationRecord): Promise<Adapter> {
  const { BlobServiceClient, StorageSharedKeyCredential } = await import("@azure/storage-blob");
  const c = cfg(record);
  const secrets = readSecrets(record);
  if (!c.container) throw new AppError(422, `"${record.name}" has no container configured.`);

  const service = secrets.connectionString
    ? BlobServiceClient.fromConnectionString(secrets.connectionString)
    : new BlobServiceClient(
        `https://${c.accountName}.blob.core.windows.net`,
        new StorageSharedKeyCredential(c.accountName ?? "", secrets.accountKey ?? "")
      );
  const container = service.getContainerClient(c.container);
  const base = (record.prefix ?? "").replace(/^\/+|\/+$/g, "");

  return {
    async put({ key, filePath }) {
      const blob = container.getBlockBlobClient(fullKey(record, key));
      await blob.uploadFile(filePath, { blobHTTPHeaders: { blobContentType: "application/sql" } });
      return { location: blob.url };
    },
    async list(prefix) {
      const out: StoredObject[] = [];
      for await (const item of container.listBlobsFlat({ prefix: fullKey(record, prefix) })) {
        out.push({
          key: base ? item.name.slice(base.length + 1) : item.name,
          bytes: item.properties.contentLength ?? 0,
          modifiedAt: item.properties.lastModified ?? new Date(0)
        });
      }
      return out;
    },
    async download(key, toFilePath) {
      await container.getBlockBlobClient(fullKey(record, key)).downloadToFile(toFilePath);
    },
    async remove(key) {
      await container.getBlockBlobClient(fullKey(record, key)).deleteIfExists();
    },
    async test() {
      // Creating it if absent is deliberate: a container that does not exist yet is the normal
      // first-run state, and failing the test for it sends the operator to the portal for nothing.
      await container.createIfNotExists();
      return `Reached container ${c.container}.`;
    }
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Google Drive                                                                                */
/* ------------------------------------------------------------------------------------------ */

async function googleAccessToken(secrets: Secrets): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: secrets.clientId ?? "",
      client_secret: secrets.clientSecret ?? "",
      refresh_token: secrets.refreshToken ?? "",
      grant_type: "refresh_token"
    })
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
  if (!res.ok || !body.access_token) throw new AppError(502, `Google refused the refresh token: ${body.error_description ?? body.error ?? res.status}`);
  return body.access_token;
}

function googleAdapter(record: DestinationRecord): Adapter {
  const c = cfg(record);
  const secrets = readSecrets(record);
  const folderId = c.folderId;
  const nameFor = (key: string) => fullKey(record, key).replace(/\//g, "__");

  /** Drive has no key space — it has file ids and names. The prefix is folded into the NAME so a
   *  flat folder still behaves like a keyed store, which is what everything above expects. */
  async function findByName(token: string, name: string): Promise<{ id: string; size: number; modified: string } | null> {
    const q = encodeURIComponent(`name = '${name.replace(/'/g, "\\'")}' and trashed = false${folderId ? ` and '${folderId}' in parents` : ""}`);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,size,modifiedTime)`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json().catch(() => ({}))) as { files?: Array<{ id: string; size?: string; modifiedTime?: string }> };
    const file = body.files?.[0];
    return file ? { id: file.id, size: Number(file.size ?? 0), modified: file.modifiedTime ?? new Date(0).toISOString() } : null;
  }

  return {
    async put({ key, filePath }) {
      const token = await googleAccessToken(secrets);
      const metadata = { name: nameFor(key), ...(folderId ? { parents: [folderId] } : {}) };
      // Resumable, because a database dump is not a small file and a simple upload has no recovery
      // and a hard size ceiling.
      const start = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(metadata)
      });
      const session = start.headers.get("location");
      if (!start.ok || !session) throw new AppError(502, `Google would not start an upload: ${start.status}`);
      const data = await fs.readFile(filePath);
      const put = await fetch(session, { method: "PUT", headers: { "content-type": "application/sql" }, body: new Uint8Array(data) });
      if (!put.ok) throw new AppError(502, `Google rejected the upload: ${put.status}`);
      const created = (await put.json().catch(() => ({}))) as { id?: string };
      return { location: `googledrive://${created.id ?? metadata.name}` };
    },
    async list(prefix) {
      const token = await googleAccessToken(secrets);
      const wanted = nameFor(prefix);
      const q = encodeURIComponent(`trashed = false${folderId ? ` and '${folderId}' in parents` : ""}`);
      const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=1000&fields=files(id,name,size,modifiedTime)`, {
        headers: { authorization: `Bearer ${token}` }
      });
      const body = (await res.json().catch(() => ({}))) as { files?: Array<{ name: string; size?: string; modifiedTime?: string }> };
      const base = (record.prefix ?? "").replace(/^\/+|\/+$/g, "");
      return (body.files ?? [])
        .filter((f) => f.name.startsWith(wanted))
        .map((f) => ({
          key: (base ? f.name.slice(base.length + 2) : f.name).replace(/__/g, "/"),
          bytes: Number(f.size ?? 0),
          modifiedAt: new Date(f.modifiedTime ?? 0)
        }));
    },
    async download(key, toFilePath) {
      const token = await googleAccessToken(secrets);
      const found = await findByName(token, nameFor(key));
      if (!found) throw new AppError(404, "That backup is not in the Drive folder any more.");
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${found.id}?alt=media`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok || !res.body) throw new AppError(502, `Google refused the download: ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(toFilePath));
    },
    async remove(key) {
      const token = await googleAccessToken(secrets);
      const found = await findByName(token, nameFor(key));
      if (!found) return;
      await fetch(`https://www.googleapis.com/drive/v3/files/${found.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    },
    async test() {
      const token = await googleAccessToken(secrets);
      if (folderId) {
        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name`, { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) throw new AppError(502, `The refresh token works, but folder ${folderId} is not reachable with it (${res.status}).`);
        const folder = (await res.json()) as { name?: string };
        return `Reached Drive folder "${folder.name ?? folderId}".`;
      }
      return "Refresh token accepted; uploads will go to the account's Drive root.";
    }
  };
}

/* ------------------------------------------------------------------------------------------ */
/* OneDrive / SharePoint (Microsoft Graph)                                                     */
/* ------------------------------------------------------------------------------------------ */

async function graphAccessToken(secrets: Secrets): Promise<string> {
  // No refresh token means application permissions — the client-credentials flow, which is what an
  // unattended backup on a tenant-owned app registration actually wants.
  const body: Record<string, string> = secrets.refreshToken
    ? {
        client_id: secrets.clientId ?? "",
        client_secret: secrets.clientSecret ?? "",
        refresh_token: secrets.refreshToken,
        grant_type: "refresh_token",
        scope: "https://graph.microsoft.com/.default offline_access"
      }
    : { client_id: secrets.clientId ?? "", client_secret: secrets.clientSecret ?? "", grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" };
  const res = await fetch(`https://login.microsoftonline.com/${secrets.tenantId ?? "common"}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body)
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
  if (!res.ok || !json.access_token) throw new AppError(502, `Microsoft refused the credentials: ${json.error_description ?? json.error ?? res.status}`);
  return json.access_token;
}

function oneDriveAdapter(record: DestinationRecord): Adapter {
  const c = cfg(record);
  const secrets = readSecrets(record);
  const drive = c.driveId ? `/drives/${c.driveId}` : "/me/drive";
  const folder = (c.folderPath || "/").replace(/^\/+|\/+$/g, "");
  const itemPath = (key: string) => [folder, fullKey(record, key)].filter(Boolean).join("/");

  return {
    async put({ key, filePath }) {
      const token = await graphAccessToken(secrets);
      // An upload SESSION rather than a simple PUT: Graph caps simple uploads at 4MB, and a
      // database dump is comfortably past that.
      const session = await fetch(`https://graph.microsoft.com/v1.0${drive}/root:/${encodeURI(itemPath(key))}:/createUploadSession`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } })
      });
      const sessionBody = (await session.json().catch(() => ({}))) as { uploadUrl?: string; error?: { message?: string } };
      if (!session.ok || !sessionBody.uploadUrl) throw new AppError(502, `Microsoft would not start an upload: ${sessionBody.error?.message ?? session.status}`);
      const data = await fs.readFile(filePath);
      const put = await fetch(sessionBody.uploadUrl, {
        method: "PUT",
        headers: { "content-length": String(data.byteLength), "content-range": `bytes 0-${data.byteLength - 1}/${data.byteLength}` },
        body: new Uint8Array(data)
      });
      if (!put.ok) throw new AppError(502, `Microsoft rejected the upload: ${put.status}`);
      return { location: `onedrive:/${itemPath(key)}` };
    },
    async list(prefix) {
      const token = await graphAccessToken(secrets);
      const url = folder ? `https://graph.microsoft.com/v1.0${drive}/root:/${encodeURI(folder)}:/children` : `https://graph.microsoft.com/v1.0${drive}/root/children`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) return [];
      const body = (await res.json()) as { value?: Array<{ name: string; size?: number; lastModifiedDateTime?: string }> };
      const base = (record.prefix ?? "").replace(/^\/+|\/+$/g, "");
      const wanted = fullKey(record, prefix);
      return (body.value ?? [])
        .filter((f) => f.name.startsWith(base ? wanted.split("/").pop()! : wanted))
        .map((f) => ({ key: f.name, bytes: f.size ?? 0, modifiedAt: new Date(f.lastModifiedDateTime ?? 0) }));
    },
    async download(key, toFilePath) {
      const token = await graphAccessToken(secrets);
      const res = await fetch(`https://graph.microsoft.com/v1.0${drive}/root:/${encodeURI(itemPath(key))}:/content`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok || !res.body) throw new AppError(502, `Microsoft refused the download: ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(toFilePath));
    },
    async remove(key) {
      const token = await graphAccessToken(secrets);
      await fetch(`https://graph.microsoft.com/v1.0${drive}/root:/${encodeURI(itemPath(key))}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    },
    async test() {
      const token = await graphAccessToken(secrets);
      const res = await fetch(`https://graph.microsoft.com/v1.0${drive}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new AppError(502, `The credentials work, but that drive is not reachable (${res.status}).`);
      const body = (await res.json()) as { name?: string };
      return `Reached drive "${body.name ?? c.driveId ?? "me"}".`;
    }
  };
}

/* ------------------------------------------------------------------------------------------ */
/* SFTP                                                                                        */
/* ------------------------------------------------------------------------------------------ */

async function sftpAdapter(record: DestinationRecord): Promise<Adapter> {
  const Client = (await import("ssh2-sftp-client")).default;
  const c = cfg(record);
  const secrets = readSecrets(record);
  const root = (c.directory || "/").replace(/\/+$/, "");

  /** A fresh connection per operation. The alternative — one pooled client — means a socket held
   *  open between a daily backup and the next one, and an SSH server that has since restarted. */
  const connect = async () => {
    const client = new Client();
    await client.connect({
      host: c.host,
      port: Number(c.port || 22),
      username: secrets.username,
      ...(secrets.password ? { password: secrets.password } : {}),
      ...(secrets.privateKey ? { privateKey: secrets.privateKey } : {}),
      ...(secrets.passphrase ? { passphrase: secrets.passphrase } : {}),
      readyTimeout: 20_000
    });
    return client;
  };
  const remote = (key: string) => `${root}/${fullKey(record, key)}`;

  return {
    async put({ key, filePath }) {
      const client = await connect();
      try {
        const target = remote(key);
        await client.mkdir(target.replace(/\/[^/]*$/, ""), true).catch(() => undefined);
        await client.fastPut(filePath, target);
        return { location: `sftp://${c.host}${target}` };
      } finally {
        await client.end().catch(() => undefined);
      }
    },
    async list(prefix) {
      const client = await connect();
      try {
        const dir = `${root}/${(record.prefix ?? "").replace(/^\/+|\/+$/g, "")}`.replace(/\/+$/, "") || "/";
        const entries = await client.list(dir).catch(() => []);
        return entries
          .filter((e: { type: string; name: string }) => e.type === "-" && e.name.startsWith(prefix.split("/").pop() ?? ""))
          .map((e: { name: string; size: number; modifyTime: number }) => ({ key: e.name, bytes: e.size, modifiedAt: new Date(e.modifyTime) }));
      } finally {
        await client.end().catch(() => undefined);
      }
    },
    async download(key, toFilePath) {
      const client = await connect();
      try {
        await client.fastGet(remote(key), toFilePath);
      } finally {
        await client.end().catch(() => undefined);
      }
    },
    async remove(key) {
      const client = await connect();
      try {
        await client.delete(remote(key)).catch(() => undefined);
      } finally {
        await client.end().catch(() => undefined);
      }
    },
    async test() {
      const client = await connect();
      try {
        await client.mkdir(root, true).catch(() => undefined);
        const exists = await client.exists(root);
        if (!exists) throw new AppError(502, `Connected, but ${root} does not exist and could not be created.`);
        return `Connected to ${c.host} and ${root} is present.`;
      } finally {
        await client.end().catch(() => undefined);
      }
    }
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Factory                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export async function adapterFor(record: DestinationRecord): Promise<Adapter> {
  switch (record.kind) {
    case "LOCAL":
      return localAdapter(record);
    case "S3":
      return s3Adapter(record);
    case "AZURE_BLOB":
      return azureAdapter(record);
    case "GOOGLE_DRIVE":
      return googleAdapter(record);
    case "ONEDRIVE":
      return oneDriveAdapter(record);
    case "SFTP":
      return sftpAdapter(record);
    default:
      throw new AppError(422, `Unknown destination kind "${String(record.kind)}".`);
  }
}

/** Run a connectivity test and turn any failure into one sentence an operator can act on. */
export async function testDestination(record: DestinationRecord): Promise<{ ok: boolean; message: string }> {
  try {
    const adapter = await adapterFor(record);
    return { ok: true, message: await adapter.test() };
  } catch (error) {
    const message = error instanceof AppError ? error.message : (error as Error).message;
    return { ok: false, message: message.slice(0, 500) };
  }
}
