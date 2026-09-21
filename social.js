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
  posts: [], // [{id, name, barcode, price, mediaUrl, mediaType, caption, createdAt, platforms:[{platform, scheduledAt, status}]}]
  productPhotos: {},
  searchResults: [],
  mode: "catalog", // "catalog" | "custom"
  selected: null, // {pid, name, price, barcode, mediaUrl, mediaType}

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
    document.getElementById("social-mode-catalog-btn").onclick = () => this.setMode("catalog");
    document.getElementById("social-mode-custom-btn").onclick = () => this.setMode("custom");
    document.getElementById("social-custom-file").onchange = (e) => this.uploadCustomMedia(e.target.files[0]);
    document.getElementById("social-custom-name").oninput = () => this._syncCustomSelection();
    document.getElementById("social-custom-price").oninput = () => this._syncCustomSelection();
    for (const p of SOCIAL_PLATFORMS) {
      const cb = document.getElementById(`social-platform-${p.key}`);
      const dt = document.getElementById(`social-time-${p.key}`);
      cb.onchange = () => { dt.disabled = !cb.checked; };
    }
  },

  setMode(mode) {
    this.mode = mode;
    document.getElementById("social-mode-catalog-btn").classList.toggle("active", mode === "catalog");
    document.getElementById("social-mode-custom-btn").classList.toggle("active", mode === "custom");
    document.getElementById("social-catalog-panel").hidden = mode !== "catalog";
    document.getElementById("social-custom-panel").hidden = mode !== "custom";
    this.selected = null;
    this._autoCaption = null;
    document.getElementById("social-selected-preview").innerHTML = "";
    document.getElementById("social-caption").value = "";
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

  async selectProduct(pid) {
    const detail = Lookup.productDetail(pid);
    if (!detail) return;
    const firstBarcode = (detail.barcodes || "").split(",")[0].trim();
    this.selected = {
      pid,
      name: detail.name,
      price: detail.price,
      barcode: firstBarcode,
      mediaUrl: firstBarcode ? this.photoFor(firstBarcode) : null,
      mediaType: "image",
      productUrl: null,
    };
    document.getElementById("social-search-input").value = detail.name;
    document.getElementById("social-search-results").innerHTML = "";
    this._renderSelectedPreview();
    this._fillCaption();

    if (firstBarcode) {
      const url = await this._fetchProductUrl(firstBarcode);
      // Only apply if the user hasn't since picked a different product.
      if (this.selected && this.selected.barcode === firstBarcode) {
        this.selected.productUrl = url;
        this._fillCaption();
      }
    }
  },

  /** Builds the caption template - re-run once the purchase link resolves
   * (it's fetched from the site after the initial render, see
   * selectProduct), but never clobbers a caption the user has since
   * started editing by hand. */
  _fillCaption() {
    const s = this.selected;
    if (!s) return;
    const el = document.getElementById("social-caption");
    if (this._autoCaption != null && el.value !== this._autoCaption) return;
    const lines = [s.name, "", `Price: ${money(s.price)}`];
    if (s.productUrl) lines.push("", `Buy here: ${s.productUrl}`);
    lines.push("", SOCIAL_DISCLAIMER);
    this._autoCaption = lines.join("\n");
    el.value = this._autoCaption;
  },

  /** Looks up a product's live purchase link by barcode/SKU via a small
   * public route on the site itself (wp-json/mrit/v1/product-url) -
   * WooCommerce's own Store API has the same data but doesn't send CORS
   * headers, so a direct browser call to it fails silently. Returns null
   * (caption just omits the link) on any error - a missing link shouldn't
   * block composing the rest of the post. */
  async _fetchProductUrl(barcode) {
    try {
      const resp = await fetch(`${CONFIG.SITE_URL}/wp-json/mrit/v1/product-url?sku=${encodeURIComponent(barcode)}`);
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.permalink || null;
    } catch (e) {
      return null;
    }
  },

  /** Custom-media path: for products not in Aronium at all (or just a photo/
   * video you want to post without it being tied to a catalog item). Upload
   * happens immediately on file pick, into its own Drive subfolder kept
   * separate from product_photos.json - that file is keyed by barcode and
   * gets wholesale-overwritten on catalog refreshes, so anything without a
   * barcode has no safe place in it. */
  async uploadCustomMedia(file) {
    if (!file) return;
    const statusEl = document.getElementById("social-custom-status");
    const isVideo = file.type.startsWith("video/");
    if (!file.type.startsWith("image/") && !isVideo) {
      statusEl.textContent = "Please choose an image or video file.";
      return;
    }
    statusEl.textContent = "Uploading...";
    try {
      const rootId = await Drive.findChild(CONFIG.ROOT_FOLDER, "root", true);
      if (!rootId) throw new Error(`Couldn't find "${CONFIG.ROOT_FOLDER}" in your Drive.`);
      const uploadsFolderId = await Drive.findOrCreateFolder("SocialMediaUploads", rootId);
      const fileId = await Drive.uploadMediaFile(file, uploadsFolderId);
      await Drive.makePublic(fileId);
      const mediaUrl = isVideo
        ? `https://drive.google.com/uc?export=download&id=${fileId}`
        : `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`;
      this._customMedia = { mediaUrl, mediaType: isVideo ? "video" : "image" };
      statusEl.textContent = "Uploaded.";
      this._syncCustomSelection();
    } catch (e) {
      statusEl.textContent = "";
      setStatus("Upload failed: " + e.message, true);
    }
  },

  /** Custom mode's "selected" is assembled from three independent inputs
   * (name, price, uploaded media) rather than one lookup - re-synced on any
   * of their changes so the preview/caption always reflect the latest. */
  _syncCustomSelection() {
    const name = document.getElementById("social-custom-name").value.trim();
    const priceStr = document.getElementById("social-custom-price").value.trim();
    const price = priceStr ? Number(priceStr) : null;
    if (!this._customMedia) return;
    this.selected = {
      pid: null,
      name: name || "(untitled)",
      price,
      barcode: null,
      mediaUrl: this._customMedia.mediaUrl,
      mediaType: this._customMedia.mediaType,
    };
    const priceLine = price != null ? `\n\nPrice: ${money(price)}` : "";
    document.getElementById("social-caption").value =
      `${name || ""}${priceLine}\n\n${SOCIAL_DISCLAIMER}`;
    this._renderSelectedPreview();
  },

  _renderSelectedPreview() {
    const el = document.getElementById("social-selected-preview");
    if (!this.selected) { el.innerHTML = ""; return; }
    const s = this.selected;
    let mediaHtml = `<p class="empty-state">No photo on file for this product yet.</p>`;
    if (s.mediaUrl) {
      mediaHtml = s.mediaType === "video"
        ? `<video class="product-photo-large" src="${s.mediaUrl}" controls></video>`
        : `<img class="product-photo-large" src="${s.mediaUrl}" alt="">`;
    }
    el.innerHTML = `
      ${mediaHtml}
      <p><strong>${escapeHtml(s.name)}</strong>${s.price != null ? ` &middot; ${money(s.price)}` : ""}${s.barcode ? ` &middot; ${escapeHtml(s.barcode)}` : ""}</p>
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
      mediaUrl: this.selected.mediaUrl,
      mediaType: this.selected.mediaType,
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
    this._customMedia = null;
    this._autoCaption = null;
    document.getElementById("social-search-input").value = "";
    document.getElementById("social-custom-name").value = "";
    document.getElementById("social-custom-price").value = "";
    document.getElementById("social-custom-file").value = "";
    document.getElementById("social-custom-status").textContent = "";
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
        ${this._renderQueueThumb(post)}
        <div class="social-post-body">
          <p class="social-post-name">${escapeHtml(post.name)}${post.price != null ? ` &middot; ${money(post.price)}` : ""}</p>
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

  _renderQueueThumb(post) {
    if (!post.mediaUrl) return `<div class="social-post-thumb social-post-thumb-empty"></div>`;
    if (post.mediaType === "video") {
      return `<div class="social-post-thumb social-post-thumb-video" title="Video"><span>&#9654;</span></div>`;
    }
    return `<img class="social-post-thumb" src="${post.mediaUrl}" alt="">`;
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
