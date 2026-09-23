// Pushes the sample brand/product catalog into the Brands and Products tabs.
// Overwrites those tabs entirely, so it's safe to re-run while you're setting up.
import { google } from "googleapis";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

if (!SHEET_ID) {
  console.error("GOOGLE_SHEET_ID is not set. Copy .env.example to .env and fill it in first.");
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

const MEMBERS_HEADER = [
  "MemberID",
  "Name",
  "Email",
  "Phone",
  "Role",
  "BusinessName",
  "Plan",
  "AmountPaid",
  "StartDate",
  "RenewalDate",
  "Status",
  "PaymentProvider",
  "PaymentReference",
];

const EVENTS_HEADER = ["Timestamp", "Event", "Email", "Plan", "BrandSlug", "Provider", "Detail"];

const CONTRACTOR_LEADS_HEADER = [
  "Timestamp",
  "Name",
  "Email",
  "Phone",
  "BusinessName",
  "Message",
  "Status",
];

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", fileName), "utf8"));
}

// Creates any of the given tabs that don't already exist on the spreadsheet.
async function ensureTabsExist(tabNames) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existing = new Set(meta.data.sheets.map((s) => s.properties.title));
  const missing = tabNames.filter((name) => !existing.has(name));

  if (!missing.length) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
    },
  });

  console.log(`Created tab(s): ${missing.join(", ")}`);
}

// Writes the header row to a tab only if it's completely empty, so it never
// clobbers real member data that's already been collected.
async function writeHeaderIfEmpty(tabName, header) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A1:A1`,
  });

  if (res.data.values?.length) {
    console.log(`"${tabName}" already has data — leaving it alone.`);
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [header] },
  });

  console.log(`Wrote header row to "${tabName}".`);
}

async function writeTab(tabName, rows) {
  if (!rows.length) return;
  const header = Object.keys(rows[0]);
  const values = [header, ...rows.map((row) => header.map((key) => row[key] ?? ""))];

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });

  console.log(`Wrote ${rows.length} rows to "${tabName}".`);
}

async function main() {
  await ensureTabsExist(["Brands", "Products", "Members", "Events", "ContractorLeads"]);
  await writeTab("Brands", readJson("seed-brands.json"));
  await writeTab("Products", readJson("seed-products.json"));
  await writeHeaderIfEmpty("Members", MEMBERS_HEADER);
  await writeHeaderIfEmpty("Events", EVENTS_HEADER);
  await writeHeaderIfEmpty("ContractorLeads", CONTRACTOR_LEADS_HEADER);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Seeding failed:", err.response?.data || err.message);
  process.exit(1);
});
