// Netlify Scheduled Function: check-paid (Sheet-Yes paid confirmation)
// TEST ONLY. No money is charged or verified by this function. It does
// NOT check Zelle or Venmo payments itself: the owner must first check
// payment in his own bank/app, and only then write "Yes" in the Sheet.
//
// What it does, every 10 minutes (schedule in netlify.toml,
// [functions."check-paid"] schedule = "*/10 * * * *", UTC):
//   1. Reads Sheet1 A:Q. Column Q (17th, header "Paid") is the owner
//      flag. New registrations append A:P and leave Q blank, which is
//      correct — the owner fills Yes later, only for Zelle/Venmo.
//   2. For each data row it processes ONLY rows where Payment Method
//      (col P) is zelle or venmo, Payment Status (col K) is
//      TEST_PENDING_ZELLE or TEST_PENDING_VENMO, and Paid (col Q)
//      trimmed and uppercased equals "YES". It skips blank/No, skips
//      Card/Apple Pay rows (Status TEST), skips already TEST_CONFIRMED
//      rows, and skips any other status.
//   3. For each qualifying row it sends the customer "Ticket confirmed"
//      [TEST] email and an admin notification email via Gmail SMTP
//      (same sender as the registration function: Vedant Music Academy
//      <vedantmusicacademy@gmail.com>, env GMAIL_USER /
//      GMAIL_APP_PASSWORD). The email content is the confirmed-email
//      content previously used by the removed manual confirm function.
//   4. ONLY after BOTH emails succeed, it updates ONLY column K of
//      that row to TEST_CONFIRMED (a single-cell update). If email
//      sending fails, it does NOT flip the status, so the next
//      scheduled run retries it.
//   5. A row already TEST_CONFIRMED is never emailed again, even if
//      Paid stays Yes — that is what prevents duplicate emails.
//
// No admin key, no code/password input, no public page for this
// checker. Scheduled functions cannot be invoked directly by URL in
// production (Netlify docs); for a manual test, use the "Run now"
// button on the Functions page in the Netlify UI.
// Scheduled functions only run on published deploys, have a 30 second
// execution limit, and run on UTC time. Low volume is expected, so
// one Sheet read plus one email pair per qualifying row fits easily.
//
// Test-only dependency injection: __setTestDeps({ sheets, transporter })
// lets a local mocked test supply stub Sheet/Gmail objects without
// requiring googleapis/nodemailer (which are installed on Netlify at
// build time, not necessarily locally). In production no test deps
// are set, so the real clients are built lazily inside the handler.
// Netlify ignores these extra exports.

const ADMIN_EMAIL = "vedantmusicacademy@gmail.com";
const FROM = "Vedant Music Academy <vedantmusicacademy@gmail.com>";
const DIRECTIONS_URL = "https://share.google/YKFk7R0pjMEO3x2Gk";

// Test-only injection (see header). Null in production.
let testDeps = null;
export function __setTestDeps(deps) {
  testDeps = deps || null;
}
export function __clearTestDeps() {
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

function paymentMethodLabel(method) {
  return method === "zelle" ? "Zelle" : method === "venmo" ? "Venmo" : method === "apple_pay" ? "Apple Pay (Test)" : "Card";
}

// Confirmed-email content, as previously used by the removed manual
// confirm function (customer subject/body below; admin subject/text
// are built in runCheck). Dandiya pairs are recovered from Dandiya
// Amount (column O) at $5 per pair, because pairs are not a Sheet
// column.
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
    `<div style="font-family:Georgia,serif;font-size:34px;line-height:1.2;color:#f5c542;font-weight:bold;">Radhe Krishna Sangeet &amp;<br>Vedant Music Academy</div>` +
    `<div style="font-family:Georgia,serif;font-size:22px;line-height:1.3;color:#ffd98a;font-weight:bold;margin-top:10px;">Navratri Dhamaka</div>` +
    `<div style="font-size:14px;line-height:1.5;color:#ffd98a;margin-top:6px;">${e(heading)}</div>` +
    `</td></tr>` +
    `<tr><td style="padding:24px;">` +
    `<p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">${e(intro)}</p>` +
    `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#dcfce7;border:2px solid #16a34a;">` +
    `<tr><td align="center" style="padding:16px;">` +
    `<div style="font-size:18px;line-height:1.4;color:#166534;font-weight:bold;">✓ YOUR TICKET IS CONFIRMED</div>` +
    `<div style="font-size:13px;color:#166534;margin-top:4px;">Payment received — see you at the Garba!</div>` +
    `</td></tr></table>` +
    `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#fff3d6;border:2px solid #f5c542;margin-top:16px;">` +
    `<tr><td align="center" style="padding:20px;">` +
    `<div style="font-size:13px;letter-spacing:2px;color:#7a4a00;font-weight:bold;">BOOKING REFERENCE</div>` +
    `<div style="font-family:Georgia,serif;font-size:42px;line-height:1.2;color:#2b1a0e;font-weight:bold;margin-top:6px;">${e(code)}</div>` +
    `<div style="font-size:13px;color:#5a3d1a;margin-top:6px;">Your ticket is confirmed. Please keep this code for entry.</div>` +
    `</td></tr></table>` +
    `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffedd6;border:1px solid #e67e22;margin-top:16px;">` +
    `<tr><td align="center" style="padding:20px;">` +
    `<div style="font-size:13px;letter-spacing:2px;color:#7a3c00;font-weight:bold;">AMOUNT PAID (TEST)</div>` +
    `<div style="font-family:Georgia,serif;font-size:36px;line-height:1.2;color:#2b1a0e;font-weight:bold;margin-top:6px;">${e(money(row.total))}</div>` +
    `<div style="font-size:13px;color:#5a3d1a;margin-top:6px;">Paid by ${e(paymentMethodLabel(method))}</div>` +
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
  // Lazy dynamic import: only on Netlify, where googleapis is installed.
  const { google } = await import("googleapis");
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

async function buildTransporter() {
  if (testDeps && testDeps.transporter) return testDeps.transporter;
  // Lazy dynamic import: only on Netlify, where nodemailer is installed.
  const nodemailer = (await import("nodemailer")).default;
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

async function runCheck() {
  const result = {
    ok: false,
    checked: 0,
    confirmed: 0,
    skipped: 0,
    failed: 0,
    confirmedCodes: [],
    failedCodes: [],
  };

  // Gmail must be configured BEFORE any Sheet change, so a missing
  // email setup never leaves a row confirmed with no email.
  if (!testDeps && (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD)) {
    result.error = "Email service is not configured.";
    return { status: 500, result };
  }

  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  let sheets;
  try {
    sheets = await buildSheetsClient();
  } catch {
    result.error = "Sheet service is not configured.";
    return { status: 502, result };
  }

  let rows;
  try {
    const read = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Sheet1!A:Q" });
    rows = read.data.values || [];
  } catch {
    result.error = "Could not read the registration Sheet.";
    return { status: 502, result };
  }

  const transporter = await buildTransporter();

  // Row 1 is the header. Data rows start at index 1; Sheet row
  // numbers are 1-based, so the found index + 1 is the row number.
  for (let i = 1; i < rows.length; i++) {
    const raw = rows[i] || [];
    const code = typeof raw[0] === "string" ? raw[0].trim() : "";
    if (!code) {
      result.skipped++;
      continue;
    }
    result.checked++;

    const status = typeof raw[10] === "string" ? raw[10] : "";
    const methodRaw = typeof raw[15] === "string" ? raw[15].trim().toLowerCase() : "";
    const method = methodRaw === "venmo" ? "venmo" : methodRaw === "zelle" ? "zelle" : status === "TEST_PENDING_VENMO" ? "venmo" : "zelle";
    const paid = typeof raw[16] === "string" ? raw[16].trim().toUpperCase() : "";

    // Only pending Zelle/Venmo rows the owner marked Paid = Yes.
    // This also skips Card/Apple Pay (Status TEST), already
    // TEST_CONFIRMED rows (never emailed again), and any other status.
    const isPendingManual =
      (status === "TEST_PENDING_ZELLE" || status === "TEST_PENDING_VENMO") &&
      (methodRaw === "zelle" || methodRaw === "venmo");
    if (!isPendingManual || paid !== "YES") {
      result.skipped++;
      continue;
    }

    const email = typeof raw[4] === "string" ? raw[4].trim() : "";
    if (!email) {
      result.failed++;
      result.failedCodes.push(code);
      continue;
    }

    const dandiyaAmount = Number(raw[14]);
    const row = {
      name: raw[2] || "",
      email,
      tickets: raw[5] == null ? "" : raw[5],
      children: raw[6] == null ? "" : raw[6],
      colour: raw[8] || "",
      total: raw[9],
      // Dandiya pairs are not a Sheet column; they are recovered from
      // Dandiya Amount (column O) at $5 per pair.
      dandiyaPairs: Number.isFinite(dandiyaAmount) && dandiyaAmount > 0 ? Math.round(dandiyaAmount / 5) : 0,
    };

    const emailBody = buildConfirmedEmail(row, code, method);
    const customerSubject = `[TEST] Your ticket is confirmed! Navratri Dhamaka — Oct 15, 2027 (${code})`;
    const adminSubject = `[TEST] Manual payment confirmed — Navratri Dhamaka (${code})`;
    const customerSent = await sendMail(transporter, email, customerSubject, emailBody);
    const adminText =
      `A manual payment was marked Paid = Yes in the Sheet by the owner (TEST).\n\n` +
      `Booking reference: ${code}\n` +
      `Payment method: ${paymentMethodLabel(method)}\n` +
      `Amount (test): ${money(row.total)}\n` +
      `Full name: ${row.name}\n` +
      `Paid tickets: ${row.tickets}\n` +
      `Children under 10 (free): ${row.children}\n\n` +
      `The customer has been sent the [TEST] ticket-confirmed email.\n` +
      `TEST registration — No money was charged by this page.\n`;
    const adminHtml =
      `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#fff8ee;font-family:Arial,Helvetica,sans-serif;color:#2b1a0e;">` +
      `<tr><td align="center" style="padding:16px;">` +
      `<table width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e8d9b8;">` +
      `<tr><td align="center" style="background-color:#2b1a0e;padding:28px 20px;">` +
      `<div style="font-family:Georgia,serif;font-size:34px;line-height:1.2;color:#f5c542;font-weight:bold;">Radhe Krishna Sangeet &amp;<br>Vedant Music Academy</div>` +
      `<div style="font-family:Georgia,serif;font-size:22px;line-height:1.3;color:#ffd98a;font-weight:bold;margin-top:10px;">Navratri Dhamaka</div>` +
      `<div style="font-size:14px;line-height:1.5;color:#ffd98a;margin-top:6px;">Manual payment confirmed</div>` +
      `</td></tr>` +
      `<tr><td style="padding:24px;">` +
      `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#dcfce7;border:2px solid #16a34a;">` +
      `<tr><td align="center" style="padding:16px;">` +
      `<div style="font-size:18px;line-height:1.4;color:#166534;font-weight:bold;">✓ MANUAL PAYMENT CONFIRMED</div>` +
      `<div style="font-size:13px;color:#166534;margin-top:4px;">Paid = Yes in the Sheet — customer email sent, status is now TEST_CONFIRMED.</div>` +
      `</td></tr></table>` +
      `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#fff3d6;border:2px solid #f5c542;margin-top:16px;">` +
      `<tr><td align="center" style="padding:20px;">` +
      `<div style="font-size:13px;letter-spacing:2px;color:#7a4a00;font-weight:bold;">BOOKING REFERENCE</div>` +
      `<div style="font-family:Georgia,serif;font-size:42px;line-height:1.2;color:#2b1a0e;font-weight:bold;margin-top:6px;">${escapeHtml(code)}</div>` +
      `</td></tr></table>` +
      `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffedd6;border:1px solid #e67e22;margin-top:16px;">` +
      `<tr><td align="center" style="padding:20px;">` +
      `<div style="font-size:13px;letter-spacing:2px;color:#7a3c00;font-weight:bold;">AMOUNT PAID (TEST)</div>` +
      `<div style="font-family:Georgia,serif;font-size:36px;line-height:1.2;color:#2b1a0e;font-weight:bold;margin-top:6px;">${escapeHtml(money(row.total))}</div>` +
      `<div style="font-size:13px;color:#5a3d1a;margin-top:6px;">Paid by ${escapeHtml(paymentMethodLabel(method))}</div>` +
      `</td></tr></table>` +
      `<div style="font-size:16px;font-weight:bold;color:#2b1a0e;margin-top:24px;margin-bottom:10px;">Booking details</div>` +
      `<table width="100%" cellpadding="8" cellspacing="0" style="font-size:14px;line-height:1.6;border-collapse:collapse;">` +
      `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;width:180px;">Full name</td><td style="border-bottom:1px solid #eee0c8;">${escapeHtml(row.name)}</td></tr>` +
      `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;">Email</td><td style="border-bottom:1px solid #eee0c8;">${escapeHtml(email)}</td></tr>` +
      `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;">Paid tickets</td><td style="border-bottom:1px solid #eee0c8;">${escapeHtml(row.tickets)}</td></tr>` +
      `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;">Children under 10 (free)</td><td style="border-bottom:1px solid #eee0c8;">${escapeHtml(row.children)}</td></tr>` +
      `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;">Dandiya</td><td style="border-bottom:1px solid #eee0c8;">${escapeHtml(row.dandiyaPairs)} pair${row.dandiyaPairs === 1 ? "" : "s"}${row.colour ? ` · ${row.colour}` : ""}</td></tr>` +
      `<tr><td style="color:#7a4a00;">Payment method</td><td>${escapeHtml(paymentMethodLabel(method))}</td></tr>` +
      `</table>` +
      `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#2b1a0e;margin-top:24px;">` +
      `<tr><td align="center" style="padding:18px;color:#ffffff;font-size:13px;line-height:1.6;">` +
      `Presented by Radhe Krishna Sangeet and Vedant Music Academy<br>` +
      `TEST registration — No money was charged.` +
      `</td></tr></table>` +
      `</td></tr></table>` +
      `</td></tr></table>`;
    const adminSent = await sendMail(transporter, ADMIN_EMAIL, adminSubject, {
      text: adminText,
      html: adminHtml,
    });

    // Emails first, status flip second: if either email fails, the
    // status stays pending so the next scheduled run retries it.
    // (Edge case, noted in the header of the parent report: if the
    // Sheet update itself fails after the emails were sent, the next
    // run would resend the emails once. That path is counted as
    // failed and logged, so the owner can check before re-running.)
    if (!customerSent || !adminSent) {
      result.failed++;
      result.failedCodes.push(code);
      continue;
    }

    const rowNumber = i + 1;
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `Sheet1!K${rowNumber}`,
        valueInputOption: "RAW",
        requestBody: { values: [["TEST_CONFIRMED"]] },
      });
    } catch {
      result.failed++;
      result.failedCodes.push(code);
      continue;
    }

    result.confirmed++;
    result.confirmedCodes.push(code);
  }

  result.ok = true;
  return { status: 200, result };
}

// Scheduled-function entry point (Netlify v2 style). The schedule is
// in netlify.toml: [functions."check-paid"] schedule = "*/10 * * * *"
// (every 10 minutes, UTC). The request body carries next_run; this
// checker does not need it. Scheduled functions do not return a
// response body in production, but the counts are logged.
export default async (req) => {
  const { status, result } = await runCheck();
  console.log("check-paid:", JSON.stringify(result));
  return new Response(JSON.stringify(result), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};
