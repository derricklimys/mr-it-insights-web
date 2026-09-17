// Social tab: compose one product post (photo + price + a standing
// disclaimer, since nobody's going back to edit these after posting) and
// queue it out to Facebook/Instagram/Google Business/TikTok at times picked
// separately per platform. Reuses the same product data and photos already
// in the app rather than a second copy of either.
//
// Phase 1 only: this builds and saves the queue. Nothing here actually
// posts anywhere yet - each platform needs its own business verification +
// app review before that's possible at all (see the published proposal),
// and the queue-checking script that will eventually fire these posts runs
// as a separate cloud routine, not from this page. Saving a post here is
// "plan it now, it goes out once the platform is approved" - the status
// badge says so plainly so nothing here is mistaken for already live.

const SOCIAL_QUEUE_FILE = "social_posts_queue.json";
const SOCIAL_DISCLAIMER = "Stock subject to availability. Price subject to change without notice.";
const SOCIAL_PLATFORMS = [
  { key: "facebook", label: "Facebook" },
  { key: "instagram", label: "Instagram" },
  { key: "google_business", label: "Google Business" },
  { key: "tiktok", label: "TikTok" },
];

const Social = {
  loaded: false,
  posts: [], // [{id, name, barcode, price, photoUrl, caption, createdAt, platforms:[{platform, scheduledAt, status}]}]
  productPhotos: {},
  searchResults: [],
  selected: null, // {pid, name, price, barcode, photoUrl}

  async ensureLoaded() {
    if (this.loaded) return;
    await Lookup.ensureLoaded();
    this.productPhotos = (await this._loadDriveJson("product_photos.json")) || {};
    const saved = await this._loadDriveJson(SOCIAL_QUEUE_FILE);
    this.posts = saved && Array.isArray(saved.posts) ? saved.posts : [];
    this.loaded = true;
  },

  async render() {
    const statusEl = document.getElementById("social-status");
    statusEl.textContent = "Loading products...";
    try {
      await this.ensureLoaded();
      statusEl.textContent = "";
      this._wireForm();
      this.renderQueue();
    } catch (e) {
      statusEl.textContent = "";
      setStatus(e.message, true);
    }
  },

  _wireForm() {
    document.getElementById("social-search-input").oninput = (e) => this.search(e.target.value);
    document.getElementById("social-add-btn").onclick = () => this.addToQueue();
    for (const p of SOCIAL_PLATFORMS) {
      const cb = document.getElementById(`social-platform-${p.key}`);
      const dt = document.getElementById(`social-time-${p.key}`);
      cb.onchange = () => { dt.disabled = !cb.checked; };
    }
  },

  photoFor(barcode) {
    const entry = this.productPhotos[barcode];
    return entry ? entry.url : null;
  },

  search(term) {
    const el = document.getElementById("social-search-results");
    if (!term || term.trim().length < 2) {
      el.innerHTML = "";
      return;
    }
    const byBarcode = /^\d+$/.test(term.trim()) ? Lookup.findByBarcode(term.trim()) : null;
    const rows = byBarcode ? [byBarcode] : Lookup.searchByName(term.trim(), 15);
    if (!rows.length) {
      el.innerHTML = `<p class="empty-state">No matching product.</p>`;
      return;
    }
    el.innerHTML = rows.map((r) => `
      <div class="social-search-row" data-pid="${r.pid}">
        <span>${escapeHtml(r.name)}</span>
        <span class="insight-barcode">${escapeHtml(r.barcodes || "")}</span>
        <button class="btn social-pick-btn" data-pid="${r.pid}">Use this</button>
      </div>`).join("");
    el.querySelectorAll(".social-pick-btn").forEach((btn) => {
      btn.addEventListener("click", () => this.selectProduct(Number(btn.dataset.pid)));
    });
  },

  selectProduct(pid) {
    const detail = Lookup.productDetail(pid);
    if (!detail) return;
    const firstBarcode = (detail.barcodes || "").split(",")[0].trim();
    this.selected = {
      pid,
      name: detail.name,
      price: detail.price,
      barcode: firstBarcode,
      photoUrl: firstBarcode ? this.photoFor(firstBarcode) : null,
    };
    document.getElementById("social-search-input").value = detail.name;
    document.getElementById("social-search-results").innerHTML = "";
    document.getElementById("social-caption").value =
      `${detail.name}\n\nPrice: ${money(detail.price)}\n\n${SOCIAL_DISCLAIMER}`;
    this._renderSelectedPreview();
  },

  _renderSelectedPreview() {
    const el = document.getElementById("social-selected-preview");
    if (!this.selected) { el.innerHTML = ""; return; }
    const s = this.selected;
    el.innerHTML = `
      ${s.photoUrl ? `<img class="product-photo-large" src="${s.photoUrl}" alt="">` : `<p class="empty-state">No photo on file for this product yet.</p>`}
      <p><strong>${escapeHtml(s.name)}</strong> &middot; ${money(s.price)} &middot; ${escapeHtml(s.barcode || "")}</p>
    `;
  },

  addToQueue() {
    const statusEl = document.getElementById("social-add-status");
    if (!this.selected) {
      statusEl.textContent = "Search for a product and pick one first.";
      return;
    }
    const caption = document.getElementById("social-caption").value.trim();
    if (!caption) {
      statusEl.textContent = "Caption can't be empty.";
      return;
    }
    const platforms = [];
    for (const p of SOCIAL_PLATFORMS) {
      const cb = document.getElementById(`social-platform-${p.key}`);
      const dt = document.getElementById(`social-time-${p.key}`);
      if (cb.checked) {
        if (!dt.value) {
          statusEl.textContent = `Pick a date/time for ${p.label}, or untick it.`;
          return;
        }
        platforms.push({ platform: p.key, scheduledAt: dt.value, status: "pending" });
      }
    }
    if (!platforms.length) {
      statusEl.textContent = "Tick at least one platform.";
      return;
    }
    const post = {
      id: `post-${Date.now()}`,
      name: this.selected.name,
      barcode: this.selected.barcode,
      price: this.selected.price,
      photoUrl: this.selected.photoUrl,
      caption,
      createdAt: new Date().toISOString(),
      platforms,
    };
    this.posts.push(post);
    statusEl.textContent = "Saving...";
    this._saveDriveJson(SOCIAL_QUEUE_FILE, { posts: this.posts }).then(() => {
      statusEl.textContent = "Added to queue.";
      this._resetForm();
      this.renderQueue();
    }).catch((e) => {
      statusEl.textContent = "";
      setStatus("Save failed: " + e.message, true);
    });
  },

  _resetForm() {
    this.selected = null;
    document.getElementById("social-search-input").value = "";
    document.getElementById("social-caption").value = "";
    document.getElementById("social-selected-preview").innerHTML = "";
    for (const p of SOCIAL_PLATFORMS) {
      document.getElementById(`social-platform-${p.key}`).checked = false;
      const dt = document.getElementById(`social-time-${p.key}`);
      dt.value = "";
      dt.disabled = true;
    }
  },

  renderQueue() {
    const el = document.getElementById("social-queue");
    if (!this.posts.length) {
      el.innerHTML = `<p class="empty-state">Nothing queued yet.</p>`;
      return;
    }
    const sorted = [...this.posts].sort((a, b) => {
      const at = Math.min(...a.platforms.map((p) => new Date(p.scheduledAt).getTime()));
      const bt = Math.min(...b.platforms.map((p) => new Date(p.scheduledAt).getTime()));
      return at - bt;
    });
    el.innerHTML = sorted.map((post) => `
      <div class="social-post-card">
        ${post.photoUrl ? `<img class="social-post-thumb" src="${post.photoUrl}" alt="">` : `<div class="social-post-thumb social-post-thumb-empty"></div>`}
        <div class="social-post-body">
          <p class="social-post-name">${escapeHtml(post.name)} &middot; ${money(post.price)}</p>
          <p class="social-post-caption">${escapeHtml(post.caption)}</p>
          <div class="social-post-platforms">
            ${post.platforms.map((p) => `
              <span class="social-platform-chip">
                ${escapeHtml(SOCIAL_PLATFORMS.find((x) => x.key === p.platform).label)}
                &middot; ${escapeHtml(this._fmtDateTime(p.scheduledAt))}
                &middot; <span class="social-status-${p.status}">${escapeHtml(p.status)}</span>
                <button class="link-btn social-cancel-platform" data-id="${post.id}" data-platform="${p.platform}">cancel</button>
              </span>`).join("")}
          </div>
        </div>
        <button class="btn social-delete-post" data-id="${post.id}" title="Delete this post entirely">Delete</button>
      </div>`).join("");
    el.querySelectorAll(".social-cancel-platform").forEach((btn) => {
      btn.addEventListener("click", () => this.cancelPlatform(btn.dataset.id, btn.dataset.platform));
    });
    el.querySelectorAll(".social-delete-post").forEach((btn) => {
      btn.addEventListener("click", () => this.deletePost(btn.dataset.id));
    });
  },

  _fmtDateTime(isoLocal) {
    const d = new Date(isoLocal);
    return d.toLocaleString("en-SG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  },

  async cancelPlatform(id, platform) {
    const post = this.posts.find((p) => p.id === id);
    if (!post) return;
    post.platforms = post.platforms.filter((p) => p.platform !== platform);
    if (!post.platforms.length) this.posts = this.posts.filter((p) => p.id !== id);
    await this._saveDriveJson(SOCIAL_QUEUE_FILE, { posts: this.posts });
    this.renderQueue();
  },

  async deletePost(id) {
    this.posts = this.posts.filter((p) => p.id !== id);
    await this._saveDriveJson(SOCIAL_QUEUE_FILE, { posts: this.posts });
    this.renderQueue();
  },

  async _loadDriveJson(name) {
    const rootId = await Drive.findChild(CONFIG.ROOT_FOLDER, "root", true);
    if (!rootId) return null;
    const fileId = await Drive.findChild(name, rootId);
    if (!fileId) return null;
    return JSON.parse(await Drive.downloadText(fileId));
  },

  async _saveDriveJson(name, obj) {
    const rootId = await Drive.findChild(CONFIG.ROOT_FOLDER, "root", true);
    if (!rootId) throw new Error(`Couldn't find "${CONFIG.ROOT_FOLDER}" in your Drive.`);
    await Drive.saveJson(name, rootId, obj);
  },
};
