
"use strict";

/* =========================================================
   SKILLCIRCLE — MAIN APPLICATION SCRIPT
   Features: Directory, Map, Reviews, OTP Authentication,
   Private Chat, Professional Group Chat
========================================================= */

const CONFIG = window.SKILLCIRCLE_CONFIG || {};
const API_URL = CONFIG.GOOGLE_SCRIPT_URL;
const MAP_KEY = CONFIG.MAPTILER_API_KEY;

const $ = selector => document.querySelector(selector);

let workers = [];
let reviews = [];
let map = null;
let markers = [];
let toastTimer;
let detectedLocation = null;

let currentUser = null;
let sessionToken = sessionStorage.getItem("skillcircle-session-token") || "";

let authMode = "login";
let pendingAuthEmail = "";

let activeConversation = null;
let activeGroup = null;
let chatPollTimer = null;

const CHAT_REFRESH_INTERVAL = 5000;

const skillIcons = {
  carpenter: "🪚",
  plumber: "🔧",
  electrician: "⚡",
  painter: "🎨",
  mechanic: "🛠️",
  "appliance repair": "🔌",
  gardener: "🌱",
  mason: "🧱",
  cleaner: "🧹",
  welder: "⚙️",
  "ac technician": "❄️",
  other: "🧰"
};


/* =========================================================
   GENERAL HELPERS
========================================================= */

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function showToast(message) {
  const toast = $("#toast");
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add("visible");

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    toast.classList.remove("visible");
  }, 3200);
}

function setMessage(selector, message, isError = false) {
  const element = $(selector);
  if (!element) return;

  element.textContent = message;
  element.classList.toggle("error", isError);
}

function getFormObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function formatDate(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleString([], {
    dateStyle: "short",
    timeStyle: "short"
  });
}

function getInitials(name) {
  return String(name || "SC")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(part => part[0] || "")
    .join("")
    .toUpperCase();
}

function averageRating(workerId) {
  const matching = reviews.filter(
    review => String(review.workerId) === String(workerId)
  );

  if (!matching.length) return null;

  return matching.reduce(
    (total, review) => total + Number(review.rating || 0),
    0
  ) / matching.length;
}

function reviewCount(workerId) {
  return reviews.filter(
    review => String(review.workerId) === String(workerId)
  ).length;
}

function ratingLabel(workerId) {
  const rating = averageRating(workerId);
  return rating === null ? "New profile" : `${rating.toFixed(1)} ★`;
}

function getSkillIcon(skill) {
  return skillIcons[String(skill || "").toLowerCase()] || "🧰";
}


/* =========================================================
   THEME
========================================================= */

function setTheme(isDark) {
  document.documentElement.dataset.theme = isDark ? "dark" : "light";

  const toggle = $("#themeToggle");
  const icon = $("#themeIcon");

  if (toggle) toggle.checked = isDark;
  if (icon) icon.textContent = isDark ? "☾" : "☀";

  try {
    localStorage.setItem(
      "skillcircle-theme",
      isDark ? "dark" : "light"
    );
  } catch (_) {}

  if (map && window.maptilersdk) {
    map.setStyle(
      isDark
        ? maptilersdk.MapStyle.STREETS.DARK
        : maptilersdk.MapStyle.STREETS
    );
  }
}

function initializeTheme() {
  let saved = "light";

  try {
    saved = localStorage.getItem("skillcircle-theme") || "light";
  } catch (_) {}

  setTheme(saved === "dark");

  $("#themeToggle")?.addEventListener("change", event => {
    setTheme(event.target.checked);
  });
}


/* =========================================================
   GOOGLE APPS SCRIPT API
========================================================= */

function ensureConfigured() {
  if (
    !API_URL ||
    API_URL.includes("YOUR_EXISTING_GOOGLE_APPS_SCRIPT")
  ) {
    throw new Error(
      "Add your deployed Google Apps Script URL in index.html."
    );
  }

  if (
    !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:\?.*)?$/.test(API_URL)
  ) {
    throw new Error(
      "Your Google Apps Script URL must be a deployed /exec URL."
    );
  }
}

async function apiGet(action, parameters = {}) {
  ensureConfigured();

  const url = new URL(API_URL);
  url.searchParams.set("action", action);

  Object.entries(parameters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await fetch(url.toString(), {
    method: "GET",
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`Server request failed (${response.status}).`);
  }

  const data = await response.json();

  if (data.success !== true) {
    throw new Error(data.message || "Unable to retrieve data.");
  }

  return data;
}

async function apiPost(payload) {
  ensureConfigured();

  const response = await fetch(API_URL, {
    method: "POST",
    redirect: "follow",
    headers: {
      "Content-Type": "text/plain;charset=utf-8"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Server request failed (${response.status}).`);
  }

  const data = await response.json();

  if (data.success !== true) {
    throw new Error(data.message || "The server rejected the request.");
  }

  return data;
}

function authenticatedPayload(payload = {}) {
  return {
    ...payload,
    token: sessionToken
  };
}


/* =========================================================
   MAP
========================================================= */

function initializeMap() {
  const container = $("#map");
  if (!container) return;

  if (!MAP_KEY || MAP_KEY.includes("YOUR_EXISTING_MAPTILER")) {
    container.textContent =
      "Add your MapTiler API key in index.html to enable the map.";
    return;
  }

  if (!window.maptilersdk) {
    container.textContent = "The map library could not be loaded.";
    return;
  }

  maptilersdk.config.apiKey = MAP_KEY;

  map = new maptilersdk.Map({
    container: "map",
    style: maptilersdk.MapStyle.STREETS,
    center: [75.8573, 30.9010],
    zoom: 11
  });

  map.addControl(
    new maptilersdk.NavigationControl(),
    "top-right"
  );

  map.on("error", event => {
    console.error("MapTiler error:", event.error || event);
  });

  map.on("load", renderMarkers);
  map.on("style.load", renderMarkers);
}

function removeMarkers() {
  markers.forEach(marker => marker.remove());
  markers = [];
}

function validCoordinates(worker) {
  if (
    worker.lat === "" ||
    worker.lng === "" ||
    worker.lat == null ||
    worker.lng == null
  ) {
    return false;
  }

  const lat = Number(worker.lat);
  const lng = Number(worker.lng);

  return Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180;
}

function makePopup(worker) {
  const popup = document.createElement("div");
  popup.className = "map-popup";

  const name = document.createElement("strong");
  name.textContent = worker.name || "Professional";

  const skill = document.createElement("span");
  skill.textContent = worker.skill || "Local service";

  const area = document.createElement("span");
  area.textContent = worker.area || "Area not specified";

  const rating = document.createElement("span");
  rating.textContent = `Client rating: ${ratingLabel(worker.id)}`;

  popup.append(name, skill, area, rating);
  return popup;
}

function renderMarkers() {
  if (!map || !window.maptilersdk || !map.loaded()) return;

  removeMarkers();

  workers.forEach(worker => {
    if (!validCoordinates(worker)) return;

    const marker = new maptilersdk.Marker({
      color: "#28745c"
    })
      .setLngLat([
        Number(worker.lng),
        Number(worker.lat)
      ])
      .setPopup(
        new maptilersdk.Popup({ offset: 24 })
          .setDOMContent(makePopup(worker))
      )
      .addTo(map);

    markers.push(marker);
  });
}


/* =========================================================
   DIRECTORY
========================================================= */

function getFilteredWorkers() {
  const query = ($("#searchInput")?.value || "").trim().toLowerCase();
  const selectedSkill = ($("#skillFilter")?.value || "").toLowerCase();
  const sort = $("#sortFilter")?.value || "rating";

  return workers.filter(worker => {
    const searchable = [
      worker.name,
      worker.skill,
      worker.area,
      worker.description
    ].join(" ").toLowerCase();

    return searchable.includes(query) &&
      (
        !selectedSkill ||
        String(worker.skill).toLowerCase() === selectedSkill
      );
  }).sort((a, b) => {
    if (sort === "name") {
      return String(a.name).localeCompare(String(b.name));
    }

    const ratingA = averageRating(a.id) ?? -1;
    const ratingB = averageRating(b.id) ?? -1;

    return ratingB - ratingA ||
      String(a.name).localeCompare(String(b.name));
  });
}

function renderWorkers() {
  const list = $("#workerList");
  if (!list) return;

  const filtered = getFilteredWorkers();
  const count = $("#resultsCount");

  if (count) {
    count.textContent =
      `${filtered.length} professional${filtered.length === 1 ? "" : "s"}`;
  }

  if (!filtered.length) {
    list.innerHTML =
      '<div class="empty-state">No matching professionals found. Try another search or skill.</div>';
    return;
  }

  list.innerHTML = filtered.map(worker => {
    const icon = getSkillIcon(worker.skill);
    const rating = averageRating(worker.id);
    const countReviews = reviewCount(worker.id);

    return `
      <article class="worker-card">
        <div class="worker-card-top">
          <div class="avatar">${icon}</div>

          <div class="worker-info">
            <h3>${escapeHTML(worker.name)}</h3>
            <div class="worker-skill">${escapeHTML(worker.skill)}</div>
            <div class="worker-area">
              ⌖ ${escapeHTML(worker.area || "Area not provided")}
            </div>
          </div>

          <div class="worker-rating">
            <span class="stars">
              ${rating === null ? "☆☆☆☆☆" : "★★★★★"}
            </span><br>
            ${rating === null ? "New" : rating.toFixed(1)}
            <small>(${countReviews})</small>
          </div>
        </div>

        <p class="worker-description">
          ${escapeHTML(
            worker.description ||
            "Contact this professional to discuss your requirements."
          )}
        </p>

        <div class="worker-meta">
          <span>
            ${escapeHTML(worker.experience || "Experience not specified")}
          </span>
          <span>
            ${worker.price
              ? `From ₹${escapeHTML(worker.price)}`
              : "Contact for pricing"}
          </span>
        </div>

        <div class="worker-actions">
          <button
            class="btn btn-primary"
            type="button"
            data-chat-worker="${escapeHTML(worker.id)}">
            Message professional
          </button>

          <button
            class="btn btn-secondary"
            type="button"
            data-review-worker="${escapeHTML(worker.id)}">
            Review after hiring
          </button>

          ${validCoordinates(worker) ? `
            <button
              class="btn btn-secondary"
              type="button"
              data-show-map="${escapeHTML(worker.id)}">
              View on map
            </button>
          ` : ""}
        </div>
      </article>
    `;
  }).join("");

  list.querySelectorAll("[data-chat-worker]").forEach(button => {
    button.addEventListener("click", () => {
      openPrivateChat(button.dataset.chatWorker);
    });
  });

  list.querySelectorAll("[data-review-worker]").forEach(button => {
    button.addEventListener("click", () => {
      const select = $("#reviewWorker");

      if (select) {
        select.value = button.dataset.reviewWorker;
      }

      $("#reviews")?.scrollIntoView({ behavior: "smooth" });
    });
  });

  list.querySelectorAll("[data-show-map]").forEach(button => {
    button.addEventListener("click", () => {
      const worker = workers.find(
        item => String(item.id) === button.dataset.showMap
      );

      if (!worker || !validCoordinates(worker) || !map) {
        showToast("Map coordinates are not available.");
        return;
      }

      map.flyTo({
        center: [Number(worker.lng), Number(worker.lat)],
        zoom: 14
      });

      const validWorkers = workers.filter(validCoordinates);
      const index = validWorkers.findIndex(
        item => String(item.id) === String(worker.id)
      );

      if (markers[index]) markers[index].togglePopup();

      $("#map")?.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    });
  });
}


/* =========================================================
   REVIEW WORKER OPTIONS
========================================================= */

function renderReviewWorkerOptions() {
  const select = $("#reviewWorker");
  if (!select) return;

  const previousValue = select.value;

  select.innerHTML =
    '<option value="">Select a professional</option>';

  workers.forEach(worker => {
    const option = document.createElement("option");
    option.value = worker.id;
    option.textContent = `${worker.name} — ${worker.skill}`;
    select.appendChild(option);
  });

  if (
    workers.some(worker => String(worker.id) === previousValue)
  ) {
    select.value = previousValue;
  }
}


/* =========================================================
   PUBLIC REVIEWS
========================================================= */

function renderReviews() {
  const list = $("#reviewList");
  if (!list) return;

  const publicCount = $("#publicReviewCount");
  const reviewCountElement = $("#reviewCount");

  if (publicCount) {
    publicCount.textContent =
      `${reviews.length} review${reviews.length === 1 ? "" : "s"}`;
  }

  if (reviewCountElement) {
    reviewCountElement.textContent = reviews.length;
  }

  if (!reviews.length) {
    list.innerHTML =
      '<div class="empty-state">No reviews yet. Client feedback will appear here after the first submission.</div>';
    return;
  }

  list.innerHTML = reviews.slice().reverse().slice(0, 20).map(review => {
    const worker = workers.find(
      item => String(item.id) === String(review.workerId)
    );

    const stars = Math.max(
      0,
      Math.min(5, Math.round(Number(review.rating) || 0))
    );

    const date = review.createdAt
      ? new Date(review.createdAt).toLocaleDateString()
      : "";

    return `
      <article class="review-card">
        <div class="review-card-top">
          <div>
            <h3>
              ${escapeHTML(worker ? worker.name : "Local professional")}
            </h3>
            <small>
              ${escapeHTML(worker ? worker.skill : "Service review")}
            </small>
          </div>

          <span class="stars">
            ${"★".repeat(stars)}${"☆".repeat(5 - stars)}
          </span>
        </div>

        <p>${escapeHTML(review.comment)}</p>
        <small>Client review · ${escapeHTML(date)}</small>
      </article>
    `;
  }).join("");
}


/* =========================================================
   STATISTICS
========================================================= */

function updateStats() {
  const workerCount = $("#workerCount");
  const skillCount = $("#skillCount");

  if (workerCount) {
    workerCount.textContent = workers.length;
  }

  const uniqueSkills = new Set(
    workers
      .map(worker => String(worker.skill || "").trim().toLowerCase())
      .filter(Boolean)
  );

  if (skillCount) {
    skillCount.textContent = uniqueSkills.size;
  }
}


/* =========================================================
   MAPTILER GEOCODING
========================================================= */

async function geocodeAddress(address) {
  if (!MAP_KEY || MAP_KEY.includes("YOUR_EXISTING_MAPTILER")) {
    throw new Error("Configure your MapTiler key before registering.");
  }

  const url = new URL(
    `https://api.maptiler.com/geocoding/${encodeURIComponent(address)}.json`
  );

  url.searchParams.set("key", MAP_KEY);
  url.searchParams.set("limit", "1");
  url.searchParams.set("country", "in");

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error("Could not look up that service area.");
  }

  const data = await response.json();
  const feature = data.features?.[0];

  if (!feature || !Array.isArray(feature.center)) {
    throw new Error(
      "No map location found. Add your city or a nearby landmark."
    );
  }

  return {
    lng: Number(feature.center[0]),
    lat: Number(feature.center[1])
  };
}

async function reverseGeocode(latitude, longitude) {
  if (!MAP_KEY || MAP_KEY.includes("YOUR_EXISTING_MAPTILER")) {
    throw new Error("MapTiler API key is missing.");
  }

  const url = new URL(
    `https://api.maptiler.com/geocoding/${longitude},${latitude}.json`
  );

  url.searchParams.set("key", MAP_KEY);
  url.searchParams.set("language", "en");

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error("Address lookup failed.");
  }

  const data = await response.json();

  if (!data.features?.length) {
    throw new Error("No readable address found.");
  }

  return data.features[0].place_name;
}


/* =========================================================
   LOCATION DETECTION
========================================================= */

function initializeLocationDetection() {
  const button = $("#detectLocationBtn");
  const input = $("#location");
  const status = $("#locationStatus");

  if (!button || !input || !status) return;

  input.addEventListener("input", () => {
    detectedLocation = null;
    status.textContent = "";
  });

  button.addEventListener("click", () => {
    if (!navigator.geolocation) {
      status.textContent =
        "Your browser does not support location detection.";
      return;
    }

    button.disabled = true;
    button.textContent = "Detecting location...";
    status.textContent =
      "Please allow location access in your browser.";

    navigator.geolocation.getCurrentPosition(
      async position => {
        try {
          const latitude = position.coords.latitude;
          const longitude = position.coords.longitude;

          const address = await reverseGeocode(latitude, longitude);

          input.value = address;

          detectedLocation = {
            lat: latitude,
            lng: longitude,
            address
          };

          status.textContent =
            "✓ Your current location has been detected successfully.";

        } catch (error) {
          detectedLocation = null;
          status.textContent =
            error.message || "Couldn't find your address.";

        } finally {
          button.disabled = false;
          button.innerHTML = "📍 Detect my current location";
        }
      },

      error => {
        const messages = {
          1: "Location permission denied. Allow access in your browser.",
          2: "Your location could not be determined. Try again.",
          3: "Location request timed out. Please try again."
        };

        status.textContent =
          messages[error.code] || "Unable to detect your location.";

        button.disabled = false;
        button.innerHTML = "📍 Detect my current location";
      },

      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      }
    );
  });
}


/* =========================================================
   REGISTER A PROFESSIONAL
========================================================= */

function initializeRegistration() {
  const form = $("#registerForm");
  if (!form) return;

  form.addEventListener("submit", async event => {
    event.preventDefault();

    const button = form.querySelector('[type="submit"]');
    if (button) button.disabled = true;

    setMessage(
      "#registerMessage",
      "Finding your approximate service location..."
    );

    try {
      const data = getFormObject(form);

      if (!data.consent) {
        throw new Error(
          "Please confirm your consent to publish the listing."
        );
      }

      let location;

      if (
        detectedLocation &&
        detectedLocation.address === data.area
      ) {
        location = {
          lat: detectedLocation.lat,
          lng: detectedLocation.lng
        };
      } else {
        location = await geocodeAddress(`${data.area}, India`);
      }

      setMessage(
        "#registerMessage",
        "Saving your professional listing..."
      );

      await apiPost({
        action: "register",
        name: data.name,
        skill: data.skill,
        email: data.email,
        phone: data.phone,
        area: data.area,
        address: data.area,
        experience: data.experience,
        price: data.price,
        description: data.description,
        lat: location.lat,
        lng: location.lng,
        consent: true
      });

      form.reset();
      detectedLocation = null;

      setMessage(
        "#registerMessage",
        "Your listing has been saved. You can now sign up as a professional using the same email address."
      );

      await loadData();

      if (map && map.loaded()) {
        map.flyTo({
          center: [location.lng, location.lat],
          zoom: 13
        });
      }

      showToast("Your professional listing was registered.");

    } catch (error) {
      console.error("Registration error:", error);

      setMessage(
        "#registerMessage",
        error.message || "Unable to save your listing.",
        true
      );

    } finally {
      if (button) button.disabled = false;
    }
  });
}


/* =========================================================
   SUBMIT REVIEWS
========================================================= */

function initializeReviews() {
  const form = $("#reviewForm");
  if (!form) return;

  form.addEventListener("submit", async event => {
    event.preventDefault();

    const button = form.querySelector('[type="submit"]');
    if (button) button.disabled = true;

    try {
      const data = getFormObject(form);

      const worker = workers.find(
        item => String(item.id) === String(data.workerId)
      );

      if (!worker) {
        throw new Error("Select a registered professional.");
      }

      if (!String(data.jobReference || "").trim()) {
        throw new Error("Enter the reference for the job.");
      }

      const result = await apiPost({
        action: "rate",
        workerId: data.workerId,
        clientEmail: data.clientEmail,
        jobReference: data.jobReference,
        rating: Number(data.rating),
        comment: data.comment
      });

      form.reset();

      setMessage(
        "#reviewMessage",
        result.verified
          ? "Your client review has been saved."
          : "Review received. The demo backend cannot independently verify the completed job."
      );

      await loadData();
      showToast("Thank you for sharing your experience.");

    } catch (error) {
      setMessage(
        "#reviewMessage",
        error.message || "Unable to submit your review.",
        true
      );

    } finally {
      if (button) button.disabled = false;
    }
  });
}


/* =========================================================
   AUTHENTICATION — MODAL DISPLAY
========================================================= */

/*
  These functions must remain at the top level.
  The tab buttons and OTP flow call them directly.
*/

function showAuthForm() {
  const formPanel = $("#authFormPanel");
  const otpPanel = $("#otpPanel");

  if (formPanel) {
    formPanel.hidden = false;
    formPanel.removeAttribute("hidden");
  }

  if (otpPanel) {
    otpPanel.hidden = true;
    otpPanel.setAttribute("hidden", "");
  }

  setMessage("#authMessage", "");
  setMessage("#otpMessage", "");
}

function updateAuthMode() {
  const loginTab = $("#loginTab");
  const signupTab = $("#signupTab");

  const title = $("#authTitle");
  const nameField = $("#authNameField");
  const phoneField = $("#authPhoneField");

  const roleField = $("#authRole");
  const professionalHint = $("#professionalAuthHint");
  const submitButton = $("#authSubmitBtn");

  const isSignup = authMode === "signup";

  // Update tab appearance and accessibility state.
  if (loginTab) {
    loginTab.classList.toggle("active", !isSignup);
    loginTab.setAttribute("aria-selected", String(!isSignup));
  }

  if (signupTab) {
    signupTab.classList.toggle("active", isSignup);
    signupTab.setAttribute("aria-selected", String(isSignup));
  }

  // Show or hide fields required only during registration.
  if (nameField) {
    nameField.hidden = !isSignup;
    nameField.classList.toggle("hidden", !isSignup);
  }

  if (phoneField) {
    phoneField.hidden = !isSignup;
    phoneField.classList.toggle("hidden", !isSignup);
  }

  // Role selection is needed when creating an account.
  if (roleField) {
    roleField.hidden = !isSignup;
    roleField.classList.toggle("hidden", !isSignup);
  }

  if (professionalHint) {
    professionalHint.hidden = !isSignup;
    professionalHint.classList.toggle("hidden", !isSignup);
  }

  if (title) {
    title.textContent = isSignup
      ? "Create your account"
      : "Welcome back";
  }

  if (submitButton) {
    submitButton.textContent = isSignup
      ? "Create account"
      : "Continue with email";
  }

  // Clear messages when switching between tabs.
  setMessage("#authMessage", "");
  setMessage("#otpMessage", "");
}

function showOtpForm() {
  const formPanel = $("#authFormPanel");
  const otpPanel = $("#otpPanel");

  if (formPanel) {
    formPanel.hidden = true;
    formPanel.setAttribute("hidden", "");
  }

  if (otpPanel) {
    otpPanel.hidden = false;
    otpPanel.removeAttribute("hidden");
  }

  $("#otpCode")?.focus();
}

function openAuthModal(mode = "login") {
  authMode = mode === "signup" ? "signup" : "login";

  const overlay = $("#authOverlay");

  if (!overlay) {
    showToast("The login window is unavailable.");
    return;
  }

  overlay.removeAttribute("hidden");
  overlay.hidden = false;
  overlay.classList.add("visible");
  overlay.setAttribute("aria-hidden", "false");

  showAuthForm();
  updateAuthMode();
}

function closeAuthModal() {
  const overlay = $("#authOverlay");
  if (!overlay) return;

  overlay.classList.remove("visible");
  overlay.setAttribute("aria-hidden", "true");
  overlay.setAttribute("hidden", "");
  overlay.hidden = true;

  pendingAuthEmail = "";
}


/* =========================================================
   AUTHENTICATION — EVENT LISTENERS
========================================================= */

function initializeAuthModal() {
  const loginButton = $("#loginOpenBtn");
  const signupButton = $("#signupOpenBtn");
  const closeButton = $("#authCloseBtn");
  const overlay = $("#authOverlay");

  if (loginButton) {
    loginButton.addEventListener("click", event => {
      event.preventDefault();
      openAuthModal("login");
    });
  }

  if (signupButton) {
    signupButton.addEventListener("click", event => {
      event.preventDefault();
      openAuthModal("signup");
    });
  }

  if (closeButton) {
    closeButton.addEventListener("click", event => {
      event.preventDefault();
      closeAuthModal();
    });
  }

  // Clicking the dark backdrop closes the modal.
  if (overlay) {
    overlay.addEventListener("click", event => {
      if (event.target === overlay) {
        closeAuthModal();
      }
    });
  }

  $("#loginTab")?.addEventListener("click", event => {
    event.preventDefault();

    authMode = "login";
    showAuthForm();
    updateAuthMode();
  });

  $("#signupTab")?.addEventListener("click", event => {
    event.preventDefault();

    authMode = "signup";
    showAuthForm();
    updateAuthMode();
  });

  $("#backToAuthBtn")?.addEventListener("click", event => {
    event.preventDefault();

    showAuthForm();
    updateAuthMode();
  });

  $("#authForm")?.addEventListener(
    "submit",
    handleStartAuthentication
  );

  $("#otpForm")?.addEventListener(
    "submit",
    handleVerifyAuthentication
  );

  $("#accountButton")?.addEventListener("click", event => {
    event.preventDefault();
    $("#accountMenu")?.classList.toggle("open");
  });

  document.addEventListener("click", event => {
    const menu = $("#accountMenu");
    const accountButton = $("#accountButton");

    if (
      menu &&
      !menu.contains(event.target) &&
      !accountButton?.contains(event.target)
    ) {
      menu.classList.remove("open");
    }
  });

  $("#logoutBtn")?.addEventListener("click", logout);

  // Set the initial tab state when the page loads.
  updateAuthMode();
}


/* =========================================================
   START AUTHENTICATION — SEND OTP
========================================================= */

async function handleStartAuthentication(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const button = $("#authSubmitBtn");

  if (button) button.disabled = true;

  try {
    const data = getFormObject(form);

    const email = normalizeEmail(data.email);
    const role = data.role || "client";

    if (!email) {
      throw new Error("Enter your email address.");
    }

    if (authMode === "signup") {
      if (!data.name?.trim()) {
        throw new Error("Enter your name.");
      }

      if (!data.phone?.trim()) {
        throw new Error("Enter your phone number.");
      }
    }

    setMessage("#authMessage", "Sending your verification code...");

    const result = await apiPost({
      action: "startAuth",
      email,
      role,
      name: data.name || "",
      phone: data.phone || ""
    });

    pendingAuthEmail = email;

    const display = $("#otpEmailDisplay");

    if (display) {
      display.textContent = email;
    }

    showOtpForm();

    setMessage(
      "#otpMessage",
      result.message || "A verification code has been sent to your email."
    );

  } catch (error) {
    console.error("Authentication start error:", error);

    setMessage(
      "#authMessage",
      error.message || "Unable to start authentication.",
      true
    );

  } finally {
    if (button) button.disabled = false;
  }
}


/* =========================================================
   VERIFY OTP
========================================================= */

async function handleVerifyAuthentication(event) {
  event.preventDefault();

  const button = $("#verifyOtpBtn");
  if (button) button.disabled = true;

  try {
    const otp = $("#otpCode")?.value.trim();

    if (!pendingAuthEmail) {
      throw new Error("Please request a verification code first.");
    }

    if (!otp || !/^\d{6}$/.test(otp)) {
      throw new Error("Enter the six-digit verification code.");
    }

    setMessage("#otpMessage", "Verifying your code...");

    // Backend expects the property name "otp", not "code".
    const result = await apiPost({
      action: "verifyAuth",
      email: pendingAuthEmail,
      otp
    });

    if (!result.token || !result.profile) {
      throw new Error("The server did not return a valid login session.");
    }

    sessionToken = result.token;
    currentUser = result.profile;

    sessionStorage.setItem(
      "skillcircle-session-token",
      sessionToken
    );

    pendingAuthEmail = "";

    $("#otpForm")?.reset();

    closeAuthModal();
    updateAccountUI();

    showToast("You are now logged in.");

    await loadChatDashboard();
    navigateToSection("messages");

  } catch (error) {
    console.error("OTP verification error:", error);

    setMessage(
      "#otpMessage",
      error.message || "Verification failed.",
      true
    );

  } finally {
    if (button) button.disabled = false;
  }
}


/* =========================================================
   SESSION VALIDATION
========================================================= */

function updateAccountUI() {
  const loggedIn = Boolean(currentUser);

  const loginButton = $("#loginOpenBtn");
  const signupButton = $("#signupOpenBtn");
  const accountMenu = $("#accountMenu");

  if (loginButton) loginButton.hidden = loggedIn;
  if (signupButton) signupButton.hidden = loggedIn;
  if (accountMenu) accountMenu.hidden = !loggedIn;

  const name = $("#accountName");
  const email = $("#accountEmail");
  const avatar = $("#accountAvatar");

  if (name) {
    name.textContent = currentUser?.name || "SkillCircle member";
  }

  if (email) {
    email.textContent = currentUser?.email || "";
  }

  if (avatar) {
    avatar.textContent = getInitials(currentUser?.name);
  }

  const messagesLink = $("#sidebarMessages");

  if (messagesLink) {
    messagesLink.hidden = !loggedIn;
  }
}

async function validateExistingSession() {
  if (!sessionToken) {
    currentUser = null;
    updateAccountUI();
    return false;
  }

  try {
    const data = await apiGet("profile", {
      token: sessionToken
    });

    currentUser = data.profile || null;

    if (!currentUser) {
      throw new Error("Session profile is missing.");
    }

    updateAccountUI();
    return true;

  } catch (error) {
    console.warn("Session validation failed:", error);

    sessionToken = "";
    currentUser = null;

    sessionStorage.removeItem("skillcircle-session-token");

    updateAccountUI();
    return false;
  }
}

async function logout() {
  try {
    if (sessionToken) {
      await apiPost({
        action: "logout",
        token: sessionToken
      });
    }
  } catch (error) {
    console.warn("Logout request failed:", error);
  }

  sessionToken = "";
  currentUser = null;
  activeConversation = null;
  activeGroup = null;

  sessionStorage.removeItem("skillcircle-session-token");

  stopChatPolling();
  updateAccountUI();
  closeChatViews();

  $("#accountMenu")?.classList.remove("open");

  showToast("You have been logged out.");
  navigateToSection("discover");
}


/* =========================================================
   NAVIGATION TO SECTIONS
========================================================= */

function navigateToSection(sectionName) {
  const section = document.getElementById(sectionName);
  if (!section) return;

  document.querySelectorAll(".main-section").forEach(item => {
    item.classList.remove("section-active");
  });

  section.classList.add("section-active");
  section.hidden = false;

  section.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}


/* =========================================================
   CHAT DASHBOARD
========================================================= */

function initializeChat() {
  $("#privateMessageForm")?.addEventListener(
    "submit",
    sendPrivateMessage
  );

  $("#groupMessageForm")?.addEventListener(
    "submit",
    sendGroupMessage
  );

  $("#chatBackBtn")?.addEventListener("click", () => {
    closeChatViews();
    loadChatDashboard();
  });

  $("#groupBackBtn")?.addEventListener("click", () => {
    closeChatViews();
    loadChatDashboard();
  });
}

function closeChatViews() {
  $("#privateChat")?.setAttribute("hidden", "");
  $("#groupChat")?.setAttribute("hidden", "");
  $("#chatEmpty")?.removeAttribute("hidden");

  activeConversation = null;
  activeGroup = null;

  stopChatPolling();
}

function stopChatPolling() {
  if (chatPollTimer) {
    clearInterval(chatPollTimer);
    chatPollTimer = null;
  }
}

function startChatPolling(callback) {
  stopChatPolling();

  chatPollTimer = setInterval(() => {
    if (document.visibilityState === "visible") {
      callback();
    }
  }, CHAT_REFRESH_INTERVAL);
}

async function loadChatDashboard() {
  if (!currentUser || !sessionToken) return;

  closeChatViews();

  const conversationList = $("#conversationList");
  const skillGroupList = $("#skillGroupList");

  if (conversationList) {
    conversationList.innerHTML =
      '<div class="chat-loading">Loading conversations...</div>';
  }

  if (skillGroupList) {
    skillGroupList.innerHTML =
      '<div class="chat-loading">Loading skill groups...</div>';
  }

  try {
    const results = await Promise.all([
      apiGet("conversations", { token: sessionToken }),
      apiGet("skillGroups", { token: sessionToken })
    ]);

    renderConversations(results[0].conversations || []);
    renderSkillGroups(results[1].groups || []);

  } catch (error) {
    console.error("Chat dashboard error:", error);

    if (conversationList) {
      conversationList.innerHTML =
        `<div class="empty-state">${escapeHTML(error.message)}</div>`;
    }

    if (skillGroupList) {
      skillGroupList.innerHTML =
        '<div class="empty-state">Unable to load skill groups.</div>';
    }
  }
}


/* =========================================================
   PRIVATE CONVERSATIONS
========================================================= */

function renderConversations(conversations) {
  const list = $("#conversationList");
  if (!list) return;

  const count = $("#conversationCount");

  if (count) {
    count.textContent = conversations.length;
  }

  if (!conversations.length) {
    list.innerHTML =
      '<div class="empty-state">No conversations yet. Message a professional from the directory to get started.</div>';
    return;
  }

  list.innerHTML = conversations.map(conversation => {
    const title =
      conversation.otherName ||
      conversation.workerName ||
      "SkillCircle member";

    return `
      <button
        type="button"
        class="conversation-item"
        data-conversation-id="${escapeHTML(conversation.conversationId)}"
        data-worker-id="${escapeHTML(conversation.workerId)}">

        <span class="chat-avatar">
          ${escapeHTML(getInitials(title))}
        </span>

        <span class="conversation-details">
          <strong>${escapeHTML(title)}</strong>
          <small>${escapeHTML(conversation.skill || "Private chat")}</small>
          <span>${escapeHTML(conversation.lastMessage || "Start chatting")}</span>
        </span>

        <time>${escapeHTML(formatDate(conversation.lastMessageAt))}</time>
      </button>
    `;
  }).join("");

  list.querySelectorAll("[data-conversation-id]").forEach(button => {
    button.addEventListener("click", () => {
      const conversation = conversations.find(
        item =>
          String(item.conversationId) ===
          String(button.dataset.conversationId)
      );

      if (conversation) {
        openExistingConversation(conversation);
      }
    });
  });
}

async function openPrivateChat(workerId) {
  if (!currentUser || !sessionToken) {
    openAuthModal("login");
    setMessage(
      "#authMessage",
      "Please log in to message a professional."
    );
    return;
  }

  if (currentUser.role !== "client") {
    showToast("Professional accounts can reply to client conversations.");
    navigateToSection("messages");
    return;
  }

  const worker = workers.find(
    item => String(item.id) === String(workerId)
  );

  if (!worker) {
    showToast("This professional could not be found.");
    return;
  }

  if (
    normalizeEmail(worker.email) &&
    normalizeEmail(worker.email) === normalizeEmail(currentUser.email)
  ) {
    showToast("You cannot message your own professional listing.");
    return;
  }

  const conversation = {
    workerId: worker.id,
    workerName: worker.name,
    skill: worker.skill,
    otherName: worker.name,
    conversationId: ""
  };

  await openExistingConversation(conversation);
}

async function openExistingConversation(conversation) {
  activeConversation = {
    ...conversation
  };

  activeGroup = null;

  $("#chatEmpty")?.setAttribute("hidden", "");
  $("#groupChat")?.setAttribute("hidden", "");
  $("#privateChat")?.removeAttribute("hidden");

  const name =
    conversation.otherName ||
    conversation.workerName ||
    "Private conversation";

  const avatar = $("#chatPersonAvatar");
  const title = $("#chatPersonName");
  const skill = $("#chatPersonSkill");

  if (avatar) avatar.textContent = getInitials(name);
  if (title) title.textContent = name;
  if (skill) skill.textContent = conversation.skill || "Private chat";

  navigateToSection("messages");

  await refreshPrivateMessages();
  startChatPolling(refreshPrivateMessages);
}

async function refreshPrivateMessages() {
  if (!activeConversation || !sessionToken) return;

  const list = $("#privateMessages");
  if (!list) return;

  // A new client conversation does not have an ID until
  // the first message is sent.
  if (!activeConversation.conversationId) {
    renderPrivateMessages([]);
    return;
  }

  try {
    const data = await apiGet("messages", {
      token: sessionToken,
      conversationId: activeConversation.conversationId
    });

    renderPrivateMessages(data.messages || []);

  } catch (error) {
    console.error("Private message loading error:", error);

    if (!list.children.length) {
      list.innerHTML =
        `<div class="empty-state">${escapeHTML(error.message)}</div>`;
    }
  }
}

function renderPrivateMessages(messages) {
  const list = $("#privateMessages");
  if (!list) return;

  if (!messages.length) {
    list.innerHTML =
      '<div class="chat-empty-messages">No messages yet. Say hello to start the conversation.</div>';
    return;
  }

  const currentEmail = normalizeEmail(currentUser?.email);

  list.innerHTML = messages.map(message => {
    const mine =
      normalizeEmail(message.senderEmail) === currentEmail;

    return `
      <div class="message-row ${mine ? "message-mine" : "message-theirs"}">
        <div class="message-bubble">
          <p>${escapeHTML(message.message)}</p>
          <time>${escapeHTML(formatDate(message.createdAt))}</time>
        </div>
      </div>
    `;
  }).join("");

  list.scrollTop = list.scrollHeight;
}

async function sendPrivateMessage(event) {
  event.preventDefault();

  if (!currentUser || !activeConversation || !sessionToken) return;

  const input = $("#privateMessageInput");
  const button = $("#privateMessageForm")
    ?.querySelector('[type="submit"]');

  const message = input?.value.trim();

  if (!message) return;

  if (message.length > 2000) {
    showToast("Messages cannot exceed 2,000 characters.");
    return;
  }

  if (button) button.disabled = true;

  try {
    const result = await apiPost(authenticatedPayload({
      action: "sendMessage",
      workerId: activeConversation.workerId,
      conversationId: activeConversation.conversationId || "",
      message
    }));

    if (result.conversationId) {
      activeConversation.conversationId = result.conversationId;
    }

    input.value = "";

    await refreshPrivateMessages();
    await refreshConversationList();

  } catch (error) {
    showToast(error.message || "Unable to send your message.");

  } finally {
    if (button) button.disabled = false;
    input?.focus();
  }
}

async function refreshConversationList() {
  if (!sessionToken) return;

  try {
    const data = await apiGet("conversations", {
      token: sessionToken
    });

    renderConversations(data.conversations || []);

  } catch (error) {
    console.warn("Could not refresh conversations:", error);
  }
}


/* =========================================================
   PROFESSIONAL SKILL GROUPS
========================================================= */

function renderSkillGroups(groups) {
  const list = $("#skillGroupList");
  if (!list) return;

  if (currentUser?.role !== "professional") {
    list.innerHTML =
      '<div class="empty-state">Skill group discussions are available to registered professionals.</div>';
    return;
  }

  if (!groups.length) {
    list.innerHTML =
      '<div class="empty-state">No skill groups are available for your account yet.</div>';
    return;
  }

  list.innerHTML = groups.map(group => `
    <button
      type="button"
      class="skill-group-item"
      data-skill-key="${escapeHTML(group.skillKey)}">

      <span class="group-icon">👥</span>

      <span>
        <strong>${escapeHTML(group.skill || group.skillKey)}</strong>
        <small>Professional community</small>
      </span>

      <span class="group-arrow">›</span>
    </button>
  `).join("");

  list.querySelectorAll("[data-skill-key]").forEach(button => {
    button.addEventListener("click", () => {
      const group = groups.find(
        item => String(item.skillKey) === button.dataset.skillKey
      );

      if (group) openSkillGroup(group);
    });
  });
}

async function openSkillGroup(group) {
  if (!currentUser || currentUser.role !== "professional") {
    showToast("Only registered professionals can join skill groups.");
    return;
  }

  activeGroup = { ...group };
  activeConversation = null;

  $("#chatEmpty")?.setAttribute("hidden", "");
  $("#privateChat")?.setAttribute("hidden", "");
  $("#groupChat")?.removeAttribute("hidden");

  const title = $("#groupChatName");
  const count = $("#groupMemberCount");

  if (title) {
    title.textContent = group.skill || group.skillKey;
  }

  if (count) {
    count.textContent = "Professional community";
  }

  navigateToSection("messages");

  await refreshGroupMessages();
  startChatPolling(refreshGroupMessages);
}

async function refreshGroupMessages() {
  if (!activeGroup || !sessionToken) return;

  try {
    const data = await apiGet("groupMessages", {
      token: sessionToken,
      skillKey: activeGroup.skillKey
    });

    renderGroupMessages(data.messages || []);

  } catch (error) {
    console.error("Group message loading error:", error);

    const list = $("#groupMessages");

    if (list && !list.children.length) {
      list.innerHTML =
        `<div class="empty-state">${escapeHTML(error.message)}</div>`;
    }
  }
}

function renderGroupMessages(messages) {
  const list = $("#groupMessages");
  if (!list) return;

  if (!messages.length) {
    list.innerHTML =
      '<div class="chat-empty-messages">No group messages yet. Start the discussion.</div>';
    return;
  }

  const currentEmail = normalizeEmail(currentUser?.email);

  list.innerHTML = messages.map(message => {
    const mine =
      normalizeEmail(message.senderEmail) === currentEmail;

    return `
      <div class="message-row ${mine ? "message-mine" : "message-theirs"}">
        <div class="message-bubble">
          ${mine ? "" : `<strong>${escapeHTML(message.senderName || "Professional")}</strong>`}
          <p>${escapeHTML(message.message)}</p>
          <time>${escapeHTML(formatDate(message.createdAt))}</time>
        </div>
      </div>
    `;
  }).join("");

  list.scrollTop = list.scrollHeight;
}

async function sendGroupMessage(event) {
  event.preventDefault();

  if (!currentUser || !activeGroup || !sessionToken) return;

  const input = $("#groupMessageInput");
  const button = $("#groupMessageForm")
    ?.querySelector('[type="submit"]');

  const message = input?.value.trim();

  if (!message) return;

  if (message.length > 2000) {
    showToast("Messages cannot exceed 2,000 characters.");
    return;
  }

  if (button) button.disabled = true;

  try {
    await apiPost(authenticatedPayload({
      action: "sendGroupMessage",
      skillKey: activeGroup.skillKey,
      message
    }));

    input.value = "";
    await refreshGroupMessages();

  } catch (error) {
    showToast(error.message || "Unable to send group message.");

  } finally {
    if (button) button.disabled = false;
    input?.focus();
  }
}


/* =========================================================
   LOAD DIRECTORY AND REVIEWS
========================================================= */

async function loadData() {
  try {
    const data = await apiGet("list");

    workers = Array.isArray(data.workers) ? data.workers : [];
    reviews = Array.isArray(data.reviews) ? data.reviews : [];

    updateStats();
    renderWorkers();
    renderReviewWorkerOptions();
    renderReviews();
    renderMarkers();

  } catch (error) {
    console.error("Data loading error:", error);

    const workerList = $("#workerList");
    const reviewList = $("#reviewList");
    const resultsCount = $("#resultsCount");

    if (workerList) {
      workerList.innerHTML =
        `<div class="empty-state">${escapeHTML(error.message)} Check your backend URL and deployment permissions.</div>`;
    }

    if (reviewList) {
      reviewList.innerHTML =
        '<div class="empty-state">Reviews are temporarily unavailable.</div>';
    }

    if (resultsCount) {
      resultsCount.textContent = "Unavailable";
    }
  }
}


/* =========================================================
   SEARCH, FILTERS AND REFRESH
========================================================= */

function initializeDirectoryControls() {
  $("#searchInput")?.addEventListener("input", renderWorkers);
  $("#skillFilter")?.addEventListener("change", renderWorkers);
  $("#sortFilter")?.addEventListener("change", renderWorkers);

  $("#refreshBtn")?.addEventListener("click", async () => {
    await loadData();
    showToast("Community listings refreshed.");
  });
}


/* =========================================================
   SIDEBAR
========================================================= */

function initializeSidebar() {
  const toggle = $("#menuToggle");
  const menu = $("#sideMenu");
  const overlay = $("#sidebarOverlay");
  const close = $("#sidebarClose");

  if (!toggle || !menu || !overlay || !close) return;

  function openSidebar() {
    menu.classList.add("open");
    overlay.classList.add("visible");
    document.body.classList.add("sidebar-open");

    toggle.setAttribute("aria-expanded", "true");
  }

  function closeSidebar() {
    menu.classList.remove("open");
    overlay.classList.remove("visible");
    document.body.classList.remove("sidebar-open");

    toggle.setAttribute("aria-expanded", "false");
  }

  toggle.addEventListener("click", () => {
    menu.classList.contains("open")
      ? closeSidebar()
      : openSidebar();
  });

  close.addEventListener("click", closeSidebar);
  overlay.addEventListener("click", closeSidebar);

  document.querySelectorAll(".sidebar-link").forEach(link => {
    link.addEventListener("click", () => {
      closeSidebar();

      const target = link.getAttribute("href");

      if (target?.startsWith("#")) {
        const id = target.slice(1);

        if (id === "messages" && !currentUser) {
          openAuthModal("login");
          return;
        }

        navigateToSection(id);
      }
    });
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      closeSidebar();
      closeAuthModal();
    }
  });
}


/* =========================================================
   APPLICATION STARTUP
========================================================= */

async function startApp() {
  // Initialize authentication and navigation first.
  // These must work even if the map fails to initialize.

  initializeAuthModal();
  initializeSidebar();
  initializeChat();

  updateAccountUI();

  try {
    initializeTheme();
  } catch (error) {
    console.error("Theme initialization error:", error);
  }

  try {
    initializeMap();
  } catch (error) {
    console.error("Map initialization error:", error);
  }

  try {
    initializeLocationDetection();
    initializeRegistration();
    initializeReviews();
    initializeDirectoryControls();
  } catch (error) {
    console.error("Feature initialization error:", error);
  }

  await loadData();

  const authenticated = await validateExistingSession();

  if (authenticated) {
    await loadChatDashboard();
  }
}


// Wait until the HTML is ready before connecting buttons.

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startApp);
} else {
  startApp();
}
