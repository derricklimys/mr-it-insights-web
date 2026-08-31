// Google Drive access from the browser - no backend. Uses Google Identity
// Services' token-client flow (the standard pattern for browser-only apps),
// then plain Drive REST v3 calls, mirroring the same folder-traversal logic
// already used in invoice_extraction/upload_to_drive.py.

const API_BASE = "https://www.googleapis.com/drive/v3";

const Drive = {
  accessToken: null,
  tokenClient: null,

  init(onSignedIn) {
    this.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: CONFIG.SCOPES,
      callback: (resp) => {
        if (resp.error) {
          setStatus("Sign-in failed: " + resp.error, true);
          return;
        }
        this.accessToken = resp.access_token;
        onSignedIn();
      },
    });
  },

  signIn() {
    this.tokenClient.requestAccessToken();
  },

  async _fetch(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    let resp;
    try {
      resp = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: { ...(options.headers || {}), Authorization: `Bearer ${this.accessToken}` },
      });
    } catch (e) {
      if (e.name === "AbortError") throw new Error(`Drive request timed out after 30s: ${url}`);
      throw new Error(`Drive request failed (network error): ${e.message}`);
    } finally {
      clearTimeout(timeoutId);
    }
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Drive request failed (${resp.status}): ${body}`);
    }
    return resp;
  },

  /** Finds a child by name under a parent folder (owned-by-me or shared-with-me). */
  async findChild(name, parentId, isFolder = false) {
    const mimeClause = isFolder ? " and mimeType = 'application/vnd.google-apps.folder'" : "";
    const q = `name = '${name.replace(/'/g, "\\'")}' and trashed = false and '${parentId}' in parents${mimeClause}`;
    const url = `${API_BASE}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent("files(id,name)")}&spaces=drive&includeItemsFromAllDrives=true&supportsAllDrives=true&corpora=allDrives`;
    const resp = await this._fetch(url);
    const data = await resp.json();
    return data.files.length ? data.files[0].id : null;
  },

  /** Finds a folder by name anywhere reachable (owned or shared-with-me) - used for the shop's shared AroniumReports folder, which has no fixed parent id we know. */
  async findFolderAnywhere(name) {
    const q = `name = '${name.replace(/'/g, "\\'")}' and trashed = false and mimeType = 'application/vnd.google-apps.folder'`;
    const url = `${API_BASE}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent("files(id,name,owners)")}&spaces=drive&includeItemsFromAllDrives=true&supportsAllDrives=true&corpora=allDrives`;
    const resp = await this._fetch(url);
    const data = await resp.json();
    return data.files.length ? data.files[0].id : null;
  },

  async listChildren(parentId) {
    const q = `trashed = false and '${parentId}' in parents`;
    const url = `${API_BASE}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent("files(id,name,mimeType)")}&spaces=drive&pageSize=1000&includeItemsFromAllDrives=true&supportsAllDrives=true&corpora=allDrives`;
    const resp = await this._fetch(url);
    const data = await resp.json();
    return data.files;
  },

  async downloadText(fileId) {
    const resp = await this._fetch(`${API_BASE}/files/${fileId}?alt=media`);
    return resp.text();
  },

  async downloadBlob(fileId) {
    const resp = await this._fetch(`${API_BASE}/files/${fileId}?alt=media`);
    return resp.blob();
  },

  /** Overwrites a file's content in place (does not touch its name/parents). */
  async updateContent(fileId, contentString, mimeType) {
    await this._fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
      { method: "PATCH", headers: { "Content-Type": mimeType }, body: contentString },
    );
  },
};

function setStatus(msg, isError = false) {
  const el = document.getElementById("status-line");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}
