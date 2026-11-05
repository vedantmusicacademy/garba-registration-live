// Netlify Function: send-test-email (Gmail + Google Sheet version)
// TEST ONLY. No money is charged by this function. It does not
// process cards and does not call Stripe. It DOES save each test
// registration to a Google Sheet with a sequential VMA27 code
// (VMA27-0001, VMA27-0002, ...). Live Stripe is future work
// and is NOT implemented here.
//
// What it does, on a POST from the test registration form:
//   1. Validates name, phone, email, paid tickets, children
//      under 10, dandiya Yes/No, pairs, colour, and payment
//      method (card, zelle, venmo, or apple_pay; card is the
//      default). Zelle/Venmo are manual and stay pending: this
//      function cannot verify them automatically, so their
//      Payment Status is TEST_PENDING_ZELLE / TEST_PENDING_VENMO
//      and their emails say PENDING, not confirmed. Apple Pay
//      here is a TEST simulation like the test card (no real
//      Apple Pay sheet, no real money, no wallet details sent),
//      so its Payment Status is TEST and its emails are the
//      confirmed test emails. Real Apple Pay needs live Stripe
//      plus Apple Pay domain/merchant setup, which is NOT here.
//   2. Recomputes the total on the server, never trusting
//      a total sent by the browser:
//        - paid tickets: $10 each for 1-9 tickets,
//          $8 each for 10 or more tickets
//        - children under 10: free ($0)
//        - dandiya: $5 per pair, only when dandiya is Yes
//          and pairs is 1 or more; 0 pairs = $0, and no
//          colour is required or shown for 0 pairs.
//   3. Saves the registration to a Google Sheet FIRST, using
//      ONLY these environment variables (set in Netlify, never
//      hard-coded here, and never logged):
//        GOOGLE_SERVICE_ACCOUNT_JSON - service-account JSON
//        GOOGLE_SPREADSHEET_ID       - the new Sheet's ID
//      The next code is (existing data rows + 1), formatted as
//      VMA27-#### (first registration = VMA27-0001). If the
//      Sheet append fails, no email is sent.
//   4. Generates the VMA27 booking reference and sends two emails
//      through Gmail SMTP, using ONLY these environment
//      variables (set in Netlify, never hard-coded here):
//        GMAIL_USER         - vedantmusicacademy@gmail.com
//        GMAIL_APP_PASSWORD - the Gmail App password, created
//                             by VEDANT himself and saved in
//                             Netlify only (never in chat)
//      Sender: "Vedant Music Academy <vedantmusicacademy@gmail.com>"
//      - one customer email, to the email in the form
//      - one admin email, to vedantmusicacademy@gmail.com
//   4. Returns success/failure without leaking secrets.
//
// SECURITY: Card details must NEVER be sent to this function.
// The browser page keeps its test-card fields local only and
// does not include them in the POST body. If card fields are
// sent anyway, they are ignored and never forwarded to Gmail.

const nodemailer = require("nodemailer");
const { google } = require("googleapis");

const ADMIN_EMAIL = "vedantmusicacademy@gmail.com";
const ZELLE_DESTINATION = "vedantmusicacademy@gmail.com";
const VENMO_DESTINATION = "@vedantmusicacademy";
const FROM = "Vedant Music Academy <vedantmusicacademy@gmail.com>";
const DIRECTIONS_URL = "https://share.google/YKFk7R0pjMEO3x2Gk";
const EVENT_LINE = "Friday, October 15, 2027 · 7:00–11:00 PM · Bartlett Park District, 700 S Bartlett Rd, Bartlett, IL 60103";
const COLOURS = ["Red", "Blue", "Green", "Yellow", "Orange", "Purple", "Pink", "White", "Black", "Multicolor"];

function money(n) {
  return "$" + n.toFixed(2);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isIntInRange(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

function paymentMethodLabel(method) {
  return method === "zelle" ? "Zelle" : method === "venmo" ? "Venmo" : method === "apple_pay" ? "Apple Pay" : "Card";
}
function paymentDestination(method) {
  return method === "zelle" ? ZELLE_DESTINATION : method === "venmo" ? VENMO_DESTINATION : "";
}

function buildEmailBody(data, ref, total, ticketCost, dandiyaCost, isAdmin, paymentMethod) {
  const method = paymentMethod || "card";
  const isPending = method === "zelle" || method === "venmo";
  const hasDandiya = data.dandiya && data.pairs >= 1;
  const dandiyaNeeded = data.dandiya ? "Yes" : "No";
  const dandiyaPairs = hasDandiya
    ? `${data.pairs} pair${data.pairs === 1 ? "" : "s"}`
    : "0 pairs";
  const colourValue = hasDandiya ? data.colour : "—";
  const heading = isPending
    ? (isAdmin
      ? "New TEST registration — Payment pending — Navratri Dhamaka"
      : "Your TEST registration — Payment pending — Navratri Dhamaka")
    : (isAdmin
      ? "New TEST registration — Navratri Dhamaka"
      : "Your TEST ticket confirmation — Navratri Dhamaka");
  const intro = isPending
    ? (isAdmin
      ? "A new test registration was submitted with a pending manual payment. This is a TEST registration. No money was charged by this page. The ticket is NOT confirmed until payment is received."
      : "Thank you for registering. Your payment is pending. This is a TEST registration. No money was charged by this page. Your ticket will be confirmed only after payment is received.")
    : (isAdmin
      ? "A new test registration was submitted. This is a TEST registration. No money was charged."
      : "Thank you for registering. This is a TEST registration. No money was charged.");
  const pendingText = isPending
    ? `Payment method: ${paymentMethodLabel(method)}\n` +
      `Amount to send (test): ${money(total)}\n` +
      `Send to: ${paymentDestination(method)}\n` +
      `Memo: please include your booking code ${ref}\n` +
      `Status: PENDING — your ticket will be confirmed only after payment is received. Zelle and Venmo payments cannot be verified automatically by this system.\n\n`
    : ``;
  // Plain-text fallback: same facts, same order, no styling.
  // Card emails are unchanged. Pending emails use the amount-to-send
  // wording and add the pending payment block below.
  const text =
    `${heading}\n` +
    `${intro}\n\n` +
    `Booking reference: ${ref}\n` +
    (method === "apple_pay" ? `Payment method: Apple Pay (Test)\n` : ``) +
    (isPending ? `Amount to send (test): ${money(total)}\n` : `Amount paid (test): ${money(total)}\n`) +
    pendingText +
    `Paid tickets: ${data.paidTickets} × ${data.paidTickets >= 10 ? "$8.00" : "$10.00"} = ${money(ticketCost)}\n` +
    `Dandiya cost: ${money(dandiyaCost)}\n\n` +
    `Event: Navratri Dhamaka\n` +
    `Date: Friday, October 15, 2027\n` +
    `Time: 7:00–11:00 PM\n` +
    `Venue: Bartlett Park District\n` +
    `Address: 700 S Bartlett Rd, Bartlett, IL 60103\n` +
    `Directions: ${DIRECTIONS_URL}\n\n` +
    `Full name: ${data.fullName}\n` +
    `Phone: ${data.phone}\n` +
    `Email: ${data.email}\n` +
    `Paid tickets: ${data.paidTickets}\n` +
    `Children under 10 (free): ${data.childrenUnder8}\n` +
    `Dandiya required: ${dandiyaNeeded}\n` +
    `Dandiya pairs: ${dandiyaPairs}\n` +
    (hasDandiya ? `Dandiya colour: ${colourValue}\n` : ``) + `\n` +
    `Presented by Radhe Krishna Sangeet and Vedant Music Academy\n` +
    `TEST registration — No money was charged.\n`;
  // Colourful HTML: tables + inline styles only, system fonts,
  // no external images, fonts or JavaScript. Max width 600px.
  // Sections in order: header, booking code, total, event/address,
  // details, footer. User values are escaped.
  const e = escapeHtml;
  const html =
    `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#fff8ee;font-family:Arial,Helvetica,sans-serif;color:#2b1a0e;">` +
    `<tr><td align="center" style="padding:16px;">` +
    `<table width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e8d9b8;">` +
    // 1. Dark header band.
    `<tr><td align="center" style="background-color:#2b1a0e;padding:28px 20px;">` +
    `<div style="font-family:Georgia,serif;font-size:34px;line-height:1.2;color:#f5c542;font-weight:bold;">Radhe Krishna Sangeet &amp;<br>Vedant Music Academy</div>` +
    `<div style="font-family:Georgia,serif;font-size:22px;line-height:1.3;color:#ffd98a;font-weight:bold;margin-top:10px;">Navratri Dhamaka</div>` +
    `<div style="font-size:14px;line-height:1.5;color:#ffd98a;margin-top:6px;">${e(heading)}</div>` +
    `</td></tr>` +
    `<tr><td style="padding:24px 24px 8px 24px;">` +
    `<p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">${e(intro)}</p>` +
    // 2. Large booking-code box.
    `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#fff3d6;border:2px solid #f5c542;">` +
    `<tr><td align="center" style="padding:20px;">` +
    `<div style="font-size:13px;letter-spacing:2px;color:#7a4a00;font-weight:bold;">BOOKING REFERENCE</div>` +
    `<div style="font-family:Georgia,serif;font-size:42px;line-height:1.2;color:#2b1a0e;font-weight:bold;margin-top:6px;">${e(ref)}</div>` +
    `<div style="font-size:13px;color:#5a3d1a;margin-top:6px;">Please keep this code for entry.</div>` +
    `</td></tr></table>` +
    // 3. Separate total box with breakdown.
    `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffedd6;border:1px solid #e67e22;margin-top:16px;">` +
    `<tr><td style="padding:20px;">` +
    `<div style="font-size:13px;letter-spacing:2px;color:#7a3c00;font-weight:bold;">${isPending ? "AMOUNT TO SEND (TEST)" : "AMOUNT PAID (TEST)"}</div>` +
    `<div style="font-family:Georgia,serif;font-size:36px;line-height:1.2;color:#2b1a0e;font-weight:bold;margin-top:6px;">${e(money(total))}</div>` +
    `<div style="font-size:14px;line-height:1.7;color:#2b1a0e;margin-top:10px;">` +
    `Paid tickets: ${data.paidTickets} × ${data.paidTickets >= 10 ? "$8.00" : "$10.00"} = ${e(money(ticketCost))}<br>` +
    `Dandiya cost: ${e(money(dandiyaCost))}<br>` +
    `Children under 10: free` +
    `</div></td></tr></table>` +
    // Pending manual-payment box: card emails do not get this box.
    (isPending
      ? `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#fff3d6;border:2px solid #f5c542;margin-top:16px;">` +
        `<tr><td style="padding:20px;">` +
        `<div style="font-size:13px;letter-spacing:2px;color:#7a4a00;font-weight:bold;">PAYMENT PENDING</div>` +
        `<div style="font-size:15px;line-height:1.8;color:#2b1a0e;margin-top:10px;">` +
        `<strong>Payment method:</strong> ${e(paymentMethodLabel(method))}<br>` +
        `<strong>Amount to send (test):</strong> ${e(money(total))}<br>` +
        `<strong>Send to:</strong> ${e(paymentDestination(method))}<br>` +
        `<strong>Memo:</strong> please include your booking code ${e(ref)}<br>` +
        `Your ticket will be confirmed only after payment is received. Zelle and Venmo payments cannot be verified automatically by this system.` +
        `</div></td></tr></table>`
      : ``) +
    // 4. Separate event/address box.
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
    // 5. Details section.
    `<div style="font-size:16px;font-weight:bold;color:#2b1a0e;margin-top:24px;margin-bottom:10px;">Your details</div>` +
    `<table width="100%" cellpadding="8" cellspacing="0" style="font-size:14px;line-height:1.6;border-collapse:collapse;">` +
    `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;width:180px;">Full name</td><td style="border-bottom:1px solid #eee0c8;">${e(data.fullName)}</td></tr>` +
    `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;">Phone</td><td style="border-bottom:1px solid #eee0c8;">${e(data.phone)}</td></tr>` +
    `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;">Email</td><td style="border-bottom:1px solid #eee0c8;">${e(data.email)}</td></tr>` +
    `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;">Paid tickets</td><td style="border-bottom:1px solid #eee0c8;">${data.paidTickets}</td></tr>` +
    `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;">Children under 10 (free)</td><td style="border-bottom:1px solid #eee0c8;">${data.childrenUnder8}</td></tr>` +
    `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;">Dandiya required</td><td style="border-bottom:1px solid #eee0c8;">${e(dandiyaNeeded)}</td></tr>` +
    `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;">Dandiya pairs</td><td style="border-bottom:1px solid #eee0c8;">${e(dandiyaPairs)}</td></tr>` +
    (hasDandiya
      ? `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;">Dandiya colour</td><td style="border-bottom:1px solid #eee0c8;">${e(data.colour)}</td></tr>`
      : ``) +
    (method === "apple_pay"
      ? `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;">Payment method</td><td style="border-bottom:1px solid #eee0c8;">Apple Pay (Test)</td></tr>`
      : ``) +
    `<tr><td style="color:#7a4a00;">Dandiya cost</td><td>${e(money(dandiyaCost))}</td></tr>` +
    `</table>` +
    // 6. Footer.
    `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#2b1a0e;margin-top:24px;">` +
    `<tr><td align="center" style="padding:18px;color:#ffffff;font-size:13px;line-height:1.6;">` +
    `Presented by Radhe Krishna Sangeet and Vedant Music Academy<br>` +
    `TEST registration — No money was charged.` +
    `</td></tr></table>` +
    `</td></tr></table>` +
    `</td></tr></table>`;
  return { text, html };
}

async function sendViaGmail(transporter, to, subject, body) {
  try {
    await transporter.sendMail({
      from: FROM,
      to,
      subject,
      text: body.text,
      html: body.html,
    });
    return true;
  } catch {
    // Do not return SMTP error details to the browser: they can
    // contain configuration details. Log a generic note only.
    console.log("Gmail send failed");
    return false;
  }
}

// Chicago date as YYYY-MM-DD, from the registration moment.
function chicagoDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Append one registration row and return its sequential code.
// Throws on any Sheet error, so the caller sends no email then.
// Race limitation: the next number is (existing data rows + 1).
// Two truly simultaneous registrations could read the same count
// and collide, and an email failure after a successful append
// leaves a gap in the sequence. For the expected low volume
// this is acceptable.
async function appendSheetRow(data, total, ticketCost, dandiyaCost, paymentMethod, paymentStatus) {
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
  const sheets = google.sheets({ version: "v4", auth });
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Sheet1!A:A",
  });
  const values = read.data.values || [];
  let dataRows = 0;
  for (const row of values) {
    if (row && row[0]) dataRows += 1;
  }
  // Exclude the header row, if present.
  if (values.length > 0 && values[0] && values[0][0] === "Registration Code") {
    dataRows -= 1;
  }
  if (dataRows < 0) dataRows = 0;
  const next = dataRows + 1;
  const ref = "VMA27-" + String(next).padStart(4, "0");
  const hasDandiya = data.dandiya && data.pairs >= 1;
  // Row order (17 columns): the existing 16 columns unchanged,
  // then Paid appended at the end so existing Sheet data is not
  // shifted: Registration Code, Date, Full Name, Phone, Email,
  // Adult Tickets, Children (count), Dandiya Required, Dandiya
  // Color, Amount Paid (total), Payment Status, Transaction ID,
  // QR Code URL (empty), Ticket Amount, Dandiya Amount, Payment
  // Method, Paid. Ticket Amount and Dandiya Amount are the two
  // parts of the total, so they always sum to it. Payment Status
  // is TEST for card and apple_pay, TEST_PENDING_ZELLE for Zelle,
  // and TEST_PENDING_VENMO for Venmo. Paid is "Yes" automatically
  // for card and apple_pay, because those payments are instant
  // (in live mode Stripe confirms them at once); for Zelle and
  // Venmo it is left blank, so the owner writes Yes manually
  // only after checking the payment himself.
  const row = [
    ref,
    chicagoDate(),
    data.fullName,
    data.phone,
    data.email,
    data.paidTickets,
    data.childrenUnder8,
    data.dandiya ? "Yes" : "No",
    hasDandiya ? data.colour : "",
    total,
    paymentStatus,
    "TEST",
    "",
    ticketCost,
    dandiyaCost,
    paymentMethod,
    paymentMethod === "card" || paymentMethod === "apple_pay" ? "Yes" : "",
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Sheet1!A:Q",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
  return ref;
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

  // Only these fields are read. Card fields, if present, are ignored.
  const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const paidTickets = body.paidTickets;
  const childrenUnder8 = body.childrenUnder8;
  const dandiya = body.dandiya === true;
  const pairs = body.pairs;
  const colour = typeof body.colour === "string" ? body.colour.trim() : "";
  // Payment method: card is the default for the old page, which
  // sends no paymentMethod. Unknown values are rejected. No
  // real payment verification is added for Zelle/Venmo: those
  // registrations stay pending until the owner confirms manually.
  // Apple Pay is a test simulation only (see header): no real
  // Apple Pay charge, so its status is TEST like card.
  const paymentMethod = body.paymentMethod === undefined || body.paymentMethod === null ? "card" : body.paymentMethod;
  if (paymentMethod !== "card" && paymentMethod !== "zelle" && paymentMethod !== "venmo" && paymentMethod !== "apple_pay") {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Unknown payment method." }) };
  }
  const paymentStatus = paymentMethod === "card" || paymentMethod === "apple_pay" ? "TEST" : paymentMethod === "zelle" ? "TEST_PENDING_ZELLE" : "TEST_PENDING_VENMO";

  if (!fullName) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Full name is required." }) };
  }
  if (!phone || phone.replace(/\D/g, "").length < 7) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "A valid phone number is required." }) };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "A valid email address is required." }) };
  }
  if (!isIntInRange(paidTickets, 1, 999)) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Paid tickets must be between 1 and 999." }) };
  }
  if (!isIntInRange(childrenUnder8, 0, 100)) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Children under 10 must be between 0 and 100." }) };
  }
  if (!isIntInRange(pairs, 0, 999)) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Dandiya pairs must be between 0 and 999." }) };
  }
  if (!dandiya && pairs !== 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Dandiya pairs must be 0 when dandiya is No." }) };
  }
  if (dandiya && pairs >= 1 && !COLOURS.includes(colour)) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Please choose a dandiya colour." }) };
  }

  // Server-side recomputation. The browser total is never used.
  const unitPrice = paidTickets >= 10 ? 8 : 10;
  const ticketCost = paidTickets * unitPrice;
  const dandiyaCost = dandiya && pairs >= 1 ? pairs * 5 : 0;
  const total = ticketCost + dandiyaCost;

  const gmailUser = process.env.GMAIL_USER;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailAppPassword) {
    // Generic message only: do not say which variable is missing.
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: "Email service is not configured." }) };
  }

  const data = { fullName, phone, email, paidTickets, childrenUnder8, dandiya, pairs, colour, paymentMethod, paymentStatus };

  // Sheet FIRST, with the sequential VMA27 code. If this fails,
  // no email is sent, so no registration is confirmed without
  // a Sheet row. For pending manual payments this row is still
  // saved first, with its pending status, not a confirmation.
  let ref;
  try {
    ref = await appendSheetRow(data, total, ticketCost, dandiyaCost, paymentMethod, paymentStatus);
  } catch {
    // Generic message only: do not leak Sheet/API error details.
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        ok: false,
        customerEmailSent: false,
        adminEmailSent: false,
        error: "Test registration could not be saved. Check the Netlify Sheet settings and try again.",
      }),
    };
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: gmailUser, pass: gmailAppPassword },
  });
  const customerBody = buildEmailBody(data, ref, total, ticketCost, dandiyaCost, false, paymentMethod);
  const adminBody = buildEmailBody(data, ref, total, ticketCost, dandiyaCost, true, paymentMethod);

  const customerSubject = paymentMethod === "card" || paymentMethod === "apple_pay"
    ? `[TEST] You are registered! Navratri Dhamaka — Oct 15, 2027 (${ref})`
    : `[TEST] Payment pending — Navratri Dhamaka — Oct 15, 2027 (${ref})`;
  const adminSubject = paymentMethod === "card" || paymentMethod === "apple_pay"
    ? `[TEST] New registration — Navratri Dhamaka (${ref})`
    : `[TEST] Payment pending — New registration — Navratri Dhamaka (${ref})`;
  const customerSent = await sendViaGmail(transporter, email, customerSubject, customerBody);
  const adminSent = await sendViaGmail(transporter, ADMIN_EMAIL, adminSubject, adminBody);

  if (!customerSent || !adminSent) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        ok: false,
        bookingReference: ref,
        total,
        customerEmailSent: customerSent,
        adminEmailSent: adminSent,
        error: "Test email could not be sent, but the registration was saved to the Sheet. Check the Netlify email settings and try again. Note: a re-registration will use the next code in the sequence.",
      }),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, bookingReference: ref, total, paymentMethod, paymentStatus, customerEmailSent: true, adminEmailSent: true }),
  };
};
