// Netlify Function: confirm-payment (owner-only manual-payment confirmation)
// TEST ONLY. No money is charged or verified by this function. It does
// NOT check Zelle or Venmo: the owner must first check payment in his
// own bank/app, and only then use this function to record the result.
// It does NOT touch the existing send-test-email function, the public
// registration page, prices, totals, or any Sheet column other than
// the single Payment Status cell it updates.
//
// What it does, on a POST from the owner-only admin page
// (public/admin-confirm.html, NOT linked from the public page):
//   1. Requires an adminKey in the POST body and compares it to
//      process.env.ADMIN_CONFIRM_KEY with a SHA-256 + timingSafeEqual
//      comparison (constant-time-style; no key is hard-coded here).
//      If ADMIN_CONFIRM_KEY is not set, it returns 503 and changes
//      nothing. If the key is wrong, it returns 403 and changes
//      nothing and sends nothing. The key is never logged.
//   2. Validates the booking code format VMA27-####, otherwise 400.
//   3. Reads Sheet1 A:P (same spreadsheet ID and service-account
//      auth pattern as send-test-email.js) and finds the row whose
//      column A equals the code. If not found: 404, no change.
//   4. If Payment Status (column K) is already TEST (card / Apple Pay
//      test) or TEST_CONFIRMED, it returns "already confirmed" with
//      NO Sheet change and NO duplicate email.
//   5. If the status contains PENDING (TEST_PENDING_ZELLE /
//      TEST_PENDING_VENMO), it updates ONLY column K of that row to
//      TEST_CONFIRMED (a single-cell update; no other column and no
//      other row is rewritten). Any other status returns 409, no change.
//   6. Then it sends, via Gmail SMTP with the same sender pattern as
//      send-test-email.js ("Vedant Music Academy
//      <vedantmusicacademy@gmail.com>", env GMAIL_USER /
//      GMAIL_APP_PASSWORD), a customer "Ticket confirmed" [TEST]
//      email and an admin notification email. If sending fails AFTER
//      the Sheet update, it returns 502 stating the Sheet is already
//      confirmed but the email failed, so the owner knows not to
//      re-confirm blindly: a re-confirm would now report
//      "already confirmed" and would NOT resend the email, so a
//      failed email must be followed up manually.
//
// Test-only dependency injection: __setTestDeps({ sheets, transporter })
// lets a local mocked test supply stub Sheet/Gmail objects without
// requiring googleapis/nodemailer (which are installed on Netlify at
// build time, not necessarily locally). In production no test deps
// are set, so the real clients are built lazily inside the handler.
// Netlify ignores these extra exports.

const crypto = require("crypto");

const ADMIN_EMAIL = "vedantmusicacademy@gmail.com";
const FROM = "Vedant Music Academy <vedantmusicacademy@gmail.com>";
const DIRECTIONS_URL = "https://share.google/YKFk7R0pjMEO3x2Gk";

// Test-only injection (see header). Null in production.
let testDeps = null;
function __setTestDeps(deps) {
  testDeps = deps || null;
}
function __clearTestDeps() {
  testDeps = null;
}

function money(value) {
  const n = Number(value);
  if (Number.isFinite(n)) return "$" + n.toFixed(2);
  return String(value == null ? "" : value);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function keysMatch(provided, expected) {
  // Constant-time-style: compare SHA-256 digests, so the comparison
  // does not short-circuit on length or content.
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function paymentMethodLabel(method) {
  return method === "zelle" ? "Zelle" : method === "venmo" ? "Venmo" : method === "apple_pay" ? "Apple Pay (Test)" : "Card";
}

function buildConfirmedEmail(row, code, method) {
  const name = row.name;
  const dandiyaPairs = row.dandiyaPairs;
  const hasDandiya = dandiyaPairs >= 1;
  const dandiyaText = hasDandiya
    ? `${dandiyaPairs} pair${dandiyaPairs === 1 ? "" : "s"}${row.colour ? ` · ${row.colour}` : ""}`
    : "0 pairs";
  const heading = "Your TEST ticket is confirmed — Navratri Dhamaka";
  const intro = "Good news: your payment has been received and your ticket is now confirmed. This is a TEST registration. No real money was charged by this page.";
  const text =
    `${heading}\n` +
    `${intro}\n\n` +
    `Booking reference: ${code}\n` +
    `Payment method: ${paymentMethodLabel(method)}\n` +
    `Amount (test): ${money(row.total)}\n\n` +
    `Event: Navratri Dhamaka\n` +
    `Date: Friday, October 15, 2027\n` +
    `Time: 7:00–11:00 PM\n` +
    `Venue: Bartlett Park District\n` +
    `Address: 700 S Bartlett Rd, Bartlett, IL 60103\n` +
    `Directions: ${DIRECTIONS_URL}\n\n` +
    `Full name: ${name}\n` +
    `Paid tickets: ${row.tickets}\n` +
    `Children under 10 (free): ${row.children}\n` +
    `Dandiya: ${dandiyaText}\n\n` +
    `Please keep your booking code ${code} for entry.\n` +
    `Presented by Radhe Krishna Sangeet and Vedant Music Academy\n` +
    `TEST registration — No money was charged.\n`;
  const e = escapeHtml;
  const html =
    `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#fff8ee;font-family:Arial,Helvetica,sans-serif;color:#2b1a0e;">` +
    `<tr><td align="center" style="padding:16px;">` +
    `<table width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e8d9b8;">` +
    `<tr><td align="center" style="background-color:#2b1a0e;padding:28px 20px;">` +
    `<div style="font-family:Georgia,serif;font-size:34px;line-height:1.2;color:#f5c542;font-weight:bold;">Radhe Krishna Sangeet &amp; Vedant Music Academy</div>` +
    `<div style="font-family:Georgia,serif;font-size:22px;line-height:1.3;color:#ffd98a;font-weight:bold;margin-top:10px;">Navratri Dhamaka</div>` +
    `<div style="font-size:14px;line-height:1.5;color:#ffd98a;margin-top:6px;">${e(heading)}</div>` +
    `</td></tr>` +
    `<tr><td style="padding:24px;">` +
    `<p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">${e(intro)}</p>` +
    `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#fff3d6;border:2px solid #f5c542;">` +
    `<tr><td align="center" style="padding:20px;">` +
    `<div style="font-size:13px;letter-spacing:2px;color:#7a4a00;font-weight:bold;">BOOKING REFERENCE</div>` +
    `<div style="font-family:Georgia,serif;font-size:42px;line-height:1.2;color:#2b1a0e;font-weight:bold;margin-top:6px;">${e(code)}</div>` +
    `<div style="font-size:13px;color:#5a3d1a;margin-top:6px;">Your ticket is confirmed. Please keep this code for entry.</div>` +
    `</td></tr></table>` +
    `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#fdf6ec;border:1px solid #e8d9b8;margin-top:16px;">` +
    `<tr><td style="padding:20px;">` +
    `<div style="font-size:13px;letter-spacing:2px;color:#7a4a00;font-weight:bold;">EVENT &amp; ADDRESS</div>` +
    `<div style="font-size:15px;line-height:1.8;color:#2b1a0e;margin-top:10px;">` +
    `<strong>Date:</strong> Friday, October 15, 2027<br>` +
    `<strong>Time:</strong> 7:00–11:00 PM<br>` +
    `<strong>Venue:</strong> Bartlett Park District<br>` +
    `<strong>Address:</strong> 700 S Bartlett Rd, Bartlett, IL 60103<br>` +
    `<a href="${DIRECTIONS_URL}" style="color:#b45309;font-weight:bold;">Get directions</a>` +
    `</div></td></tr></table>` +
    `<div style="font-size:16px;font-weight:bold;color:#2b1a0e;margin-top:24px;margin-bottom:10px;">Your details</div>` +
    `<table width="100%" cellpadding="8" cellspacing="0" style="font-size:14px;line-height:1.6;border-collapse:collapse;">` +
    `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;width:180px;">Full name</td><td style="border-bottom:1px solid #eee0c8;">${e(name)}</td></tr>` +
    `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;">Paid tickets</td><td style="border-bottom:1px solid #eee0c8;">${e(row.tickets)}</td></tr>` +
    `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;">Children under 10 (free)</td><td style="border-bottom:1px solid #eee0c8;">${e(row.children)}</td></tr>` +
    `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;">Dandiya</td><td style="border-bottom:1px solid #eee0c8;">${e(dandiyaText)}</td></tr>` +
    `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;">Payment method</td><td style="border-bottom:1px solid #eee0c8;">${e(paymentMethodLabel(method))}</td></tr>` +
    `<tr><td style="color:#7a4a00;">Amount (test)</td><td>${e(money(row.total))}</td></tr>` +
    `</table>` +
    `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#2b1a0e;margin-top:24px;">` +
    `<tr><td align="center" style="padding:18px;color:#ffffff;font-size:13px;line-height:1.6;">` +
    `Presented by Radhe Krishna Sangeet and Vedant Music Academy<br>` +
    `TEST registration — No money was charged.` +
    `</td></tr></table>` +
    `</td></tr></table>` +
    `</td></tr></table>`;
  return { text, html };
}

async function buildSheetsClient() {
  if (testDeps && testDeps.sheets) return testDeps.sheets;
  // Lazy require: only on Netlify, where googleapis is installed.
  const { google } = require("googleapis");
  let creds;
  try {
    creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "");
  } catch {
    throw new Error("Sheet credentials are not configured.");
  }
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  if (!creds.client_email || !creds.private_key || !spreadsheetId) {
    throw new Error("Sheet service is not configured.");
  }
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return google.sheets({ version: "v4", auth });
}

function buildTransporter() {
  if (testDeps && testDeps.transporter) return testDeps.transporter;
  // Lazy require: only on Netlify, where nodemailer is installed.
  const nodemailer = require("nodemailer");
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
}

async function sendMail(transporter, to, subject, body) {
  try {
    await transporter.sendMail({ from: FROM, to, subject, text: body.text, html: body.html });
    return true;
  } catch {
    console.log("Gmail send failed");
    return false;
  }
}

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: "Method not allowed." }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Invalid request." }) };
  }

  // Admin key check comes BEFORE any Sheet lookup, so a wrong key
  // reveals nothing about whether a code exists. No key value is
  // ever logged or returned.
  const configuredKey = process.env.ADMIN_CONFIRM_KEY;
  if (!configuredKey) {
    return { statusCode: 503, headers, body: JSON.stringify({ ok: false, error: "Admin confirmation is not configured." }) };
  }
  const adminKey = typeof body.adminKey === "string" ? body.adminKey : "";
  if (!keysMatch(adminKey, configuredKey)) {
    return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: "Admin key is incorrect." }) };
  }

  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!/^VMA27-\d{4}$/.test(code)) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Booking code must look like VMA27-0008." }) };
  }

  // Gmail must be configured BEFORE the Sheet is changed, so a
  // missing email setup never leaves a row confirmed with no email.
  if (!testDeps && (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD)) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: "Email service is not configured." }) };
  }

  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  let sheets;
  try {
    sheets = await buildSheetsClient();
  } catch {
    return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: "Sheet service is not configured." }) };
  }

  let rows;
  try {
    const read = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Sheet1!A:P" });
    rows = read.data.values || [];
  } catch {
    return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: "Could not read the registration Sheet." }) };
  }

  let rowIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i][0] === code) {
      rowIndex = i;
      break;
    }
  }
  if (rowIndex === -1) {
    return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: "Booking code not found." }) };
  }

  const raw = rows[rowIndex];
  const status = typeof raw[10] === "string" ? raw[10] : "";
  if (status === "TEST" || status === "TEST_CONFIRMED") {
    // Already confirmed (card / Apple Pay test, or a manual payment
    // confirmed earlier). No Sheet change, no duplicate email.
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, alreadyConfirmed: true, bookingReference: code, paymentStatus: status, customerEmailSent: false, adminEmailSent: false }),
    };
  }
  if (!status.includes("PENDING")) {
    return { statusCode: 409, headers, body: JSON.stringify({ ok: false, error: "This registration is not pending, so it cannot be confirmed here." }) };
  }

  // Payment method: column P if present, else derived from status.
  const methodRaw = typeof raw[15] === "string" ? raw[15].toLowerCase() : "";
  const method = methodRaw === "venmo" ? "venmo" : methodRaw === "zelle" ? "zelle" : status === "TEST_PENDING_VENMO" ? "venmo" : "zelle";
  const dandiyaAmount = Number(raw[14]);
  const row = {
    name: raw[2] || "",
    email: raw[4] || "",
    tickets: raw[5] == null ? "" : raw[5],
    children: raw[6] == null ? "" : raw[6],
    colour: raw[8] || "",
    total: raw[9],
    // Dandiya pairs are not a Sheet column; they are recovered from
    // Dandiya Amount (column O) at $5 per pair.
    dandiyaPairs: Number.isFinite(dandiyaAmount) && dandiyaAmount > 0 ? Math.round(dandiyaAmount / 5) : 0,
  };
  if (!row.email) {
    return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: "This registration has no customer email on file." }) };
  }

  // ONLY column K of this one row changes. Row numbers are 1-based
  // in Sheets, so the found index + 1 is the row number.
  const rowNumber = rowIndex + 1;
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Sheet1!K${rowNumber}`,
      valueInputOption: "RAW",
      requestBody: { values: [["TEST_CONFIRMED"]] },
    });
  } catch {
    return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: "Could not update the registration Sheet." }) };
  }

  const emailBody = buildConfirmedEmail(row, code, method);
  const transporter = buildTransporter();
  const customerSubject = `[TEST] Your ticket is confirmed! Navratri Dhamaka — Oct 15, 2027 (${code})`;
  const adminSubject = `[TEST] Manual payment confirmed — Navratri Dhamaka (${code})`;
  const customerSent = await sendMail(transporter, row.email, customerSubject, emailBody);
  const adminText =
    `A manual payment has been confirmed by the owner (TEST).\n\n` +
    `Booking reference: ${code}\n` +
    `Payment method: ${paymentMethodLabel(method)}\n` +
    `Amount (test): ${money(row.total)}\n` +
    `Full name: ${row.name}\n` +
    `Paid tickets: ${row.tickets}\n` +
    `Children under 10 (free): ${row.children}\n\n` +
    `The customer has been sent the [TEST] ticket-confirmed email.\n` +
    `TEST registration — No money was charged by this page.\n`;
  const adminSent = await sendMail(transporter, ADMIN_EMAIL, adminSubject, { text: adminText, html: `<pre style="font-family:Arial,Helvetica,sans-serif;font-size:14px;">${escapeHtml(adminText)}</pre>` });

  if (!customerSent || !adminSent) {
    // The Sheet is already TEST_CONFIRMED. Say so plainly: do NOT
    // re-confirm blindly, because a re-confirm will now report
    // "already confirmed" and will NOT resend the email.
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        ok: false,
        sheetConfirmed: true,
        bookingReference: code,
        paymentStatus: "TEST_CONFIRMED",
        customerEmailSent: customerSent,
        adminEmailSent: adminSent,
        error: "The Sheet is confirmed, but a confirmation email failed. Do not re-confirm: it would report already-confirmed and would not resend the email. Please follow up with the customer manually.",
      }),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, alreadyConfirmed: false, bookingReference: code, paymentStatus: "TEST_CONFIRMED", customerEmailSent: true, adminEmailSent: true }),
  };
};

exports.__setTestDeps = __setTestDeps;
exports.__clearTestDeps = __clearTestDeps;
