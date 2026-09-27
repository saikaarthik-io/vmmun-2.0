# VMMUN 2026

Historical-themed responsive VMMUN website. Open `index.html` in a browser.

Conference: **23–24 October 2026** at Velammal Matric. Hr. Sec. School, Mogappair, Chennai 600037. Contact: **vmmun26.edition2@gmail.com**. Each committee has a dedicated page under `committees/`. Shared copy lives in `committees-data.js`. Update agendas and resource links there and on `index.html` before launch. The committee roster is exactly AIPPM, UNGA, ECOSOC, IP, UNHRC, IPJ, and UNSC. No Secretariat names have been added.

The payment button is deliberately non-functional until it has a secured backend. A real deployment must create Razorpay orders and verify payment signatures server-side, store secret keys only in environment variables, validate data again on the server, and protect all admin/data access.

## Payment and Formspree setup

The date is set to **23 October 2026, 09:00 IST** in `app.js`.

1. Add the Razorpay **public** key to `RAZORPAY_KEY_ID`.
2. Create server endpoints matching `CREATE_ORDER_URL` and `VERIFY_PAYMENT_URL`. They must create Razorpay orders and validate the signature using the secret held only in server environment variables.
3. Create a Formspree form whose recipient is the administrator, then add its form ID to `FORMSPREE_FORM_ID`.

The delegate’s personal information is never posted to Formspree during review or payment. Only after a verified payment and the delegate pressing **Submit registration** is it sent to the Formspree endpoint.