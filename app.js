/**
 * app.js — VMMUN 2026 frontend application
 *
 * SECURITY MODEL:
 *  - Registration is created server-side via POST /api/register
 *  - Server creates the Razorpay order — the browser never touches order creation
 *  - After Razorpay callback, the server verifies the HMAC signature
 *  - The frontend CANNOT confirm a registration — only the backend can
 *  - "I have completed payment" button is gone; Razorpay handler calls verify directly
 */
'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────
const BACKEND_URL      = window.__BACKEND_URL || 'http://localhost:3001';
const CONFERENCE_START = '2026-10-23T09:00:00+05:30';

// ─── Intro scroll effect ───────────────────────────────────────────────────────
const intro     = document.querySelector('.intro');
const parchment = document.querySelector('.parchment');
const header    = document.querySelector('header');
let queued = false;

function scrollEffect() {
  const progress = Math.max(0, Math.min(1, scrollY / Math.max(1, intro.offsetHeight - innerHeight)));
  parchment.style.clipPath = `polygon(0 0,100% 0,100% ${100 - progress * 78}%,${progress * 22}% 100%,0 ${100 - progress * 58}%)`;
  parchment.style.filter   = `sepia(${progress * .3}) brightness(${1 - progress * .38})`;
  header.classList.toggle('show', progress > .08);
  queued = false;
}
addEventListener('scroll', () => { if (!queued) { requestAnimationFrame(scrollEffect); queued = true; } }, { passive: true });
scrollEffect();

const revealObserver = new IntersectionObserver(
  entries => entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); }),
  { threshold: .1 }
);
document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));

document.querySelector('.menu').onclick = e => {
  const nav  = document.querySelector('nav');
  const open = nav.classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', String(open));
};
document.querySelectorAll('nav a').forEach(link =>
  link.onclick = () => document.querySelector('nav').classList.remove('open')
);

// ─── Countdown timer ──────────────────────────────────────────────────────────
function updateCountdown() {
  const remaining = new Date(CONFERENCE_START) - Date.now();
  if (remaining <= 0) {
    document.querySelector('.count').innerHTML = '<p>THE CONFERENCE HAS BEGUN</p>';
    return;
  }
  const units = {
    days:    Math.floor(remaining / 864e5),
    hours:   Math.floor(remaining / 36e5)  % 24,
    minutes: Math.floor(remaining / 6e4)   % 60,
    seconds: Math.floor(remaining / 1e3)   % 60,
  };
  Object.entries(units).forEach(([unit, value]) =>
    document.querySelector(`[data-u="${unit}"]`).textContent = String(value).padStart(2, '0')
  );
}
updateCountdown();
setInterval(updateCountdown, 1000);

// ─── Registration form ────────────────────────────────────────────────────────
const form              = document.querySelector('#form');
const review            = document.querySelector('#review');
const errorEl           = document.querySelector('#error');
const paymentStatusEl   = document.querySelector('#payment-status');
const paymentBtn        = document.querySelector('#payment');
const submitRegistrationBtn = document.querySelector('#submit-registration');

// Holds registration state — never used to confirm, only to send to backend
let pendingRegistration = null;  // { registration_id, razorpay_order_id, razorpay_key_id, amount_paise, name, email }

// Dynamically update portfolio placeholders based on selected 1st committee
const firstCommSelect = form ? form.querySelector('[name="first"]') : null;
if (firstCommSelect) {
  firstCommSelect.addEventListener('change', () => {
    const val = (firstCommSelect.value || '').toUpperCase();
    const inputs = [
      form.querySelector('[name="portfolio_pref_1"]'),
      form.querySelector('[name="portfolio_pref_2"]'),
      form.querySelector('[name="portfolio_pref_3"]'),
      form.querySelector('[name="portfolio_pref_4"]'),
      form.querySelector('[name="portfolio_pref_5"]')
    ].filter(Boolean);

    let examples = ['France', 'Germany', 'Japan', 'Brazil', 'India'];
    if (val === 'AIPPM') {
      examples = ['Narendra Modi', 'Rahul Gandhi', 'Amit Shah', 'Arvind Kejriwal', 'M.K. Stalin'];
    } else if (val === 'TNLA') {
      examples = ['M.K. Stalin', 'Edappadi K. Palaniswami', 'Udhayanidhi Stalin', 'K. Annamalai', 'Seeman'];
    } else if (val === 'IP' || val === 'IPJ') {
      examples = ['The Hindu', 'Reuters', 'BBC', 'Indian Express', 'Al Jazeera'];
    }

    inputs.forEach((input, i) => {
      if (examples[i]) input.placeholder = `e.g. ${examples[i]}`;
    });
  });
}

// ─── Step 1: Form submit → build review screen ────────────────────────────────
form.onsubmit = event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));

  // Client-side validation (server always re-validates)
  if (!form.checkValidity()) {
    errorEl.textContent = 'Please complete all required fields with valid contact details.';
    form.reportValidity();
    return;
  }
  const prefs = [data.first, data.second, data.third];
  if (!data.first || !data.second || !data.third) {
    errorEl.textContent = 'Please select all three committee preferences.';
    return;
  }
  if (new Set(prefs).size !== 3) {
    errorEl.textContent = 'Please choose three different committee preferences.';
    return;
  }
  errorEl.textContent = '';

  // Build review details list (includes country + portfolio prefs)
  const detailsList = [
    ['Delegate',            data.name],
    ['Email',               data.email],
    ['Phone',               data.phone],
    ['Institution',         data.school],
    ['City',                data.city],
    ['Delegate type',       data.delegate_type],
    ['Country preferred',   data.country],
    ['1st committee',       data.first],
    ['2nd committee',       data.second],
    ['3rd committee',       data.third],
    ['Portfolio prefs',     [data.portfolio_pref_1, data.portfolio_pref_2, data.portfolio_pref_3, data.portfolio_pref_4, data.portfolio_pref_5].filter(Boolean).join(' · ') || '—'],
  ].filter(([, val]) => Boolean(val));

  document.querySelector('#details').innerHTML = detailsList
    .map(([label, value]) => `<div><small>${label}</small><br>${safe(value)}</div>`)
    .join('');

  form.hidden   = true;
  review.hidden = false;
};

document.querySelector('#edit').onclick = () => {
  form.hidden   = false;
  review.hidden = true;
};

// ─── Step 2: "Proceed to payment" → create registration + order, open Razorpay ─
if (paymentBtn) {
  paymentBtn.onclick = async () => {
    paymentBtn.disabled    = true;
    paymentBtn.textContent = 'Creating registration…';
    showPaymentMessage('Connecting to server…');

    const data = Object.fromEntries(new FormData(form));

    let resp;
    try {
      resp = await fetch(`${BACKEND_URL}/api/register`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:             data.name,
          email:            data.email,
          phone:            data.phone,
          school:           data.school,
          city:             data.city,
          delegate_type:    data.delegate_type,
          country_preferred: data.country || null,
          committee_pref_1: data.first,
          committee_pref_2: data.second,
          committee_pref_3: data.third,
          portfolio_pref_1: data.portfolio_pref_1 || null,
          portfolio_pref_2: data.portfolio_pref_2 || null,
          portfolio_pref_3: data.portfolio_pref_3 || null,
          portfolio_pref_4: data.portfolio_pref_4 || null,
          portfolio_pref_5: data.portfolio_pref_5 || null,
        }),
      });
    } catch {
      showPaymentMessage('Could not reach the server. Check your connection and try again.', true);
      paymentBtn.disabled    = false;
      paymentBtn.textContent = 'Proceed to payment →';
      return;
    }

    const json = await resp.json();
    if (!resp.ok) {
      showPaymentMessage(json.error || 'Registration failed. Please try again.', true);
      paymentBtn.disabled    = false;
      paymentBtn.textContent = 'Proceed to payment →';
      return;
    }

    pendingRegistration = json;

    // Open Razorpay checkout
    openRazorpay(json);

    paymentBtn.disabled    = false;
    paymentBtn.textContent = 'Proceed to payment →';
  };
}

// ─── Step 3: Open Razorpay — server-issued order ──────────────────────────────
function openRazorpay(regData) {
  if (typeof Razorpay === 'undefined') {
    // Dynamically load Razorpay SDK if not already present
    const script  = document.createElement('script');
    script.src    = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => initRazorpay(regData);
    document.head.appendChild(script);
  } else {
    initRazorpay(regData);
  }
}

function initRazorpay(regData) {
  const options = {
    key:         regData.razorpay_key_id,
    amount:      regData.amount_paise,
    currency:    'INR',
    order_id:    regData.razorpay_order_id,
    name:        'VMMUN 2026',
    description: 'Delegate Registration Fee',
    prefill: {
      name:    regData.name,
      email:   regData.email,
    },
    theme: { color: '#a87331' },

    handler: async function(response) {
      // Razorpay calls this with payment info — we MUST verify server-side
      showPaymentMessage('Payment received — verifying with server…');
      if (submitRegistrationBtn) submitRegistrationBtn.hidden = true;

      await verifyPaymentWithServer(
        regData.registration_id,
        response.razorpay_order_id,
        response.razorpay_payment_id,
        response.razorpay_signature
      );
    },

    modal: {
      ondismiss: function() {
        // User closed Razorpay without paying — registration stays pending
        showPaymentMessage(
          'Payment was not completed. Your registration is saved — click "Proceed to payment" to try again.',
          true
        );
        // Show retry button if user may want to retry
        if (paymentBtn) {
          paymentBtn.disabled    = false;
          paymentBtn.textContent = 'Retry payment →';
        }
      },
    },
  };

  const rz = new Razorpay(options);
  rz.open();
  showPaymentMessage('Razorpay payment window opened. Complete your payment there.');
}

// ─── Step 4: Server-side payment verification ─────────────────────────────────
async function verifyPaymentWithServer(registrationId, orderId, paymentId, signature) {
  try {
    const resp = await fetch(`${BACKEND_URL}/api/payment/verify`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        registration_id:    registrationId,
        razorpay_order_id:  orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      }),
    });

    const json = await resp.json();

    if (!resp.ok) {
      showPaymentMessage(
        '⚠ Payment verification failed: ' + (json.error || 'Unknown error') +
        '. If you were charged, contact vmmun26.edition2@gmail.com with your payment ID.',
        true
      );
      return;
    }

    // ── SUCCESS ── Show confirmation
    review.innerHTML = `
      <p class="label">SEALED &amp; RECORDED</p>
      <h3>Registration confirmed.</h3>
      <div id="details" style="display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line);margin:1rem 0;">
        ${confirmDetail('Registration ID', safe(json.registration_number))}
        ${confirmDetail('Committee', safe(json.allocated_committee || 'To be announced'))}
        ${confirmDetail('Portfolio', safe(json.allocated_portfolio || 'To be announced'))}
        ${confirmDetail('Payment', 'Paid ✓')}
      </div>
      <p class="note">A confirmation email has been sent to your registered address.
        Keep your registration ID <strong>${safe(json.registration_number)}</strong> for conference entry.</p>
    `;

  } catch {
    showPaymentMessage(
      'Network error during verification. If you were charged, email vmmun26.edition2@gmail.com with your payment ID.',
      true
    );
  }
}

function confirmDetail(label, value) {
  return `<div style="background:#ede1c4;padding:.7rem"><small style="font:9px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--red)">${label}</small><br>${value}</div>`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function showPaymentMessage(message, isError = false) {
  if (!paymentStatusEl) return;
  paymentStatusEl.textContent = message;
  paymentStatusEl.classList.toggle('error', isError);
}

function safe(value) {
  const el = document.createElement('div');
  el.textContent = value || '';
  return el.innerHTML;
}
