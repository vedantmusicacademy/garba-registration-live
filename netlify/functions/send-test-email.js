// Netlify Function: send-test-email (Gmail version)
// TEST ONLY. No money is charged by this function. It does not
// process cards, does not call Stripe, and does not save to a
// Google Sheet. Sheet saving and live Stripe are future work
// and are NOT implemented here.
//
// What it does, on a POST from the test registration form:
//   1. Validates name, phone, email, paid tickets, children
//      under 8, dandiya Yes/No, pairs, and colour.
//   2. Recomputes the total on the server, never trusting
//      a total sent by the browser:
//        - paid tickets: $10 each for 1-9 tickets,
//          $8 each for 10 or more tickets
//        - children under 8: free ($0)
//        - dandiya: $3 per pair, only when dandiya is Yes
//          and pairs is 1 or more; 0 pairs = $0, and no
//          colour is required or shown for 0 pairs.
//   3. Generates a booking reference and sends two emails
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

const ADMIN_EMAIL = "vedantmusicacademy@gmail.com";
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

function buildEmailBody(data, ref, total, ticketCost, dandiyaCost, isAdmin) {
  const hasDandiya = data.dandiya && data.pairs >= 1;
  const dandiyaNeeded = data.dandiya ? "Yes" : "No";
  const dandiyaPairs = hasDandiya
    ? `${data.pairs} pair${data.pairs === 1 ? "" : "s"}`
    : "0 pairs";
  const colourValue = hasDandiya ? data.colour : "—";
  const heading = isAdmin
    ? "New TEST registration — Navratri Dhamaka"
    : "Your TEST ticket confirmation — Navratri Dhamaka";
  const intro = isAdmin
    ? "A new test registration was submitted. This is a TEST registration. No money was charged."
    : "Thank you for registering. This is a TEST registration. No money was charged.";
  // Plain-text fallback: same facts, same order, no styling.
  const text =
    `${heading}\n` +
    `${intro}\n\n` +
    `Booking reference: ${ref}\n` +
    `Total (test): ${money(total)}\n` +
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
    `Children under 8 (free): ${data.childrenUnder8}\n` +
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
    `<div style="font-family:Georgia,serif;font-size:34px;line-height:1.2;color:#f5c542;font-weight:bold;">Navratri Dhamaka</div>` +
    `<div style="font-size:14px;line-height:1.5;color:#ffffff;margin-top:8px;">Radhe Krishna Sangeet and Vedant Music Academy present</div>` +
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
    `<div style="font-size:13px;letter-spacing:2px;color:#7a3c00;font-weight:bold;">TOTAL (TEST)</div>` +
    `<div style="font-family:Georgia,serif;font-size:36px;line-height:1.2;color:#2b1a0e;font-weight:bold;margin-top:6px;">${e(money(total))}</div>` +
    `<div style="font-size:14px;line-height:1.7;color:#2b1a0e;margin-top:10px;">` +
    `Paid tickets: ${data.paidTickets} × ${data.paidTickets >= 10 ? "$8.00" : "$10.00"} = ${e(money(ticketCost))}<br>` +
    `Dandiya cost: ${e(money(dandiyaCost))}<br>` +
    `Children under 8: free` +
    `</div></td></tr></table>` +
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
    `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;">Children under 8 (free)</td><td style="border-bottom:1px solid #eee0c8;">${data.childrenUnder8}</td></tr>` +
    `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;">Dandiya required</td><td style="border-bottom:1px solid #eee0c8;">${e(dandiyaNeeded)}</td></tr>` +
    `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;">Dandiya pairs</td><td style="border-bottom:1px solid #eee0c8;">${e(dandiyaPairs)}</td></tr>` +
    (hasDandiya
      ? `<tr><td style="border-bottom:1px solid #eee0c8;color:#7a4a00;">Dandiya colour</td><td style="border-bottom:1px solid #eee0c8;">${e(data.colour)}</td></tr>`
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

  if (!fullName) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Full name is required." }) };
  }
  if (!phone || phone.replace(/\D/g, "").length < 7) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "A valid phone number is required." }) };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "A valid email address is required." }) };
  }
  if (!isIntInRange(paidTickets, 1, 100)) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Paid tickets must be between 1 and 100." }) };
  }
  if (!isIntInRange(childrenUnder8, 0, 100)) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Children under 8 must be between 0 and 100." }) };
  }
  if (!isIntInRange(pairs, 0, 100)) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Dandiya pairs must be between 0 and 100." }) };
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
  const dandiyaCost = dandiya && pairs >= 1 ? pairs * 3 : 0;
  const total = ticketCost + dandiyaCost;

  const gmailUser = process.env.GMAIL_USER;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailAppPassword) {
    // Generic message only: do not say which variable is missing.
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: "Email service is not configured." }) };
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: gmailUser, pass: gmailAppPassword },
  });

  const ref = "ND27-" + String(Math.floor(1000 + Math.random() * 9000));
  const data = { fullName, phone, email, paidTickets, childrenUnder8, dandiya, pairs, colour };
  const customerBody = buildEmailBody(data, ref, total, ticketCost, dandiyaCost, false);
  const adminBody = buildEmailBody(data, ref, total, ticketCost, dandiyaCost, true);

  const customerSent = await sendViaGmail(transporter, email, `[TEST] You are registered! Navratri Dhamaka — Oct 15, 2027 (${ref})`, customerBody);
  const adminSent = await sendViaGmail(transporter, ADMIN_EMAIL, `[TEST] New registration — Navratri Dhamaka (${ref})`, adminBody);

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
        error: "Test email could not be sent. Check the Netlify email settings and try again.",
      }),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, bookingReference: ref, total, customerEmailSent: true, adminEmailSent: true }),
  };
};
