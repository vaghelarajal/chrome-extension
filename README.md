# AI CRM Extension

Chrome extension and Node.js backend for extracting LinkedIn profile data into a structured CRM-ready format.

The extension collects profile text and screenshots from the active browser tab, then sends the data to a local Express backend. The backend uses OpenAI to normalize the scraped profile information into structured JSON.

## Project Structure

```text
ai-crm-extension/
  backend/
    server.js
    package.json
    package-lock.json
  extension/
    manifest.json
    background.js
    content.js
    popup.html
    popup.js
```

## Requirements

- Node.js
- npm
- Google Chrome
- OpenAI API key

## Backend Setup

From the project root:

```powershell
cd ai-crm-extension\backend
npm install
```

Create a local `.env` file inside `ai-crm-extension/backend`:

```env
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4o
```

Do not commit `.env` or any real API keys.

## Run the Backend

```powershell
cd ai-crm-extension\backend
npm start
```

The backend runs on:

```text
http://localhost:3000
```

## Load the Chrome Extension

1. Open Chrome and go to `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this folder:

```text
C:\Users\baps\Chrome-extension\ai-crm-extension\extension
```

## Usage

1. Start the backend with `npm start`.
2. Load the extension in Chrome.
3. Open a LinkedIn profile page.
4. Open the extension side panel.
5. Click the scrape action to extract and process the profile.

## API Endpoints

The extension calls these local backend endpoints:

- `POST /scrape/parse-text` - parses extracted profile text.
- `POST /scrape/parse-image` - parses screenshot data when vision extraction is needed.

## Development Notes

- The backend is in `ai-crm-extension/backend`.
- The Chrome extension source is in `ai-crm-extension/extension`.
- Use npm for Node.js dependencies.
- Keep secrets in local environment files only.
- Do not commit generated, credential, or local-only files.


Suggested commit message:

```text
docs(readme): add project setup instructions
```
