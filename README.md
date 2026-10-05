# Easy Gas landing page

A single static page (`index.html` + `easy-gas-logo.png`). No server, database or login.
Every order and enquiry opens WhatsApp (+263 78 918 4693) with the message already typed;
the customer presses send. Nothing is stored on the website.

## Edit business details
Open `index.html` and edit the `CONFIG` block near the bottom (price, WhatsApp number,
delivery areas, delivery fees, pick-up address). Leave a delivery fee as `null` until decided;
the page then says "confirmed on WhatsApp", never "free".
The price and address also appear in the page text and the structured data in `<head>`;
search for `1.90` / `8182` if they change.

## Preview locally
    node ../scripts/serve-landing.mjs 3200      # then open http://localhost:3200

## Put it online (free options)
- Netlify Drop: drag the `landing` folder onto https://app.netlify.com/drop
- Cloudflare Pages or GitHub Pages: upload the two files.
Then point your domain at it.

## Still to confirm before going live
- Is $1.90 USD **per kg**? (The page currently says $1.90 / kg.)
- Delivery fees per area, opening hours, payment methods, cylinder sizes (optional additions).
- A phone number for calls, if different from WhatsApp (adds a Call button).
