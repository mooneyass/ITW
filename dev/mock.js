// Dev-only fake Drive, active ONLY with ?mock=1 in the URL. Lets you exercise
// the whole app without a Google client ID. Inert in every other case.
//
// The data file lives in localStorage, so a reload behaves like a second visit
// and you can force a conflict by editing itw.mockDrive in devtools between
// saves. Photo bytes are only held in memory — they're too big for localStorage
// — so a reload loses the fake Drive's copies. The app's own photo cache still
// has them, so the UI looks right; it just can't re-download them, which is a
// fair imitation of being offline.

(() => {
  if (new URLSearchParams(location.search).get("mock") !== "1") return;

  const KEY = "itw.mockDrive";
  console.warn("[mock] Fake Drive active. No data leaves this browser.");

  // Tells app.js to namespace its storage, so test vehicles made here can never
  // be mistaken for real ones and pushed to the real Drive.
  window.ITW_MOCK = true;

  window.ITW_CONFIG.GOOGLE_CLIENT_ID ||= "mock.apps.googleusercontent.com";

  // --- fake Google Identity Services --------------------------------------

  window.google = {
    accounts: {
      oauth2: {
        initTokenClient: () => ({
          callback: null,
          error_callback: null,
          requestAccessToken() {
            setTimeout(
              () => this.callback({ access_token: "mock-token", expires_in: 3600 }),
              50
            );
          },
        }),
        revoke: (_token, done) => done?.(),
      },
    },
  };

  // --- fake Drive backing store -------------------------------------------

  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || {};
    } catch {
      return {};
    }
  };
  const write = (s) => localStorage.setItem(KEY, JSON.stringify(s));

  const photos = new Map(); // id -> Blob
  let photoSeq = 0;

  const ok = (body) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (!/googleapis\.com$/.test(url.hostname)) return realFetch(input, init);

    const state = read();
    const method = (init.method || "GET").toUpperCase();
    const query = url.searchParams.get("q") || "";
    const isUpload = url.pathname.startsWith("/upload/");
    const idMatch = url.pathname.match(/\/files\/([^/?]+)/);
    const id = idMatch?.[1];

    // search — matched on the name in the query, which is all the app ever varies
    if (method === "GET" && !idMatch) {
      let found = null;
      let name = "";
      if (query.includes("'vehicledata'")) [found, name] = [state.folderId, "vehicledata"];
      else if (query.includes("'photos'")) [found, name] = [state.photosId, "photos"];
      else if (query.includes("'vehicles.json'")) [found, name] = [state.fileId, "vehicles.json"];
      return ok({ files: found ? [{ id: found, name }] : [] });
    }

    // create folder
    if (method === "POST" && !isUpload) {
      const meta = JSON.parse(init.body || "{}");
      if (meta.name === "photos") state.photosId = "mock-photos";
      else state.folderId = "mock-folder";
      write(state);
      return ok({ id: meta.name === "photos" ? state.photosId : state.folderId });
    }

    // create file (multipart). A Blob body is a photo; a string body is the JSON.
    if (method === "POST" && isUpload) {
      if (init.body instanceof Blob) {
        const pid = `mock-photo-${++photoSeq}`;
        const bytes = new Uint8Array(await init.body.arrayBuffer());

        // Strip the multipart envelope. The image starts after the *second*
        // blank line (the first ends the JSON metadata part) and ends before
        // the closing boundary.
        const breaks = [];
        for (let i = 0; i + 3 < bytes.length && breaks.length < 2; i++) {
          if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
            breaks.push(i);
            i += 3;
          }
        }
        const boundary = /boundary=(.+)$/.exec(init.headers?.["Content-Type"] || "")?.[1] || "";
        const start = breaks.length >= 2 ? breaks[1] + 4 : 0;
        const end = bytes.length - (boundary ? `\r\n--${boundary}--`.length : 0);

        photos.set(pid, new Blob([bytes.slice(start, end)], { type: "image/jpeg" }));
        return ok({ id: pid });
      }

      const parts = String(init.body).split("\r\n\r\n");
      state.fileId = "mock-file";
      state.content = parts[parts.length - 1].split("\r\n--")[0];
      write(state);
      return ok({ id: state.fileId });
    }

    // download
    if (method === "GET" && id && url.searchParams.get("alt") === "media") {
      if (photos.has(id)) return new Response(photos.get(id), { status: 200 });
      if (id.startsWith("mock-photo")) {
        return new Response("gone", { status: 404 }); // lost to a reload; see the note above
      }
      return ok(state.content ?? '{"schema":1,"vehicles":[]}');
    }

    // overwrite the data file
    if (method === "PATCH" && isUpload) {
      state.content = String(init.body);
      write(state);
      return ok({ id: state.fileId });
    }

    if (method === "DELETE" && id) {
      photos.delete(id);
      return new Response(null, { status: 204 });
    }

    return new Response("mock: unhandled " + method + " " + url.pathname, { status: 400 });
  };
})();
