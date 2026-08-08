// UI + state. Storage lives in drive.js.
//
// One Drive file holds every vehicle and every service record. Photos are
// separate files in Drive, mirrored into a local Cache API bucket so the grid
// paints instantly and keeps working offline.
//
// Screens are driven by the URL hash — "" for the grid, "#sold" for the sold
// grid, "#v/<id>" for one vehicle — so Android's back button walks back out of
// a vehicle instead of closing the app.

(() => {
  const cfg = window.ITW_CONFIG;
  const SAVE_DELAY = 1200;
  const MIN_NOTE_H = 108; // matches .content min-height in app.css

  // Mock mode gets its own storage namespace. Without this, vehicles invented
  // while testing share a cache with the real ones and could be written to the
  // real Drive file on the next sign-in.
  const NS = window.ITW_MOCK ? ".mock" : "";
  const CACHE_KEY = "itw.cache.v1" + NS;
  const SIGNED_IN_KEY = "itw.signedIn.v1" + NS;
  const PENDING_KEY = "itw.pendingPhotos.v1" + NS;
  const PHOTO_CACHE = "itw-photos-v1" + NS;

  const $ = (id) => document.getElementById(id);
  const els = {
    status: $("status"),
    back: $("back-btn"),
    install: $("install-btn"),
    account: $("account-btn"),
    signin: $("signin"),
    signinBtn: $("signin-btn"),
    signinError: $("signin-error"),
    originHint: $("origin-hint"),
    setup: $("setup"),

    gridScreen: $("grid-screen"),
    gridTitle: $("grid-title"),
    grid: $("grid"),
    gridEmpty: $("grid-empty"),
    soldToggle: $("sold-toggle"),

    vehicleScreen: $("vehicle-screen"),
    vPhotoBtn: $("v-photo-btn"),
    vName: $("v-name"),
    vSoldFlag: $("v-sold-flag"),
    vBreakdown: $("v-breakdown"),
    vEdit: $("v-edit"),
    vSoldBtn: $("v-sold-btn"),
    addRecord: $("add-record"),
    records: $("records"),
    recordsEmpty: $("records-empty"),

    vehicleDlg: $("vehicle-dlg"),
    vehicleDlgTitle: $("vehicle-dlg-title"),
    vehicleDlgError: $("vehicle-dlg-error"),
    vehicleSave: $("vehicle-save"),
    pickPhoto: $("pick-photo"),
    clearPhoto: $("clear-photo"),
    photoBusy: $("photo-busy"),
    photoHint: $("photo-hint"),
    photoFile: $("photo-file"),
    fYear: $("f-year"),
    fMake: $("f-make"),
    fModel: $("f-model"),

    soldDlg: $("sold-dlg"),
    soldWhat: $("sold-what"),
    deleteDlg: $("delete-dlg"),
    deleteWhat: $("delete-what"),
    conflictDlg: $("conflict-dlg"),
    photoDlg: $("photo-dlg"),
    photoBig: $("photo-big"),
  };

  let doc = { schema: 1, updatedAt: null, vehicles: [] };
  let baseline = null;     // exact file text last seen in Drive, for conflict checks
  let dirty = false;       // local edits not yet in Drive
  let saving = false;
  let editSeq = 0;         // bumped on every edit, to detect edits during a save
  let saveTimer = null;
  let appVisible = false;
  let expandedId = null;   // record open on the vehicle screen
  let editingId = null;    // vehicle being edited in the dialog; null while adding
  let pendingSoldId = null;
  let pendingDeleteId = null;

  // ------------------------------------------------------------- helpers

  const uid = () =>
    crypto.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const now = () => new Date().toISOString();

  const pad = (n) => String(n).padStart(2, "0");

  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  // "2026-07-14" as a local date. new Date(str) would read it as UTC midnight,
  // which renders as the day before anywhere west of Greenwich.
  function parseDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }

  // An ISO instant as the local calendar day. Slicing the string instead would
  // show tomorrow's date all evening, since the stored stamp is UTC.
  function localDay(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? null
      : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function fmtDate(s) {
    const d = parseDate(s);
    if (!d) return "—";
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "2-digit" });
  }

  // Plain decimal formatting with the symbol pasted on the front. Intl's
  // currency mode drags the country prefix along — "CA$89", "US$89" — which is
  // noise on a log where every number is in the same currency anyway.
  const moneyFmt = {};
  function fmtMoney(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    // Whole amounts lose the ".00" — a log full of "$89.00" is just noise.
    const frac = Math.abs(n % 1) > 0.004 ? 2 : 0;
    moneyFmt[frac] ||= new Intl.NumberFormat(undefined, {
      minimumFractionDigits: frac,
      maximumFractionDigits: frac,
    });
    return cfg.CURRENCY_SYMBOL + moneyFmt[frac].format(n);
  }

  const fmtDistance = (n) =>
    n == null || !Number.isFinite(n) ? "" : `${n.toLocaleString()} ${cfg.DISTANCE_UNIT}`;

  function vehicleName(v) {
    const s = [v.year, v.make, v.model].filter(Boolean).join(" ");
    return s || "Untitled vehicle";
  }

  function setStatus(text, warn = false) {
    els.status.textContent = text;
    els.status.classList.toggle("warn", warn);
  }

  function shortErr(err) {
    return String(err?.message || err).split("\n")[0].slice(0, 120);
  }

  function setAppVisible(visible) {
    appVisible = visible;
    render();
  }

  function placeholder() {
    const wrap = document.createElement("div");
    wrap.className = "thumb-ph";
    wrap.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4 12l1.7-4.4A2.5 2.5 0 0 1 8 6h8a2.5 2.5 0 0 1 2.3 1.6L20 12"/>' +
      '<path d="M3.2 12h17.6v4a1 1 0 0 1-1 1H4.2a1 1 0 0 1-1-1z"/>' +
      '<circle cx="7.4" cy="17.4" r="1.5"/><circle cx="16.6" cy="17.4" r="1.5"/></svg>';
    return wrap;
  }

  // ------------------------------------------------------------- shape
  // Accepts anything that might be in the file — including one hand-edited in
  // Drive — and returns a valid document.

  function normalize(raw) {
    const TYPES = cfg.SERVICE_TYPES;
    const typeSet = new Set(TYPES);

    const num = (x) => {
      if (x === "" || x == null) return null;
      const n = Number(x);
      return Number.isFinite(n) ? n : null;
    };
    const str = (x, max) => (typeof x === "string" ? x.trim().slice(0, max) : "");
    const strOrNull = (x) => (typeof x === "string" && x ? x : null);
    const dateOf = (x) => {
      const s = String(x ?? "");
      return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : todayISO();
    };

    const mkRecord = (r) => ({
      id: r?.id || uid(),
      date: dateOf(r?.date),
      mileage: num(r?.mileage),
      type: typeSet.has(r?.type) ? r.type : TYPES[0],
      cost: num(r?.cost),
      notes: typeof r?.notes === "string" ? r.notes : "",
      createdAt: r?.createdAt || now(),
      updatedAt: r?.updatedAt || r?.createdAt || now(),
    });

    const mkVehicle = (v) => {
      const records = (Array.isArray(v?.records) ? v.records : []).map(mkRecord);
      sortRecords(records);
      const year = num(v?.year);
      return {
        id: v?.id || uid(),
        year: year && year > 1800 && year < 2200 ? Math.round(year) : null,
        make: str(v?.make, 40),
        model: str(v?.model, 60),
        // Bumped every time the photo is replaced, so another device knows its
        // cached copy is stale without having to compare bytes.
        photoRev: strOrNull(v?.photoRev),
        thumbFileId: strOrNull(v?.thumbFileId),
        photoFileId: strOrNull(v?.photoFileId),
        soldAt: v?.soldAt ? String(v.soldAt) : null,
        createdAt: v?.createdAt || now(),
        records,
      };
    };

    const vehicles = (Array.isArray(raw?.vehicles) ? raw.vehicles : []).map(mkVehicle);
    // Grid order is the order they were added — stable, and new ones land next
    // to the + tile rather than jumping into the middle.
    vehicles.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    return { schema: 1, updatedAt: raw?.updatedAt || now(), vehicles };
  }

  // Newest first. Two records on the same day fall back to entry order, so a
  // pair added minutes apart doesn't shuffle on every reload.
  const sortRecords = (records) =>
    records.sort(
      (a, b) =>
        String(b.date).localeCompare(String(a.date)) ||
        String(b.createdAt).localeCompare(String(a.createdAt))
    );

  function totals(v) {
    const by = Object.fromEntries(cfg.SERVICE_TYPES.map((t) => [t, 0]));
    let total = 0;
    for (const r of v.records) {
      const c = Number(r.cost) || 0;
      total += c;
      if (by[r.type] != null) by[r.type] += c;
    }
    return { total, by };
  }

  // ------------------------------------------------------------- cache
  // Local mirror so the app opens instantly and keeps working offline.

  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ doc, baseline, dirty }));
    } catch {
      /* private mode / quota — Drive is still the source of truth */
    }
  }

  function loadCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (!c?.doc) return false;
      doc = normalize(c.doc);
      baseline = typeof c.baseline === "string" ? c.baseline : null;
      dirty = Boolean(c.dirty);
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------- photos
  //
  // Two JPEGs per vehicle: a thumb for the grid and header, and a full size for
  // the lightbox. Both are resized here, on the device that picked the file, so
  // a 4 MB phone photo never crosses the wire.
  //
  // Local copies live in the Cache API keyed by vehicle + revision, which is
  // what makes the grid work offline and on the second visit. Drive file ids are
  // only needed to fetch a photo the *other* device took.

  const memPhotos = new Map(); // key -> Blob, for browsers with no Cache API
  const objUrls = new Map();   // key -> object URL, created once per session
  const inflight = new Map();

  const photoKey = (vid, rev, kind) => `${location.origin}/__photo/${vid}/${rev}/${kind}`;

  async function photoCache() {
    try {
      return await caches.open(PHOTO_CACHE);
    } catch {
      return null; // no Cache API (or an insecure origin) — memory only
    }
  }

  async function putBlob(vid, rev, kind, blob) {
    const key = photoKey(vid, rev, kind);
    memPhotos.set(key, blob);
    const c = await photoCache();
    if (c) await c.put(key, new Response(blob)).catch(() => {});
  }

  async function getBlob(vid, rev, kind) {
    const key = photoKey(vid, rev, kind);
    if (memPhotos.has(key)) return memPhotos.get(key);
    const c = await photoCache();
    const res = c && (await c.match(key).catch(() => null));
    if (!res) return null;
    const blob = await res.blob();
    memPhotos.set(key, blob);
    return blob;
  }

  function forgetPhotos(vid, rev) {
    if (!rev) return;
    for (const kind of ["thumb", "full"]) {
      const key = photoKey(vid, rev, kind);
      const url = objUrls.get(key);
      if (url) URL.revokeObjectURL(url);
      objUrls.delete(key);
      memPhotos.delete(key);
    }
    photoCache().then((c) => {
      if (c) for (const k of ["thumb", "full"]) c.delete(photoKey(vid, rev, k)).catch(() => {});
    });
  }

  // Resolves to an object URL, or null when there's nothing to show yet —
  // offline on a device that has never seen this photo, for instance.
  function photoUrl(v, kind) {
    if (!v.photoRev) return Promise.resolve(null);
    const key = photoKey(v.id, v.photoRev, kind);
    if (objUrls.has(key)) return Promise.resolve(objUrls.get(key));
    if (inflight.has(key)) return inflight.get(key);

    const job = (async () => {
      let blob = await getBlob(v.id, v.photoRev, kind);
      if (!blob) {
        const fileId = kind === "thumb" ? v.thumbFileId : v.photoFileId;
        if (!fileId || !navigator.onLine || !Drive.hasConnection()) return null;
        blob = await Drive.downloadPhoto(fileId).catch(() => null);
        if (!blob) return null;
        await putBlob(v.id, v.photoRev, kind, blob);
      }
      const url = URL.createObjectURL(blob);
      objUrls.set(key, url);
      return url;
    })();

    inflight.set(key, job);
    job.finally(() => inflight.delete(key));
    return job;
  }

  // Fills a container with the placeholder now and the real image whenever it
  // arrives. The dataset stamp stops a slow download from painting into a tile
  // that has since been re-rendered for a different vehicle.
  function fillPhoto(el, v, kind = "thumb") {
    const stamp = `${v.id}/${v.photoRev}`;
    el.dataset.photoFor = stamp;
    el.replaceChildren(placeholder());
    if (!v.photoRev) return;
    photoUrl(v, kind).then((url) => {
      if (!url || el.dataset.photoFor !== stamp) return;
      const img = document.createElement("img");
      if (kind === "thumb") img.className = "thumb";
      img.alt = vehicleName(v);
      img.src = url;
      el.replaceChildren(img);
    });
  }

  async function resize(file, maxPx) {
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      try {
        bmp = await createImageBitmap(file); // older browsers reject the options bag
      } catch {
        throw new Error(
          "Couldn't read that image. iPhone HEIC files only convert on the phone itself."
        );
      }
    }

    const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    bmp.close?.();

    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Couldn't process that image."))),
        "image/jpeg",
        cfg.JPEG_QUALITY
      )
    );
  }

  // --- upload queue
  //
  // A photo is usable the moment it's picked, whether or not the phone has
  // signal. The blobs sit in the local cache and this queue pushes them to Drive
  // when there's a connection.

  const readPending = () => {
    try {
      const a = JSON.parse(localStorage.getItem(PENDING_KEY));
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
  };

  const writePending = (a) => {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify(a));
    } catch {
      /* private mode — the upload just won't survive a reload */
    }
  };

  // rev of null means "no new photo, only clean up the old files".
  function queuePhoto(vid, rev, oldIds = []) {
    const all = readPending();
    // A newer pick supersedes an older pending one, but its list of files to
    // tidy up has to ride along or those become orphans in Drive.
    const carried = all.filter((p) => p.vid === vid).flatMap((p) => p.oldIds || []);
    const rest = all.filter((p) => p.vid !== vid);
    rest.push({ vid, rev, oldIds: [...carried, ...oldIds].filter(Boolean) });
    writePending(rest);
  }

  const dropPending = (vid) => writePending(readPending().filter((p) => p.vid !== vid));

  let uploading = false;

  async function flushPhotos() {
    if (uploading || !Drive.hasConnection() || !navigator.onLine) return;
    const queue = readPending();
    if (!queue.length) return;

    uploading = true;
    try {
      for (const job of queue) {
        const v = doc.vehicles.find((x) => x.id === job.vid);

        // Nothing to upload: either the photo was cleared, or the vehicle is
        // gone. Either way the old files should still go.
        if (!job.rev || !v || v.photoRev !== job.rev) {
          for (const id of job.oldIds || []) Drive.deletePhoto(id);
          dropPending(job.vid);
          continue;
        }

        const thumb = await getBlob(job.vid, job.rev, "thumb");
        const full = await getBlob(job.vid, job.rev, "full");
        if (!thumb || !full) {
          dropPending(job.vid); // cache evicted before we got to it; nothing to send
          continue;
        }

        setStatus("Uploading photo…");
        const base = `${job.vid}-${job.rev}`;
        const thumbId = await Drive.uploadPhoto(`${base}-thumb.jpg`, thumb);
        const photoId = await Drive.uploadPhoto(`${base}.jpg`, full);

        // Replaced again while those were in flight — the pair just uploaded is
        // already stale, so throw it away rather than point the vehicle at it.
        if (v.photoRev !== job.rev) {
          Drive.deletePhoto(thumbId);
          Drive.deletePhoto(photoId);
          continue;
        }

        v.thumbFileId = thumbId;
        v.photoFileId = photoId;
        for (const id of job.oldIds || []) Drive.deletePhoto(id);
        dropPending(job.vid);
        touch();
      }
      if (!readPending().length && !dirty) setStatus("Saved");
    } catch (err) {
      setStatus("Photo not uploaded — " + shortErr(err), true);
    } finally {
      uploading = false;
    }
  }

  // ------------------------------------------------------------- routing

  function currentRoute() {
    const h = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (h === "sold") return { screen: "sold" };
    const m = /^v\/(.+)$/.exec(h);
    return m ? { screen: "vehicle", id: m[1] } : { screen: "grid" };
  }

  const go = (hash) => {
    if (location.hash.replace(/^#/, "") === hash) render();
    else location.hash = hash;
  };

  // ------------------------------------------------------------- render

  function render() {
    const route = currentRoute();
    const vehicle =
      route.screen === "vehicle" ? doc.vehicles.find((v) => v.id === route.id) : null;

    // Deep link to something that isn't there any more.
    if (route.screen === "vehicle" && !vehicle && appVisible) return go("");

    const onVehicle = route.screen === "vehicle" && vehicle;
    els.gridScreen.hidden = !appVisible || onVehicle;
    els.vehicleScreen.hidden = !appVisible || !onVehicle;
    els.back.hidden = !appVisible || route.screen === "grid";

    if (!appVisible) return;
    if (onVehicle) renderVehicle(vehicle);
    else renderGrid(route.screen === "sold");
  }

  function renderGrid(showSold) {
    const shown = doc.vehicles.filter((v) => (showSold ? v.soldAt : !v.soldAt));
    const soldCount = doc.vehicles.filter((v) => v.soldAt).length;

    els.gridTitle.hidden = !showSold;

    const frag = document.createDocumentFragment();
    for (const v of shown) frag.appendChild(vehicleCard(v));

    if (!showSold) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "addcard";
      add.textContent = "+";
      add.title = "Add a vehicle";
      add.setAttribute("aria-label", "Add a vehicle");
      add.addEventListener("click", () => openVehicleDialog(null));
      frag.appendChild(add);
    }

    els.grid.replaceChildren(frag);

    els.gridEmpty.hidden = shown.length > 0;
    els.gridEmpty.textContent = showSold
      ? "Nothing sold yet."
      : "No vehicles yet — tap + to add your first.";

    els.soldToggle.hidden = showSold || soldCount === 0;
    els.soldToggle.textContent = `Sold (${soldCount})`;
  }

  function vehicleCard(v) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "vcard" + (v.soldAt ? " sold" : "");
    card.addEventListener("click", () => go(`v/${encodeURIComponent(v.id)}`));

    const slot = document.createElement("div");
    fillPhoto(slot, v, "thumb");

    const cap = document.createElement("div");
    cap.className = "vcap";

    const ym = document.createElement("div");
    ym.className = "ym";
    ym.textContent = [v.year, v.make].filter(Boolean).join(" ") || " ";

    const md = document.createElement("div");
    md.className = "md";
    md.textContent = v.model || vehicleName(v);

    cap.append(ym, md);
    card.append(slot, cap);
    return card;
  }

  function renderVehicle(v) {
    fillPhoto(els.vPhotoBtn, v, "thumb");
    els.vName.textContent = vehicleName(v);

    // The header carries the photo and the name and nothing else. What it cost
    // is the breakdown's job, right underneath.
    const { by } = totals(v);

    els.vBreakdown.replaceChildren(
      ...cfg.SERVICE_TYPES.map((t) => {
        const cell = document.createElement("div");
        cell.className = "bcell";
        const k = document.createElement("div");
        k.className = "k";
        k.textContent = t;
        const val = document.createElement("div");
        val.className = "v";
        val.textContent = fmtMoney(by[t]);
        cell.append(k, val);
        return cell;
      })
    );

    els.vSoldFlag.hidden = !v.soldAt;
    if (v.soldAt) els.vSoldFlag.textContent = `Sold ${fmtDate(localDay(v.soldAt))}`;

    els.vSoldBtn.textContent = v.soldAt ? "Back in the Garage" : "Sold";
    els.vSoldBtn.className = v.soldAt ? "accent" : "danger";

    els.records.replaceChildren(...v.records.map((r) => renderRecord(r, v)));
    sizeOpenNote();

    els.recordsEmpty.hidden = v.records.length > 0;
  }

  function renderRecord(r, v) {
    const li = document.createElement("li");
    li.className = "item" + (r.id === expandedId ? " open" : "");
    li.dataset.id = r.id;

    // --- collapsed row
    const open = document.createElement("button");
    open.type = "button";
    open.className = "rec-open";
    open.addEventListener("click", () => toggle(r.id));

    const date = document.createElement("span");
    date.className = "rec-date";
    date.textContent = fmtDate(r.date);

    const mid = document.createElement("span");
    mid.className = "rec-mid";
    const type = document.createElement("span");
    type.className = "rec-type";
    type.textContent = r.type;
    const dist = document.createElement("span");
    dist.className = "rec-dist";
    dist.textContent = fmtDistance(r.mileage);
    mid.append(type, document.createElement("br"), dist);

    const cost = document.createElement("span");
    cost.className = "rec-cost";
    cost.textContent = fmtMoney(r.cost);

    open.append(date, mid, cost);

    const chev = document.createElement("button");
    chev.type = "button";
    chev.className = "chev";
    chev.setAttribute("aria-label", r.id === expandedId ? "Collapse" : "Expand");
    chev.addEventListener("click", () => toggle(r.id));

    const row = document.createElement("div");
    row.className = "row";
    row.append(open, chev);

    // --- expanded panel
    const grid = document.createElement("div");
    grid.className = "form-grid";

    const dateIn = field(grid, "Date", "date", { value: r.date });
    dateIn.addEventListener("change", () => {
      r.date = dateIn.value || todayISO();
      stampEdit(r);
      sortRecords(v.records); // a corrected date can move the row up the list
      render();
    });

    // "Mileage" would be a lie once the unit is km, and the label is the only
    // place the unit appears while you're typing into the box.
    const milesIn = field(grid, `Odometer (${cfg.DISTANCE_UNIT})`, "number", {
      value: r.mileage ?? "",
      min: "0",
      step: "1",
      inputmode: "numeric",
      placeholder: "48210",
    });
    milesIn.addEventListener("input", () => {
      r.mileage = milesIn.value === "" ? null : Number(milesIn.value);
      stampEdit(r);
    });

    const typeIn = select(grid, "Type", cfg.SERVICE_TYPES, r.type);
    typeIn.addEventListener("change", () => {
      r.type = typeIn.value;
      stampEdit(r);
    });

    const costIn = field(grid, "Cost", "number", {
      value: r.cost ?? "",
      min: "0",
      step: "0.01",
      inputmode: "decimal",
      placeholder: "0.00",
    });
    costIn.addEventListener("input", () => {
      r.cost = costIn.value === "" ? null : Number(costIn.value);
      stampEdit(r);
    });

    const notes = document.createElement("textarea");
    notes.className = "content";
    notes.value = r.notes;
    notes.placeholder = "Parts, shop, what you noticed…";
    notes.addEventListener("input", () => {
      r.notes = notes.value;
      autoGrow(notes);
      stampEdit(r);
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "Delete";
    del.addEventListener("click", () => askDelete(r));

    const actions = document.createElement("div");
    actions.className = "panel-actions";
    actions.appendChild(del);

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.append(grid, notes, actions);

    li.append(row, panel);
    return li;
  }

  // The collapsed row is hidden while the panel is open, so edits deliberately
  // don't re-render — that would tear focus out of the input being typed into.
  // The row catches up when it collapses.
  function stampEdit(r) {
    r.updatedAt = now();
    touch();
  }

  function field(parent, label, type, attrs = {}) {
    const wrap = document.createElement("label");
    wrap.className = "field span2";
    const span = document.createElement("span");
    span.textContent = label;
    const input = document.createElement("input");
    input.type = type;
    for (const [k, val] of Object.entries(attrs)) {
      if (val !== "" && val != null) input.setAttribute(k, String(val));
    }
    if (attrs.value != null) input.value = String(attrs.value);
    wrap.append(span, input);
    parent.appendChild(wrap);
    return input;
  }

  function select(parent, label, options, value) {
    const wrap = document.createElement("label");
    wrap.className = "field span2";
    const span = document.createElement("span");
    span.textContent = label;
    const sel = document.createElement("select");
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = o;
      opt.textContent = o;
      opt.selected = o === value;
      sel.appendChild(opt);
    }
    wrap.append(span, sel);
    parent.appendChild(wrap);
    return sel;
  }

  // Grows the notes box to fit its text. "auto" first so it can shrink again
  // when text is deleted, not just grow.
  function autoGrow(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.max(ta.scrollHeight + 2, MIN_NOTE_H) + "px";
  }

  // Called after the list is in the document — a textarea that hasn't been laid
  // out reports no scrollHeight, so this can't be done while building the row.
  function sizeOpenNote() {
    const ta = els.records.querySelector(".item.open .content");
    if (ta) autoGrow(ta);
  }

  function toggle(id) {
    expandedId = expandedId === id ? null : id;
    render();
  }

  function touch() {
    doc.updatedAt = now();
    dirty = true;
    editSeq++;
    saveCache();
    scheduleSave();
  }

  // ------------------------------------------------------------- vehicles

  let dlgPhoto = null;    // { thumb, full } picked in the dialog, not yet applied
  let dlgCleared = false; // the existing photo was removed
  let dlgPreviewUrl = null;
  let dlgPhotoJob = null; // in-flight resize, if any

  // Resizing a 12 MP phone photo takes long enough that Save is reachable
  // before it lands, and saving then would file the vehicle with no photo and
  // no complaint. Rather than disable the button — a tap that does nothing
  // reads as a broken app — the save waits for the resize and says so.
  function setDlgBusy(busy) {
    els.photoBusy.hidden = !busy;
    els.photoHint.hidden = busy;
  }

  function openVehicleDialog(v) {
    editingId = v?.id ?? null;
    dlgPhoto = null;
    dlgCleared = false;
    dlgPhotoJob = null;
    setDlgBusy(false);

    els.vehicleDlgTitle.textContent = v ? "Edit vehicle" : "Add a vehicle";
    els.vehicleSave.textContent = v ? "Save" : "Add vehicle";
    els.vehicleDlgError.hidden = true;

    els.fYear.value = v?.year ?? "";
    els.fMake.value = v?.make ?? "";
    els.fModel.value = v?.model ?? "";

    if (v) fillPhoto(els.pickPhoto, v, "thumb");
    else els.pickPhoto.replaceChildren(placeholder());

    els.clearPhoto.hidden = !v?.photoRev;
    els.vehicleDlg.showModal();
  }

  function showDlgPreview(blob) {
    if (dlgPreviewUrl) URL.revokeObjectURL(dlgPreviewUrl);
    dlgPreviewUrl = URL.createObjectURL(blob);
    const img = document.createElement("img");
    img.alt = "";
    img.src = dlgPreviewUrl;
    els.pickPhoto.dataset.photoFor = "picked"; // stop a slow fetch overwriting it
    els.pickPhoto.replaceChildren(img);
    els.clearPhoto.hidden = false;
  }

  function onPhotoPicked(file) {
    if (!file) return;
    els.vehicleDlgError.hidden = true;
    setDlgBusy(true);

    dlgPhotoJob = (async () => {
      try {
        const [thumb, full] = await Promise.all([
          resize(file, cfg.THUMB_PX),
          resize(file, cfg.PHOTO_PX),
        ]);
        dlgPhoto = { thumb, full };
        dlgCleared = false;
        showDlgPreview(thumb);
      } catch (err) {
        els.vehicleDlgError.textContent = shortErr(err);
        els.vehicleDlgError.hidden = false;
      } finally {
        setDlgBusy(false);
      }
    })();
  }

  let dlgSaving = false;

  async function saveVehicleDialog() {
    if (dlgSaving) return; // impatient second tap while the resize finishes
    dlgSaving = true;
    try {
      await saveVehicle();
    } finally {
      dlgSaving = false;
    }
  }

  async function saveVehicle() {
    if (dlgPhotoJob) await dlgPhotoJob;

    const year = els.fYear.value.trim() === "" ? null : Number(els.fYear.value);
    const make = els.fMake.value.trim().slice(0, 40);
    const model = els.fModel.value.trim().slice(0, 60);

    if (!make || !model) {
      els.vehicleDlgError.textContent = "Give it at least a make and a model.";
      els.vehicleDlgError.hidden = false;
      return;
    }

    let v = editingId ? doc.vehicles.find((x) => x.id === editingId) : null;
    const isNew = !v;
    if (isNew) {
      v = {
        id: uid(),
        year: null,
        make: "",
        model: "",
        photoRev: null,
        thumbFileId: null,
        photoFileId: null,
        soldAt: null,
        createdAt: now(),
        records: [],
      };
      doc.vehicles.push(v);
    }

    v.year = Number.isFinite(year) && year > 1800 && year < 2200 ? Math.round(year) : null;
    v.make = make;
    v.model = model;

    if (dlgPhoto || dlgCleared) {
      const oldIds = [v.thumbFileId, v.photoFileId].filter(Boolean);
      const oldRev = v.photoRev;
      const newRev = dlgPhoto ? uid() : null;

      // Point at the new revision first, then drop the old one — a render in
      // between should find the new photo, not an empty tile.
      v.photoRev = newRev;
      v.thumbFileId = null;
      v.photoFileId = null;

      if (dlgPhoto) {
        await putBlob(v.id, newRev, "thumb", dlgPhoto.thumb);
        await putBlob(v.id, newRev, "full", dlgPhoto.full);
      }
      forgetPhotos(v.id, oldRev);
      queuePhoto(v.id, newRev, oldIds);
    }

    els.vehicleDlg.close();
    touch();

    if (isNew) go(`v/${encodeURIComponent(v.id)}`);
    else render();

    flushPhotos();
  }

  function addRecord() {
    const v = doc.vehicles.find((x) => x.id === currentRoute().id);
    if (!v) return;
    const stamp = now();
    const rec = {
      id: uid(),
      date: todayISO(),
      mileage: null,
      type: cfg.SERVICE_TYPES[0],
      cost: null,
      notes: "",
      createdAt: stamp,
      updatedAt: stamp,
    };
    v.records.unshift(rec);
    sortRecords(v.records);
    expandedId = rec.id;
    touch();
    render();
    // Date is already filled in, so mileage is the first thing worth typing.
    els.records
      .querySelector(`[data-id="${CSS.escape(rec.id)}"] input[type="number"]`)
      ?.focus();
  }

  function askDelete(r) {
    pendingDeleteId = r.id;
    els.deleteWhat.textContent = `${r.type} on ${fmtDate(r.date)}${
      r.cost != null ? ` — ${fmtMoney(r.cost)}` : ""
    } will be removed.`;
    els.deleteDlg.showModal();
  }

  function doDelete() {
    const v = doc.vehicles.find((x) => x.id === currentRoute().id);
    if (!v) return;
    v.records = v.records.filter((r) => r.id !== pendingDeleteId);
    if (expandedId === pendingDeleteId) expandedId = null;
    pendingDeleteId = null;
    touch();
    render();
  }

  function askSold() {
    const v = doc.vehicles.find((x) => x.id === currentRoute().id);
    if (!v) return;

    // Restoring isn't destructive, so it doesn't ask.
    if (v.soldAt) {
      v.soldAt = null;
      touch();
      render();
      return;
    }

    pendingSoldId = v.id;
    els.soldWhat.textContent =
      `“${vehicleName(v)}” moves out of the garage. Its ${v.records.length === 1 ? "record" : "records"}, ` +
      `photo and totals are all kept — you'll find it under Sold, and you can bring it back.`;
    els.soldDlg.showModal();
  }

  function doSold() {
    const v = doc.vehicles.find((x) => x.id === pendingSoldId);
    pendingSoldId = null;
    if (!v) return;
    v.soldAt = now();
    touch();
    go("");
  }

  async function openLightbox() {
    const v = doc.vehicles.find((x) => x.id === currentRoute().id);
    if (!v?.photoRev) return;
    const url = (await photoUrl(v, "full")) || (await photoUrl(v, "thumb"));
    if (!url) {
      setStatus("That photo isn't on this device yet.", true);
      return;
    }
    els.photoBig.src = url;
    els.photoBig.alt = vehicleName(v);
    els.photoDlg.showModal();
  }

  // ------------------------------------------------------------- syncing

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DELAY);
  }

  async function flush() {
    if (!dirty || saving) return;
    if (!Drive.hasConnection()) return;

    if (!navigator.onLine) {
      setStatus("Offline — saved on this device");
      return;
    }

    saving = true;
    const seqAtStart = editSeq;
    setStatus("Saving…");
    try {
      baseline = await Drive.save(doc, baseline);
      if (editSeq === seqAtStart) {
        dirty = false;
        setStatus("Saved");
      } else {
        scheduleSave(); // edits landed mid-save; write again
      }
      saveCache();
      flushPhotos();
    } catch (err) {
      if (err instanceof Drive.ConflictError) {
        setStatus("Conflict — needs a decision", true);
        els.conflictDlg.showModal();
      } else if (!navigator.onLine) {
        setStatus("Offline — saved on this device");
      } else if (err instanceof Drive.AuthError) {
        // Token aged out and couldn't be renewed without a prompt. Edits stay
        // in the local cache and go up once the user signs in again.
        showSignedOut("Your session expired. Sign in again to save your changes.", true);
      } else {
        setStatus("Not saved — " + shortErr(err), true);
      }
    } finally {
      saving = false;
    }
  }

  function adopt(remote) {
    doc = normalize(remote.doc);
    baseline = remote.raw;
    saveCache();
    setAppVisible(true);
  }

  async function pullRemote() {
    const remote = await Drive.load();

    if (!dirty) {
      adopt(remote);
      setStatus("Saved");
      flushPhotos();
      return;
    }

    // Local edits waiting. If they were made on top of what Drive still has,
    // just push them; otherwise the other device got there first.
    if (baseline != null && remote.raw === baseline) {
      await flush();
    } else {
      setStatus("Conflict — needs a decision", true);
      els.conflictDlg.showModal();
    }
  }

  async function resolveConflict(keepMine) {
    els.conflictDlg.close();
    try {
      if (keepMine) {
        baseline = await Drive.save(doc, null); // null = force overwrite
        dirty = false;
        saveCache();
      } else {
        adopt(await Drive.load());
        dirty = false;
        saveCache();
      }
      setStatus("Saved");
      flushPhotos();
    } catch (err) {
      setStatus("Not saved — " + shortErr(err), true);
    }
  }

  // ------------------------------------------------------------- screens

  function showSignedIn() {
    els.signin.hidden = true;
    els.account.hidden = false;
    // Don't reveal an empty grid before the data lands — there'd be a lone +
    // tile suggesting you own nothing. adopt() reveals it once there's a doc.
    setAppVisible(doc.vehicles.length > 0);
  }

  // keepScreen: leave the app on screen and put the sign-in card above it. Used
  // when a session expires mid-edit — yanking the user's work off the screen
  // would look like data loss, even though the cache still has it.
  function showSignedOut(message, keepScreen = false) {
    if (!keepScreen) setAppVisible(false);
    els.signin.hidden = false;
    els.account.hidden = true;
    els.signinError.hidden = !message;
    els.signinError.textContent = message || "";

    // Google matches origins exactly, so when sign-in fails the most likely
    // cause is this origin not being on the list. Name it rather than make
    // them guess.
    els.originHint.hidden = !message;
    els.originHint.textContent = message
      ? `This app is running at ${location.origin}. That exact address has to be ` +
        `listed under "Authorized JavaScript origins" on your Google OAuth client.`
      : "";

    setStatus(keepScreen ? "Not saved — sign in again" : "Signed out", keepScreen);
  }

  async function connect() {
    setStatus("Loading…");
    showSignedIn();
    try {
      await pullRemote();
      localStorage.setItem(SIGNED_IN_KEY, "1");
    } catch (err) {
      setStatus("Couldn't reach Drive — " + shortErr(err), true);
    }
  }

  // ------------------------------------------------------------- boot

  async function boot() {
    if (!cfg.GOOGLE_CLIENT_ID) {
      els.setup.hidden = false;
      setStatus("Not configured");
      return;
    }

    // Paint from cache first so the app is usable before the network answers.
    if (loadCache()) {
      setAppVisible(true);
      setStatus(dirty ? "Unsaved changes on this device" : "…");
    }

    if (localStorage.getItem(SIGNED_IN_KEY) === "1") {
      try {
        await Drive.signInSilently();
        await connect();
        return;
      } catch {
        /* consent expired or no live Google session — fall through */
      }
    }
    showSignedOut(dirty ? "Sign in to save the changes waiting on this device." : "", dirty);
  }

  // ------------------------------------------------------------- wiring

  window.addEventListener("hashchange", () => {
    expandedId = null;
    render();
  });

  els.back.addEventListener("click", () => {
    const route = currentRoute();
    if (route.screen !== "vehicle") return go("");
    // A sold vehicle belongs to the sold grid — that's where "back" means.
    const v = doc.vehicles.find((x) => x.id === route.id);
    go(v?.soldAt ? "sold" : "");
  });

  els.soldToggle.addEventListener("click", () => go("sold"));

  els.signinBtn.addEventListener("click", async () => {
    els.signinError.hidden = true;
    try {
      await Drive.signIn();
      await connect();
    } catch (err) {
      showSignedOut(shortErr(err));
    }
  });

  els.account.addEventListener("click", () => {
    Drive.signOut();
    localStorage.removeItem(SIGNED_IN_KEY);
    showSignedOut();
  });

  els.vEdit.addEventListener("click", () => {
    const v = doc.vehicles.find((x) => x.id === currentRoute().id);
    if (v) openVehicleDialog(v);
  });

  els.vSoldBtn.addEventListener("click", askSold);
  els.addRecord.addEventListener("click", addRecord);
  els.vPhotoBtn.addEventListener("click", openLightbox);

  $("photo-close").addEventListener("click", () => els.photoDlg.close());

  els.pickPhoto.addEventListener("click", () => els.photoFile.click());
  $("pick-photo-btn").addEventListener("click", () => els.photoFile.click());

  els.photoFile.addEventListener("change", () => {
    onPhotoPicked(els.photoFile.files?.[0]);
    els.photoFile.value = ""; // so picking the same file twice still fires
  });

  els.clearPhoto.addEventListener("click", () => {
    dlgPhoto = null;
    dlgCleared = true;
    els.pickPhoto.dataset.photoFor = "picked";
    els.pickPhoto.replaceChildren(placeholder());
    els.clearPhoto.hidden = true;
  });

  $("vehicle-cancel").addEventListener("click", () => els.vehicleDlg.close());
  els.vehicleSave.addEventListener("click", saveVehicleDialog);

  $("sold-cancel").addEventListener("click", () => els.soldDlg.close());
  $("sold-confirm").addEventListener("click", () => {
    els.soldDlg.close();
    doSold();
  });
  els.soldDlg.addEventListener("close", () => (pendingSoldId = null));

  $("delete-cancel").addEventListener("click", () => els.deleteDlg.close());
  $("delete-confirm").addEventListener("click", () => {
    els.deleteDlg.close();
    doDelete();
  });
  els.deleteDlg.addEventListener("close", () => (pendingDeleteId = null));

  $("conflict-theirs").addEventListener("click", () => resolveConflict(false));
  $("conflict-mine").addEventListener("click", () => resolveConflict(true));

  // Pick up the other device's changes when this one comes back to the front.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!Drive.hasConnection() || saving || els.vehicleDlg.open) return;
    pullRemote().catch((err) => {
      if (err instanceof Drive.AuthError) {
        showSignedOut("Your session expired. Sign in again to keep syncing.", dirty);
      } else {
        setStatus("Refresh failed — " + shortErr(err), true);
      }
    });
  });

  window.addEventListener("online", () => {
    if (dirty) flush();
    flushPhotos();
  });
  window.addEventListener("offline", () => {
    if (dirty) setStatus("Offline — saved on this device");
  });

  // Best-effort flush if the tab is closed with edits pending.
  window.addEventListener("beforeunload", (e) => {
    if (dirty || readPending().length) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // Chrome buries "Add to Home screen" in a menu that moves between versions,
  // so ask for the install directly. The event only fires when the browser
  // considers the app installable and it isn't installed already — meaning the
  // button appears exactly when it would actually do something.
  let installPrompt = null;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // keep Chrome's own banner from competing with the button
    installPrompt = e;
    els.install.hidden = false;
  });

  els.install.addEventListener("click", async () => {
    if (!installPrompt) return;
    els.install.hidden = true;
    installPrompt.prompt();
    await installPrompt.userChoice; // resolves whether they accept or dismiss
    installPrompt = null;
  });

  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    els.install.hidden = true;
  });

  // Installing the app to a home screen means it can sit resumed in memory for
  // days without ever re-fetching, so a deploy would never arrive on its own.
  // Three things make it land:
  //
  //   updateViaCache: "none" — check sw.js against the server, not the HTTP
  //     cache. GitHub Pages sends max-age on it, so the browser would otherwise
  //     not notice a new worker for as long as that lasts.
  //   update() on every load — ask, rather than wait for the browser to decide.
  //   controllerchange — a new worker calling clients.claim() means the shell on
  //     screen is already stale, so reload once to pick it up.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
      const hadController = Boolean(navigator.serviceWorker.controller);
      let reloading = false;

      navigator.serviceWorker.addEventListener("controllerchange", () => {
        // On a first-ever install there's nothing stale to replace — claiming
        // control isn't an update, and reloading for it looks like a glitch.
        if (!hadController || reloading) return;
        // Never yank the page out from under an unsaved edit. The cache keeps
        // the work either way; this just avoids a jarring reload mid-sentence,
        // and the next natural load will pick the new version up.
        if (dirty) return;
        reloading = true;
        location.reload();
      });

      try {
        const reg = await navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
        reg.update();
      } catch {
        /* offline, or an origin that won't allow a worker — the app still runs */
      }
    });
  }

  boot();
})();
