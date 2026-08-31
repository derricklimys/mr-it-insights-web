# One-time setup

Two things to do once: add a second OAuth client (for the browser this time), and get this app onto GitHub Pages.

## 1. Add a "Web application" OAuth client

Same Google Cloud project you already created for the invoice migration.

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) → your existing project → **APIs & Services → Credentials**.
2. **Create Credentials → OAuth client ID**.
   - Application type: **Web application** (not Desktop this time).
   - Name: anything, e.g. "Mr IT Insights web app".
   - Under **Authorized JavaScript origins**, add: `https://derricklimys.github.io`
   - No redirect URI needed — leave that section empty.
   - Click **Create**. You'll get a **Client ID** (no secret this time — web apps using this sign-in method don't need one).
3. Go to **APIs & Services → OAuth consent screen → Data Access** (or **Scopes**, depending on the current console layout) and make sure both of these are listed as scopes the app can request:
   - `.../auth/drive.file`
   - `.../auth/drive.readonly`
   
   If `drive.readonly` isn't already listed, add it — since the app is still in Testing mode with just your account as a test user, this doesn't trigger any Google review.

4. Open `config.js` in this folder and replace `PASTE_YOUR_WEB_CLIENT_ID_HERE...` with the Client ID from step 2.

## 2. Put it on GitHub Pages

No git command line needed — GitHub's website handles this directly.

1. Go to [github.com/new](https://github.com/new), signed in as `derricklimys`.
   - Repository name: `mr-it-insights-web` (or anything you like — just note the name).
   - Public, no README needed.
   - Create repository.
2. On the new repo's page, click **uploading an existing file** (or drag-and-drop).
3. Drag in all the files from this folder: `index.html`, `style.css`, `config.js`, `drive.js`, `review.js`, `reports.js`, `app.js`. Commit.
4. Go to **Settings → Pages** (left sidebar).
   - Source: **Deploy from a branch**.
   - Branch: `main`, folder: `/ (root)`. Save.
5. GitHub will show the live URL, usually `https://derricklimys.github.io/mr-it-insights-web/` — takes a minute or two to go live the first time.

## 3. Try it

Open the Pages URL, click **Sign in with Google**. You should see a consent screen listing both scopes (file access + read-only Drive access) — confirm it's not asking for anything broader than that, then continue. The Review tab should list your 45 invoices.
