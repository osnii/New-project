import { google } from "googleapis";

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

let sheetsApi = null;

// Sheets auto-detects a string like "08011112222" as a number under
// USER_ENTERED and silently drops the leading zero — which corrupts every
// Nigerian phone number, since they all start with 0. A leading apostrophe
// forces Sheets to keep it as literal text (the value comes back without
// the apostrophe when read).
function preserveLeadingZero(value) {
  return typeof value === "string" && /^0\d+$/.test(value) ? `'${value}` : value;
}

function getSheetsApi() {
  if (sheetsApi) return sheetsApi;

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheetsApi = google.sheets({ version: "v4", auth });
  return sheetsApi;
}

// Reads a tab and returns an array of objects keyed by the header row.
export async function readRows(tabName) {
  const sheets = getSheetsApi();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A:Z`,
  });

  const [header, ...rows] = res.data.values || [];
  if (!header) return [];

  return rows.map((row) => {
    const obj = {};
    header.forEach((key, i) => {
      obj[key.trim()] = row[i] ?? "";
    });
    return obj;
  });
}

// Appends a single row to a tab, in the order given by the tab's existing header row.
export async function appendRow(tabName, rowObject) {
  const sheets = getSheetsApi();
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A1:Z1`,
  });
  const header = headerRes.data.values?.[0] || Object.keys(rowObject);

  const row = header.map((key) => preserveLeadingZero(rowObject[key.trim()] ?? ""));

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A:Z`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

// Finds the first row matching a predicate and updates the given fields in place.
// Returns true if a row was found and updated.
export async function updateRowWhere(tabName, predicate, patch) {
  const sheets = getSheetsApi();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A:Z`,
  });

  const [header, ...rows] = res.data.values || [];
  if (!header) return false;

  const rowIndex = rows.findIndex((row) => {
    const obj = {};
    header.forEach((key, i) => (obj[key.trim()] = row[i] ?? ""));
    return predicate(obj);
  });
  if (rowIndex === -1) return false;

  const existing = {};
  header.forEach((key, i) => (existing[key.trim()] = rows[rowIndex][i] ?? ""));
  const merged = { ...existing, ...patch };
  const newRow = header.map((key) => preserveLeadingZero(merged[key.trim()] ?? ""));

  const sheetRowNumber = rowIndex + 2; // +1 for header, +1 for 1-indexing
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A${sheetRowNumber}:Z${sheetRowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [newRow] },
  });

  return true;
}
