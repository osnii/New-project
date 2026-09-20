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

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", fileName), "utf8"));
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
  await writeTab("Brands", readJson("seed-brands.json"));
  await writeTab("Products", readJson("seed-products.json"));
  console.log("Done. The Members tab is left alone — it fills up as people subscribe.");
}

main().catch((err) => {
  console.error("Seeding failed:", err.response?.data || err.message);
  process.exit(1);
});
