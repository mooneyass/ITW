// Paste your Google OAuth client ID here. See README.md, step 1.
// It looks like: 1234567890-abcdefghijklmnop.apps.googleusercontent.com
//
// This is its own client ID, not shared with any other app. drive.file access is
// keyed to the client ID, so a separate one walls this app off from everything
// else in your Drive.
window.ITW_CONFIG = {
  GOOGLE_CLIENT_ID: "913088114160-hlejfkv6ecoag2go0d1j3hapa71ut0gq.apps.googleusercontent.com",

  // Where the data lives in your Drive. The app creates all of these on first run.
  FOLDER_NAME: "vehicledata",
  FILE_NAME: "vehicles.json",
  PHOTOS_FOLDER: "photos",

  // The service type dropdown. The first one is the default for a new record.
  SERVICE_TYPES: ["Service", "Repair", "Maintenance", "Upgrade"],

  // Cost formatting. A bare symbol rather than a currency code, so it always
  // reads "$89" — Intl's currency mode would render CAD as "CA$89" or "US$89"
  // depending on the machine's locale, which is not what you want on your own
  // maintenance log.
  CURRENCY_SYMBOL: "$",

  // Shown after odometer readings. Grouping still follows the local format.
  DISTANCE_UNIT: "km",

  // Photos are resized on the device that picked them, before upload. The thumb
  // is what the grid and the vehicle header show; the full size is fetched only
  // when you tap the header photo to view it.
  THUMB_PX: 360,
  PHOTO_PX: 1600,
  JPEG_QUALITY: 0.82,
};
