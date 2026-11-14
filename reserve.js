// Reserve stock, shared by Memory / Powerbank / Lookup.
//
// The phone app owns reserve_stock.json. Google only lets this web app write
// to files the web app itself created (drive.file scope), so web edits go to
// a second file, reserve_stock_web.json. Everything reads BOTH files and, per
// barcode, the entry with the newest updated_at wins. The phone app does the
// same merge, so an edit made on either side shows up on the other.
const RESERVE_PHONE_FILE = "reserve_stock.json";
const RESERVE_WEB_FILE = "reserve_stock_web.json";

const Reserve = {
  /** Merged view of both files: { barcode: {product_name, quantity, updated_at} } */
  async loadMerged() {
    const rootId = await Drive.findChild(CONFIG.ROOT_FOLDER, "root", true);
    if (!rootId) return {};
    const read = async (name) => {
      const id = await Drive.findChild(name, rootId);
      return id ? JSON.parse(await Drive.downloadText(id)) : {};
    };
    const phone = await read(RESERVE_PHONE_FILE);
    let web = {};
    try { web = await read(RESERVE_WEB_FILE); } catch (e) { console.warn("Web reserve file unreadable", e); }
    const merged = { ...phone };
    for (const [bc, e] of Object.entries(web)) {
      const cur = merged[bc];
      if (!cur || (e.updated_at || "") >= (cur.updated_at || "")) merged[bc] = e;
    }
    return merged;
  },

  /** Saves one count (even if unchanged - that refreshes the date). */
  async save(barcode, productName, quantity) {
    const rootId = await Drive.findChild(CONFIG.ROOT_FOLDER, "root", true);
    if (!rootId) throw new Error(`Couldn't find "${CONFIG.ROOT_FOLDER}" in your Drive.`);
    const id = await Drive.findChild(RESERVE_WEB_FILE, rootId);
    const web = id ? JSON.parse(await Drive.downloadText(id)) : {};
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const entry = { product_name: productName, quantity, updated_at: stamp };
    web[barcode] = entry;
    await Drive.saveJson(RESERVE_WEB_FILE, rootId, web);
    return entry;
  },

  /** Small edit row for a product pop-up. `uid` makes the element ids unique. */
  editorHtml(uid, qty, updatedAt) {
    const when = updatedAt ? updatedAt.slice(0, 10) : "never";
    return `
      <div class="reserve-editor" id="${uid}-editor">
        <span class="stat-label">Update reserve stock (last updated ${escapeHtml(when)})</span>
        <input type="number" min="0" id="${uid}-qty" value="${qty}" style="width:90px">
        <button type="button" id="${uid}-save" class="btn-small">Save</button>
        <span id="${uid}-msg" class="stock-breakdown"></span>
      </div>`;
  },

  /** Wires the editor. onSaved(entry) lets the caller refresh its numbers. */
  bindEditor(uid, barcode, productName, onSaved) {
    const btn = document.getElementById(`${uid}-save`);
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const input = document.getElementById(`${uid}-qty`);
      const msg = document.getElementById(`${uid}-msg`);
      const q = parseInt(input.value, 10);
      if (isNaN(q) || q < 0) { msg.textContent = "Enter a number."; return; }
      btn.disabled = true;
      msg.textContent = "Saving...";
      try {
        const entry = await this.save(barcode, productName, q);
        msg.textContent = "Saved " + entry.updated_at.slice(0, 10);
        onSaved(entry);
      } catch (e) {
        console.error(e);
        msg.textContent = "Save failed: " + e.message;
      } finally {
        btn.disabled = false;
      }
    });
  },
};
