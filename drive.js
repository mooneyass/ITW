// Google Drive storage layer.
//
// Scope is drive.file: this app can only see files it created itself. It cannot
// read anything else in the user's Drive, and because drive.file is a
// non-sensitive scope there is no Google verification step and no weekly
// re-consent.
//
// Layout in Drive:
//   <FOLDER_NAME>/<FILE_NAME>        the whole log, one JSON file
//   <FOLDER_NAME>/<PHOTOS_FOLDER>/   one thumb + one full-size JPEG per vehicle
//
// Photos deliberately live outside the JSON. Conflict detection re-downloads the
// data file before every write, and inlining base64 images would turn a one-second
// autosave into a multi-megabyte round trip.
//
// Conflict detection compares the file's actual contents, not Drive's `version`
// counter — that counter also moves for server-side metadata changes, which
// produced phantom conflicts on a freshly created file.

window.Drive = (() => {
  const SCOPE = "https://www.googleapis.com/auth/drive.file";
  const API = "https://www.googleapis.com/drive/v3";
  const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  const cfg = window.ITW_CONFIG;

  let tokenClient = null;
  let accessToken = null;
  let tokenExpiry = 0;
  let hasSession = false; // signed in at some point; the token itself may have aged out
  let folderId = null;
  let photosFolderId = null;
  let fileId = null;

  class ConflictError extends Error {
    constructor() {
      super("The file changed in Drive since it was loaded here.");
      this.name = "ConflictError";
    }
  }

  class AuthError extends Error {
    constructor(msg) {
      super(msg);
      this.name = "AuthError";
    }
  }

  // ---------------------------------------------------------------- auth

  // Google Identity Services is pulled in on demand rather than from a tag in
  // index.html. That keeps it off the critical path, and lets dev/mock.js stand
  // in for it by defining window.google before this ever runs.
  let gisPromise = null;

  function loadGis() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (gisPromise) return gisPromise;

    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.onload = resolve;
      s.onerror = () => {
        gisPromise = null;
        reject(new AuthError("Could not load Google sign-in. Check your connection."));
      };
      document.head.appendChild(s);
    });
    return gisPromise;
  }

  async function waitForGis(timeoutMs = 10000) {
    await loadGis();
    const started = Date.now();
    while (!window.google?.accounts?.oauth2) {
      if (Date.now() - started > timeoutMs) {
        throw new AuthError("Google sign-in loaded but did not initialise.");
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function initTokenClient() {
    if (tokenClient) return tokenClient;
    await waitForGis();
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: cfg.GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: () => {}, // replaced per request
    });
    return tokenClient;
  }

  // prompt: "" attempts a silent renewal (works once consent has been granted
  // and the user still has a live Google session). "consent" forces the picker.
  async function requestToken(prompt) {
    const client = await initTokenClient();
    return new Promise((resolve, reject) => {
      client.callback = (resp) => {
        if (resp.error) return reject(new AuthError(resp.error_description || resp.error));
        accessToken = resp.access_token;
        // Renew a minute early so a call never fires with a just-expired token.
        tokenExpiry = Date.now() + (Number(resp.expires_in) - 60) * 1000;
        hasSession = true;
        resolve(accessToken);
      };
      client.error_callback = (err) => {
        reject(new AuthError(err?.type || "Sign-in was cancelled."));
      };
      client.requestAccessToken({ prompt });
    });
  }

  async function getToken() {
    if (accessToken && Date.now() < tokenExpiry) return accessToken;
    return requestToken("");
  }

  async function signIn() {
    // Empty prompt first: if consent already exists this is invisible.
    try {
      return await requestToken("");
    } catch {
      return requestToken("consent");
    }
  }

  const signInSilently = () => requestToken("");

  function signOut() {
    const token = accessToken;
    accessToken = null;
    tokenExpiry = 0;
    hasSession = false;
    folderId = null;
    photosFolderId = null;
    fileId = null;
    if (token && window.google?.accounts?.oauth2) {
      google.accounts.oauth2.revoke(token, () => {});
    }
  }

  // Tokens last about an hour, so "is the token still fresh" is the wrong
  // question to gate work on — getToken() renews a stale one silently. This
  // answers "is the user connected at all".
  const hasConnection = () => hasSession;

  // ---------------------------------------------------------------- fetch

  async function api(url, opts = {}, retryOn401 = true) {
    const token = await getToken();
    const res = await fetch(url, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    });

    if (res.status === 401 && retryOn401) {
      accessToken = null;
      tokenExpiry = 0;
      return api(url, opts, false);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Drive API ${res.status}: ${body.slice(0, 300)}`);
    }
    return res;
  }

  const json = async (res) => res.json();

  // Drive query strings are single-quoted; the names are ours, but escape anyway.
  const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  // Data-file calls run one at a time. Overlapping load/save could otherwise read
  // a file mid-write. Photo transfers deliberately stay off this chain — they're
  // slow and unrelated, and queueing a save behind a 200 KB upload would make
  // typing feel stuck.
  let chain = Promise.resolve();
  function serialize(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  // ---------------------------------------------------------------- folders

  async function findOne(query) {
    const url =
      `${API}/files?q=${encodeURIComponent(query)}` +
      `&fields=files(id,name)&spaces=drive&pageSize=1`;
    const { files } = await json(await api(url));
    return files?.[0]?.id || null;
  }

  async function createFolder(name, parent) {
    const res = await api(`${API}/files?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        ...(parent ? { parents: [parent] } : {}),
      }),
    });
    return (await json(res)).id;
  }

  // Single-flight: concurrent callers share one lookup, so a first run can never
  // create two folders.
  const singleFlight = (getCached, setCached) => {
    let inflight = null;
    return (work) => {
      const cached = getCached();
      if (cached) return Promise.resolve(cached);
      if (inflight) return inflight;
      inflight = work()
        .then((id) => {
          setCached(id);
          return id;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    };
  };

  const folderFlight = singleFlight(
    () => folderId,
    (id) => (folderId = id)
  );
  const photosFlight = singleFlight(
    () => photosFolderId,
    (id) => (photosFolderId = id)
  );

  const ensureFolder = () =>
    folderFlight(async () => {
      const found = await findOne(
        `name='${q(cfg.FOLDER_NAME)}' and ` +
          `mimeType='application/vnd.google-apps.folder' and trashed=false`
      );
      return found || createFolder(cfg.FOLDER_NAME, null);
    });

  const ensurePhotosFolder = () =>
    photosFlight(async () => {
      const parent = await ensureFolder();
      const found = await findOne(
        `name='${q(cfg.PHOTOS_FOLDER)}' and '${parent}' in parents and ` +
          `mimeType='application/vnd.google-apps.folder' and trashed=false`
      );
      return found || createFolder(cfg.PHOTOS_FOLDER, parent);
    });

  // ---------------------------------------------------------------- data file

  // Shape and migration are the app's business; this file only moves bytes.
  function emptyDoc() {
    return { schema: 1, updatedAt: new Date().toISOString(), vehicles: [] };
  }

  const serialise = (doc) => JSON.stringify(doc, null, 2);

  async function createFile(body) {
    const boundary = "itw-" + Math.random().toString(36).slice(2);
    const meta = {
      name: cfg.FILE_NAME,
      parents: [folderId],
      mimeType: "application/json",
    };
    const payload =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(meta) +
      `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      body +
      `\r\n--${boundary}--`;

    const res = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: payload,
    });
    return (await json(res)).id;
  }

  let ensuringFile = null;

  function ensureFile() {
    if (fileId) return Promise.resolve(fileId);
    if (ensuringFile) return ensuringFile;

    ensuringFile = (async () => {
      await ensureFolder();
      let id = await findOne(
        `name='${q(cfg.FILE_NAME)}' and '${folderId}' in parents and trashed=false`
      );
      if (!id) id = await createFile(serialise(emptyDoc()));
      fileId = id;
      return id;
    })().finally(() => {
      ensuringFile = null;
    });

    return ensuringFile;
  }

  const downloadRaw = async () => (await api(`${API}/files/${fileId}?alt=media`)).text();

  // Returns { doc, raw }. `raw` is the exact text on the server — hold onto it
  // and pass it back to save() as the conflict baseline.
  function load() {
    return serialize(async () => {
      await ensureFile();
      const raw = await downloadRaw();

      let doc;
      try {
        doc = JSON.parse(raw);
      } catch {
        doc = emptyDoc(); // unreadable file: don't destroy it, just start clean in memory
      }
      return { doc, raw };
    });
  }

  // Writes the file and returns the new baseline text.
  //
  // If expectedRaw is given and the file no longer matches it, another device
  // wrote in the meantime: throws ConflictError rather than clobbering it.
  // Pass null to force the overwrite.
  function save(doc, expectedRaw) {
    return serialize(async () => {
      await ensureFile();

      if (expectedRaw != null && (await downloadRaw()) !== expectedRaw) {
        throw new ConflictError();
      }

      const body = serialise(doc);
      await api(`${UPLOAD}/files/${fileId}?uploadType=media&fields=id`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return body;
    });
  }

  // ---------------------------------------------------------------- photos

  // The multipart body has to be a Blob rather than a string: the image bytes
  // aren't text, and stringifying them corrupts the upload.
  async function uploadPhoto(name, blob) {
    const parent = await ensurePhotosFolder();
    const boundary = "itwphoto-" + Math.random().toString(36).slice(2);
    const type = blob.type || "image/jpeg";
    const head =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name, parents: [parent], mimeType: type }) +
      `\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`;

    const res = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: new Blob([head, blob, `\r\n--${boundary}--`]),
    });
    return (await json(res)).id;
  }

  const downloadPhoto = async (id) => (await api(`${API}/files/${id}?alt=media`)).blob();

  // Best effort. A photo that outlives its vehicle is untidy but harmless, and
  // failing the replace because the old file wouldn't delete would be worse.
  const deletePhoto = (id) =>
    api(`${API}/files/${id}`, { method: "DELETE" }).catch(() => {});

  return {
    ConflictError,
    AuthError,
    signIn,
    signInSilently,
    signOut,
    hasConnection,
    load,
    save,
    emptyDoc,
    uploadPhoto,
    downloadPhoto,
    deletePhoto,
  };
})();
