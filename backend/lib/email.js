/**
 * email.js — Nodemailer email sender
 */
'use strict';

const nodemailer = require('nodemailer');

function createTransporter() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

/**
 * Send the admin notification email after confirmed registration.
 */
async function sendAdminNotification(reg) {
  const transporter = createTransporter();
  if (!transporter || !process.env.ADMIN_EMAIL) {
    console.log('ℹ Email skipped: SMTP or ADMIN_EMAIL not configured');
    return;
  }

  const subject = `New VMMUN 2026 Registration — ${reg.registration_number}`;
  const html = `
    <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#f6efd9;padding:2rem;border:1px solid #80653c66;">
      <h2 style="font-size:1.8rem;color:#261a0e;margin:0 0 0.5rem;">New Registration Confirmed</h2>
      <p style="font:10px monospace;letter-spacing:.15em;color:#742d21;text-transform:uppercase;margin:0 0 2rem;">VMMUN 2026 · EDITION 2.0</p>
      <table style="width:100%;border-collapse:collapse;">
        ${row('Registration ID', reg.registration_number)}
        ${row('Delegate', reg.name)}
        ${row('Email', reg.email)}
        ${row('Phone', reg.phone)}
        ${row('Institution', reg.school)}
        ${row('City', reg.city)}
        ${row('Delegate Type', reg.delegate_type)}
        ${row('Country Preferred', reg.country_preferred || '—')}
        ${row('Committee Preferences', [reg.committee_pref_1, reg.committee_pref_2, reg.committee_pref_3].filter(Boolean).join(' → '))}
        ${row('Allocated Committee', reg.allocated_committee_code || 'Pending')}
        ${row('Allocated Portfolio', reg.allocated_portfolio_name || 'Pending')}
        ${row('Payment Status', 'PAID ✓')}
        ${row('Amount', '₹' + (Number(process.env.REGISTRATION_FEE_PAISE || 50000) / 100).toFixed(2))}
        ${row('Razorpay Payment ID', reg.razorpay_payment_id || '—')}
        ${row('Razorpay Order ID', reg.razorpay_order_id || '—')}
        ${row('Registered At', reg.confirmed_at || new Date().toISOString())}
      </table>
    </div>
  `;

  await transporter.sendMail({
    from: `"VMMUN 2026" <${process.env.SMTP_USER}>`,
    to:   process.env.ADMIN_EMAIL,
    subject,
    html,
  });
}

/**
 * Send the delegate confirmation email.
 */
async function sendDelegateConfirmation(reg) {
  const transporter = createTransporter();
  if (!transporter || !reg.email) {
    console.log('ℹ Email skipped: SMTP or delegate email not configured');
    return;
  }

  const subject = `Your VMMUN 2026 Registration is Confirmed — ${reg.registration_number}`;
  const html = `
    <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#f6efd9;padding:2rem;border:1px solid #80653c66;">
      <h2 style="font-size:1.8rem;color:#261a0e;margin:0 0 0.5rem;">Registration Confirmed</h2>
      <p style="font:10px monospace;letter-spacing:.15em;color:#742d21;text-transform:uppercase;margin:0 0 2rem;">VMMUN 2026 · 23–24 October · Chennai</p>
      <p style="color:#261a0e;">Dear ${reg.name},</p>
      <p style="color:#261a0e;">Your registration for VMMUN 2026 has been confirmed. Please find your details below.</p>
      <table style="width:100%;border-collapse:collapse;margin:1.5rem 0;">
        ${row('Registration ID', reg.registration_number)}
        ${row('Name', reg.name)}
        ${row('Committee', reg.allocated_committee_code || 'To be announced')}
        ${row('Portfolio', reg.allocated_portfolio_name || 'To be announced')}
        ${row('Conference', '23–24 October 2026')}
        ${row('Venue', 'Velammal Matric. Hr. Sec. School, Mogappair, Chennai 600037')}
      </table>
      <p style="color:#261a0e;">Please carry your school ID and this confirmation to the venue. Gates open at 08:30 IST on Day One.</p>
      <p style="color:#4b3a28;font-size:.9rem;">For queries: <a href="mailto:vmmun26.edition2@gmail.com" style="color:#a87331;">vmmun26.edition2@gmail.com</a></p>
      <p style="font:10px monospace;letter-spacing:.12em;color:#742d21;text-transform:uppercase;margin-top:2rem;">Educate · Organise · Agitate</p>
    </div>
  `;

  await transporter.sendMail({
    from: `"VMMUN 2026" <${process.env.SMTP_USER}>`,
    to:   reg.email,
    subject,
    html,
  });
}

function row(label, value) {
  return `
    <tr>
      <td style="padding:.5rem;background:#ede1c4;border:1px solid #80653c66;font:9px monospace;letter-spacing:.1em;text-transform:uppercase;color:#742d21;width:40%;">${label}</td>
      <td style="padding:.5rem;background:#f6efd9;border:1px solid #80653c66;color:#261a0e;">${value || '—'}</td>
    </tr>`;
}

module.exports = { sendAdminNotification, sendDelegateConfirmation };
