# Invaritech Contact API

A simple Next.js API server for handling contact form submissions and integrating with Google Sheets via Google Apps Script.

## Features

- Contact form API endpoint
- CORS support for static websites
- Webhook secret validation
- Google Apps Script integration
- Error handling and validation

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   ```bash
   cp env.example .env.local
   ```
   
   Update `.env.local` with your actual values:
   - `GOOGLE_SCRIPT_URL`: Your Google Apps Script web app URL
   - `WEBHOOK_SECRET`: Secret key for validation (must match Google Apps Script)
   - `RECAPTCHA_SECRET_KEY`: Optional reCAPTCHA secret key

3. **Run development server:**
   ```bash
   npm run dev
   ```

4. **Deploy to Vercel:**
   ```bash
   npx vercel
   ```

## API Endpoints

### POST /api/contact

Submit contact form data.

**Request Body:**
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "phone": "123-456-7890",
  "country": "USA",
  "message": "Hello world",
  "source": "Contact Form",
  "webhookSecret": "your-secret",
  "recaptchaToken": "recaptcha-token"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Form submitted successfully"
}
```

## Integration with Static Website

Update your static website's contact form to point to the deployed API:

```javascript
const response = await fetch('https://your-api-domain.vercel.app/api/contact', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(formData),
});
```

## Environment Variables for Vercel

When deploying to Vercel, add these environment variables in your Vercel dashboard:

- `GOOGLE_SCRIPT_URL`
- `WEBHOOK_SECRET`
- `RECAPTCHA_SECRET_KEY` (optional)
