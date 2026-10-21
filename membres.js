
// ── Présence temps réel ───────────────────────────────────────────────────────
const _IS_SRV = window.location.protocol === "http:";
const _PAPI   = window.location.origin + "/api/presence";
const _DEVICE = localStorage.getItem("_deviceId") || (()=>{
  const id = Math.random().toString(36).slice(2);
  localStorage.setItem("_deviceId", id);
  return id;
})();
const _PAGE   = document.title.split(' ')[0].toLowerCase()
                || window.location.pathname.split('/').pop().replace('.html','').toLowerCase();

function _getUser() {
  try {
    const h = JSON.parse(localStorage.getItem("loginHistory")||"[]");
    const l = h[h.length-1];
    return (l && (l.user||l.nom)) || "Utilisateur";
  } catch(e) { return "Utilisateur"; }
}

const _PAGE_LABELS = {
  tables:"Tables", commande:"Commande", membres:"Membres",
  rapports:"Rapports", stock:"Stock", historique:"Historique",
  articles:"Articles", paiement:"Paiement", parametres:"Paramètres"
};

// Toast de présence (non bloquant, en haut à droite)
function _showPresenceToast(msg) {
  let c = document.getElementById("_presenceToasts");
  if (!c) {
    c = document.createElement("div");
    c.id = "_presenceToasts";
    c.style.cssText = "position:fixed;top:16px;right:16px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;";
    document.body.appendChild(c);
  }
  const t = document.createElement("div");
  t.style.cssText = "background:rgba(30,30,40,0.88);color:#fff;padding:10px 16px;border-radius:50px;font-size:13px;font-weight:600;font-family:sans-serif;display:flex;align-items:center;gap:8px;backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,0.15);animation:_pfadeIn .2s ease;";
  const dot = document.createElement("span");
  dot.style.cssText = "width:7px;height:7px;border-radius:50%;background:#facc15;flex-shrink:0;";
  t.appendChild(dot);
  t.appendChild(document.createTextNode(msg));
  c.appendChild(t);
  setTimeout(()=>{ t.style.opacity="0"; t.style.transition="opacity .3s"; setTimeout(()=>t.remove(),350); }, 4000);
}

// Vérifier qui est actif et avertir si besoin
async function _checkPresence(actionLabel) {
  if (!_IS_SRV) return;
  try {
    // Envoyer son heartbeat
    const res = await fetch(_PAPI, {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({page:_PAGE, deviceId:_DEVICE, user:_getUser()})
    });
    const data = await res.json();
    const presence = data.presence || {};
    const me = _getUser();
    const others = [];
    Object.entries(presence).forEach(([page, users]) => {
      users.forEach(u => {
        if (u.user !== me) {
          others.push(`${u.user} (${_PAGE_LABELS[u.page]||u.page})`);
        }
      });
    });
    if (others.length > 0) {
      _showPresenceToast(`⚠️ ${others.join(", ")} est aussi connecté${others.length>1?"s":""}`);
    }
  } catch(e) {}
}

// Heartbeat silencieux toutes les 15s
if (_IS_SRV) {
  setInterval(()=>{
    fetch(_PAPI,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({page:_PAGE,deviceId:_DEVICE,user:_getUser()})
    }).catch(()=>{});
  }, 15000);
  // Premier heartbeat
  setTimeout(()=>{
    fetch(_PAPI,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({page:_PAGE,deviceId:_DEVICE,user:_getUser()})
    }).catch(()=>{});
  }, 1000);
}
// ─────────────────────────────────────────────────────────────────────────────

// ===================== Variables =====================
// Détection propre : file:// = localStorage only, http:// = serveur
const IS_FILE_MODE = window.location.protocol === "file:";
const SERVER_URL = IS_FILE_MODE ? null : window.location.origin;

// ─── Helper API ───────────────────────────────────────────────────────────────
async function apiPost(route, body) {
    if (!SERVER_URL) return null;
    try {
        const res = await fetch(SERVER_URL + route, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(8000) // Ne jamais rester bloqué indéfiniment
        });
        return await res.json();
    } catch (e) {
        console.warn("Serveur injoignable :", e.message);
        return null;
    }
}

async function syncToServer(...keys) {
    if (!SERVER_URL) return;
    const body = {};
    keys.forEach(key => {
        const val = localStorage.getItem(key);
        if (val !== null) {
            try { body[key] = JSON.parse(val); }
            catch(e) { body[key] = val; }
        }
    });
    try {
        const res = await fetch(SERVER_URL + "/api/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (data.ok) showToast("Synchronisé avec le serveur ✓");
    } catch(e) {
        console.warn("Sync serveur échouée :", e.message);
        showToast("Sync échouée (serveur hors ligne)", "error");
    }
}

// ===================== Lecture carte d'identité (eID) =====================
// Le navigateur ne peut pas parler directement à un lecteur de carte : on passe
// par un petit serveur local (eid_bridge.py, fourni à côté) qui pilote le
// lecteur via pyscard et renvoie les infos en JSON.
// Change ce port si tu fais tourner le pont eID ailleurs.
const EID_BRIDGE_URL = (window.EID_BRIDGE_URL) || "http://localhost:8765";
let _formVientDunScan = false; // true tant que le formulaire courant a été rempli via la carte d'identité

function _setEidStatus(mode, text) {
    const el = document.getElementById("eidStatus");
    if (!el) return;
    el.className = mode || "";
    el.textContent = text;
}

// Petit ping au chargement pour savoir si le pont eID tourne (facultatif,
// n'empêche jamais de remplir le formulaire à la main si c'est hors ligne)
async function _pingEidBridge() {
    try {
        const res = await fetch(EID_BRIDGE_URL + "/api/eid/status", { signal: AbortSignal.timeout(2000) });
        const data = await res.json();
        if (data && data.readerPresent) {
            _setEidStatus("ok", "✓ lecteur détecté");
        } else {
            _setEidStatus("", "⏳ pas de lecteur branché");
        }
    } catch (e) {
        _setEidStatus("", "⏳ pont eID hors ligne");
    }
}
// Le pont eID est un serveur à part, indépendant de SERVER_URL : on teste toujours.
setTimeout(_pingEidBridge, 800);

async function scannerCarteIdentite() {
    const btn = document.getElementById("btnScanId");
    const icon = document.getElementById("scanIdIcon");
    const label = document.getElementById("scanIdLabel");
    btn.disabled = true;
    icon.className = "fas fa-spinner fa-spin";
    label.textContent = "Lecture en cours…";
    _setEidStatus("busy", "📇 insère/laisse la carte sur le lecteur…");
    showToast("Lecture de la carte d'identité en cours…", "info");

    try {
        const res = await fetch(EID_BRIDGE_URL + "/api/eid/read", { signal: AbortSignal.timeout(20000) });
        const data = await res.json();

        if (!data || !data.ok) {
            const msg = (data && data.error) || "Lecture impossible";
            _setEidStatus("err", "✗ " + msg);
            showToast("Carte d'identité : " + msg + " — remplis le formulaire à la main", "error");
            return;
        }

        // On ne remplace que ce que la carte a fourni ; le formulaire reste
        // modifiable et rien n'est obligatoire.
        const setIf = (id, val) => {
            if (val) document.getElementById(id).value = val;
        };
        setIf("prenom", data.prenom);
        setIf("nom", data.nom);
        setIf("adresse", data.adresse);
        setIf("localite", data.localite);

        // Déclenche l'événement input pour que le libellé du bouton "Ajouter/Modifier" se mette à jour
        document.getElementById("prenom").dispatchEvent(new Event("input", { bubbles: true }));

        _formVientDunScan = true;
        _setEidStatus("ok", "✓ carte lue");
        showToast("Infos de la carte récupérées — vérifie et complète si besoin ✓");
    } catch (e) {
        const offline = e.name === "TimeoutError" || e.name === "AbortError";
        const msg = offline ? "pont eID injoignable (lance eid_bridge.py)" : "erreur de lecture";
        _setEidStatus("err", "✗ " + msg);
        showToast("Carte d'identité : " + msg, "error");
    } finally {
        btn.disabled = false;
        icon.className = "fas fa-id-card";
        label.textContent = "Scanner la carte d'identité";
    }
}

async function loadMembresFromServer() {
    if (!SERVER_URL) { updateServerStatusBadge(false); return; }
    try {
        const res = await fetch(SERVER_URL + "/api/membres?t=" + Date.now(), {
            signal: AbortSignal.timeout(5000) // Ne jamais rester bloqué plus de 5s
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        if (Array.isArray(data)) {
            membres = data;
            localStorage.setItem("membres", JSON.stringify(membres));
            const maxId = Math.max(...membres.map(m => parseInt(m.id) || 0), 0);
            localStorage.setItem("lastMembreId", maxId);
            updateServerStatusBadge(true);
        }
    } catch (e) {
        console.warn("Impossible de charger les membres :", e.message);
        updateServerStatusBadge(false);
    }
}

function updateServerStatusBadge(ok) {
    const badge = document.getElementById("serverStatusBadge");
    if (!badge) return;
    if (IS_FILE_MODE) {
        badge.textContent = "📁 Mode local";
        badge.style.cssText += ";background:#fef9c3;color:#854d0e;border:1px solid #fde047;";
        return;
    }
    if (ok) {
        badge.textContent = "🟢 Serveur connecté";
        badge.style.cssText += ";background:#d1fae5;color:#065f46;border:1px solid #6ee7b7;";
    } else {
        badge.textContent = "🔴 Serveur hors ligne";
        badge.style.cssText += ";background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;";
    }
}

async function refreshMembres() {
    const btn = document.getElementById("refreshBtn");
    if (btn) { btn.textContent = "⏳ Chargement..."; btn.disabled = true; }
    await loadMembresFromServer();
    migrerAccesMembres();
    renderTable();
    if (btn) { btn.textContent = "🔄 Actualiser"; btn.disabled = false; }
    showToast(SERVER_URL ? "Liste mise à jour !" : "Mode local — localStorage");
}

// Auto-refresh toutes les 15 secondes (mode serveur uniquement)
if (!IS_FILE_MODE) {
    setInterval(async function() {
        await loadMembresFromServer();
        renderTable();
    }, 15000);
}

let membres = JSON.parse(localStorage.getItem("membres")) || [];

// ============================================================
// EXCEL — EXPORT / IMPORT / SAUVEGARDE AUTO (membres)
// Utilise le même serveur que la page (port 8000)
// ============================================================
const EXCEL_SERVER = window.location.origin;
let _excelServeurOk = null;
let _excelTimer = null;

async function _pingExcelServeur() {
  if (_excelServeurOk !== null) return _excelServeurOk;
  try {
    const r = await fetch(`${EXCEL_SERVER}/api/export-excel-membres`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ membres: [] }), signal: AbortSignal.timeout(2000)
    });
    _excelServeurOk = true;
  } catch(e) { _excelServeurOk = false; }
  return _excelServeurOk;
}

// Appelée après chaque vraie modification (add/edit/delete/import)
// PAS lors du refresh auto toutes les 15s
function declencherSauvegardeAutoMembres() {
  clearTimeout(_excelTimer);
  _excelTimer = setTimeout(async () => {
    try {
      const membres = JSON.parse(localStorage.getItem('membres') || '[]');
      if (!membres.length) return;
      const res = await fetch(`${EXCEL_SERVER}/api/export-excel-membres?auto=1`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ membres }), signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        _excelServeurOk = true;
        console.log(`💾 [AUTO] ${membres.length} membre(s) sauvegardés en Excel`);
      }
    } catch(e) {
      _excelServeurOk = false;
      console.warn('⚠️ [AUTO] Sauvegarde membres Excel échouée :', e.message);
    }
  }, 5000);
}

window.exportExcelMembres = async function() {
  const membres = JSON.parse(localStorage.getItem('membres') || '[]');
  if (!membres.length) { alert('Aucun membre à exporter.'); return; }
  if (!(await _pingExcelServeur())) {
    return alert("⚠️ Le serveur Excel n'est pas disponible.\nLance node server.js puis réessaie.");
  }
  try {
    const res = await fetch(`${EXCEL_SERVER}/api/export-excel-membres`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ membres })
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Membres_${new Date().toLocaleDateString('fr-BE').replace(/\//g,'-')}.xlsx`;
    a.click();
    alert(`✅ ${membres.length} membre(s) exporté(s).\n📁 Copie dans "sauvegarde données" sur le serveur.`);
  } catch(err) { alert(`❌ Erreur export Excel : ${err.message}`); }
};

window.importExcelMembres = async function(file) {
  if (!file) return;
  if (!(await _pingExcelServeur())) {
    return alert("⚠️ Le serveur Excel n'est pas disponible.\nLance node server.js puis réessaie.");
  }
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch(`${EXCEL_SERVER}/api/import-excel-membres`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    const data = await res.json();
    const fusionner = confirm(`${data.count} membre(s) trouvé(s).\n\nOK = Fusionner\nAnnuler = Remplacer tout`);
    let membres = JSON.parse(localStorage.getItem('membres') || '[]');
    if (fusionner) {
      const existingIds = new Set(membres.map(m => m.id?.toString()));
      const nouveaux = data.membres.filter(m => !existingIds.has(m.id?.toString()));
      membres = [...membres, ...nouveaux];
      alert(`✅ ${nouveaux.length} nouveau(x) membre(s) ajouté(s).`);
    } else {
      membres = data.membres;
      alert(`✅ ${data.count} membre(s) importé(s) (remplacement complet).`);
    }
    localStorage.setItem('membres', JSON.stringify(membres));
    const maxId = Math.max(...membres.map(m => parseInt(m.id)||0), 0);
    localStorage.setItem('lastMembreId', maxId);
    // Déclencher la sauvegarde auto après import
    declencherSauvegardeAutoMembres();
    location.reload();
  } catch(err) { alert(`❌ Erreur import Excel : ${err.message}`); }
};

// Sauvegarde auto au premier chargement (si données présentes)
// Sauvegarde auto au chargement — non bloquante
try { if (localStorage.getItem('membres')) declencherSauvegardeAutoMembres(); } catch(e) {}

// Charge le logo : d'abord l'override membres, sinon le logo de paramètres
function getLogoBase64() {
    const override = localStorage.getItem("membresLogoOverride");
    if (override) return override;
    const settings = JSON.parse(localStorage.getItem("companySettings") || "{}");
    return settings.companyLogo || null;
}
let logoBase64 = getLogoBase64();
let currentPage = 1;
let itemsPerPage = 10;

const form = document.getElementById("membreForm");
const tableBody = document.querySelector("#membresTable tbody");

// ===================== Liste (vue permanente) =====================
// Le formulaire vit désormais dans une modale (voir openMembreModal /
// closeMembreModal) : la liste, elle, reste toujours affichée. Cette
// fonction est conservée (et son argument ignoré) pour ne pas casser les
// appels existants (import CSV/JSON, showListeAvecRefresh...).
function showTab(tab) {
    const showMap = { tableContainer: "block", panelsGrid: "flex", paginationControls: "flex" };
    Object.entries(showMap).forEach(function(entry) {
        const el = document.getElementById(entry[0]);
        if (el) { el.classList.remove("hidden"); el.style.display = entry[1]; }
    });
    renderTable();
}

// ===================== Modale Ajouter/Modifier un membre =====================
function showMembreModal() {
    const modal = document.getElementById("membreModal");
    modal.classList.remove("hidden");
    modal.style.display = "flex";
}
window.showMembreModal = showMembreModal;

function closeMembreModal() {
    const modal = document.getElementById("membreModal");
    modal.style.display = "none";
    modal.classList.add("hidden");
}
window.closeMembreModal = closeMembreModal;

function openMembreModal() {
    resetForm(false);
    document.getElementById("membreModalTitle").textContent = "Ajouter un Membre";
    showMembreModal();
}
window.openMembreModal = openMembreModal;

// Comme goBack() (qui recharge toute la page et donc les données serveur),
// on va chercher les membres à jour avant d'afficher la liste. Séparée de
// showTab() pour ne pas perturber l'import CSV/JSON qui appelle showTab("liste")
// juste après un import (avant que la sync serveur ne soit terminée).
async function showListeAvecRefresh() {
    await loadMembresFromServer();
    showTab("liste");
}

// ===================== Retour / Reset formulaire =====================
function goBack() {
    window.history.back();
}

function resetForm(avecToast = true) {
    form.reset();
    document.getElementById("membreId").value = "";
    document.getElementById("submit-text").textContent = "Ajouter le Membre";
    document.getElementById("membreModalTitle").textContent = "Ajouter un Membre";
    _formVientDunScan = false;
    stepMembreForm(1);
    if (avecToast) showToast("Formulaire réinitialisé", "info");
}

// ===================== Formulaire en 3 étapes =====================
let currentMembreStep = 1;

function stepMembreForm(n) {
    currentMembreStep = n;

    document.querySelectorAll(".form-step").forEach(el => {
        el.classList.toggle("active", parseInt(el.dataset.step, 10) === n);
    });

    document.querySelectorAll(".step-dot").forEach(dot => {
        const num = parseInt(dot.dataset.stepDot, 10);
        dot.classList.toggle("active", num === n);
        dot.classList.toggle("done", num < n);
    });

    if (n === 3) buildRecapMembre();

    const modalBody = document.querySelector("#membreModal .modal-body");
    if (modalBody) modalBody.scrollTo({ top: 0, behavior: "smooth" });
}
window.stepMembreForm = stepMembreForm;

// Empêche la touche Entrée de valider le formulaire tant qu'on n'est pas
// à l'étape du récapitulatif : elle passe simplement à l'étape suivante.
form.addEventListener("keydown", function(e) {
    if (e.key !== "Enter") return;
    if (e.target.tagName === "TEXTAREA") return;
    if (currentMembreStep < 3) {
        e.preventDefault();
        stepMembreForm(currentMembreStep + 1);
    }
});

function buildRecapMembre() {
    const val = id => document.getElementById(id).value.trim();
    const anonPreview = v => v || "anonyme";

    let prenom = val("prenom");
    let nom = val("nom");
    if (!prenom && !nom) { prenom = "Anonyme"; nom = ""; }

    const champs = [
        { label: "Prénom",    value: prenom || "Anonyme" },
        { label: "Nom",       value: nom || "—" },
        { label: "Adresse",   value: anonPreview(val("adresse")) },
        { label: "Localité",  value: anonPreview(val("localite")) },
        { label: "Email",     value: anonPreview(val("email")) },
        { label: "Téléphone", value: anonPreview(val("telephone")) },
        { label: "Statut",    value: document.getElementById("statut").selectedOptions[0].textContent.trim() }
    ];

    const box = document.getElementById("recapBox");
    box.innerHTML = champs.map(c => `
        <div class="recap-item">
            <span class="recap-item-label">${c.label}</span>
            <span class="recap-item-value${c.value === 'anonyme' ? ' is-anonyme' : ''}">${c.value}</span>
        </div>
    `).join("");
}

// ===================== Toast =====================
function showToast(message, type = "success") {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add("show"), 100);
    setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 400);
    }, 3000);
}

// ===================== ID Auto-incrément =====================
function generateId() {
    let lastId = parseInt(localStorage.getItem("lastMembreId") || "0");
    lastId++;
    localStorage.setItem("lastMembreId", lastId);
    return lastId.toString();
}

// ===================== Accès Espace Membre (code / pseudo / mot de passe) =====================
// Charset sans caractères ambigus (pas de 0/O, 1/I/L)
const SAFE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomSafeString(length) {
    let s = '';
    for (let i = 0; i < length; i++) {
        s += SAFE_CHARS.charAt(Math.floor(Math.random() * SAFE_CHARS.length));
    }
    return s;
}

// Mot de passe court (6 caractères) et simple à retaper
function genererMotDePasse() {
    return randomSafeString(6);
}

// Code d'accès unique (référence membre), format CLB-XXXXX
function genererCodeAcces() {
    let code;
    do {
        code = 'CLB-' + randomSafeString(5);
    } while (membres.some(m => m.codeAcces === code));
    return code;
}

function slugifyPseudo(str) {
    return (str || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

// Pseudo unique = identifiant de connexion à l'Espace Membre (ex: jdupont)
function genererPseudo(prenom, nom) {
    const base = (slugifyPseudo(prenom).charAt(0) + slugifyPseudo(nom)) || 'membre';
    let pseudo = base;
    let n = 1;
    while (membres.some(m => m.pseudo === pseudo)) {
        n++;
        pseudo = base + n;
    }
    return pseudo;
}

// Complète un membre existant qui n'aurait pas encore d'accès (migration douce)
function migrerAccesMembres() {
    let changed = false;
    membres.forEach(m => {
        if (!m.codeAcces)  { m.codeAcces  = genererCodeAcces();               changed = true; }
        if (!m.pseudo)     { m.pseudo     = genererPseudo(m.prenom, m.nom);   changed = true; }
        if (!m.motDePasse) { m.motDePasse = genererMotDePasse();              changed = true; }
    });
    if (changed) {
        localStorage.setItem("membres", JSON.stringify(membres));
        declencherSauvegardeAutoMembres();
    }
}

async function persisterMembreApresRegeneration(m) {
    membres = membres.map(x => x.id === m.id ? m : x);
    localStorage.setItem("membres", JSON.stringify(membres));
    declencherSauvegardeAutoMembres();
    await apiPost("/api/membre", m);
    renderTable();
}

async function regenererPseudo(id) {
    const m = membres.find(x => x.id === id);
    if (!m) return;
    m.pseudo = genererPseudo(m.prenom, m.nom);
    await persisterMembreApresRegeneration(m);
    showToast("Pseudo régénéré ✓");
    openCredentialsModal(id);
}

async function regenererMotDePasse(id) {
    const m = membres.find(x => x.id === id);
    if (!m) return;
    m.motDePasse = genererMotDePasse();
    await persisterMembreApresRegeneration(m);
    showToast("Mot de passe régénéré ✓");
    openCredentialsModal(id);
}

async function regenererCodeAcces(id) {
    const m = membres.find(x => x.id === id);
    if (!m) return;
    m.codeAcces = genererCodeAcces();
    await persisterMembreApresRegeneration(m);
    showToast("Code d'accès régénéré ✓");
    openCredentialsModal(id);
}

function copierAcces(text, label) {
    if (!text) return;
    navigator.clipboard.writeText(text)
        .then(() => showToast((label || "Copié") + " ✓"))
        .catch(() => showToast("Impossible de copier", "error"));
}

// ===================== Modale Accès Espace Membre =====================
function openCredentialsModal(id) {
    const m = membres.find(x => x.id === id);
    if (!m) return showToast("Membre introuvable", "error");
    document.getElementById("credModalNom").textContent = `${m.prenom} ${m.nom}`;
    document.getElementById("credCode").textContent = m.codeAcces || '—';
    document.getElementById("credPseudo").textContent = m.pseudo || '—';
    document.getElementById("credPass").textContent = m.motDePasse || '—';
    const modal = document.getElementById("credModal");
    modal.dataset.membreId = id;
    modal.classList.remove("hidden");
    modal.style.display = "flex";
}

function closeCredModal() {
    const modal = document.getElementById("credModal");
    modal.style.display = "none";
    modal.classList.add("hidden");
}

function credCurrentId() {
    return document.getElementById("credModal").dataset.membreId;
}

// ===================== Ajouter / Modifier =====================
form.addEventListener("submit", async function(e) {
    e.preventDefault();   // TOUJOURS en premier, avant tout await (sinon le navigateur recharge la page)
    await _checkPresence("enregistrer membre");
    const idInput = document.getElementById("membreId").value;
    const anon = v => v.trim() || "anonyme";
    let prenomVal = document.getElementById("prenom").value.trim();
    let nomVal = document.getElementById("nom").value.trim();
    // Formulaire laissé (totalement) vide -> membre anonyme, jamais bloqué
    if (!prenomVal && !nomVal) { prenomVal = "Anonyme"; }
    const membre = {
        id: idInput || generateId(),
        prenom: prenomVal,
        nom: nomVal,
        adresse:   anon(document.getElementById("adresse").value),
        localite:  anon(document.getElementById("localite").value),
        email:     anon(document.getElementById("email").value),
        telephone: anon(document.getElementById("telephone").value),
        statut: document.getElementById("statut").value,
        dateAdhesion: idInput ? membres.find(m => m.id === idInput).dateAdhesion : new Date().toLocaleDateString()
    };
    // Accès Espace Membre : générés à la création, conservés en modification
    const membreExistant = idInput ? membres.find(m => m.id === idInput) : null;
    membre.codeAcces  = (membreExistant && membreExistant.codeAcces)  || genererCodeAcces();
    membre.pseudo     = (membreExistant && membreExistant.pseudo)     || genererPseudo(membre.prenom, membre.nom);
    membre.motDePasse = (membreExistant && membreExistant.motDePasse) || genererMotDePasse();
    // Badge "scanné via carte d'identité" : posé si ce formulaire vient d'un scan,
    // sinon conservé s'il l'était déjà (une modification manuelle ne l'enlève pas)
    membre.viaEid = _formVientDunScan || (membreExistant && membreExistant.viaEid) || false;
    _formVientDunScan = false;
    if (idInput) {
        membres = membres.map(m => m.id === idInput ? membre : m);
        showToast("Membre modifié !");
    } else {
        membres.push(membre);
        showToast("Membre ajouté !");
    }
    localStorage.setItem("membres", JSON.stringify(membres));
    declencherSauvegardeAutoMembres();

    // ── Sync serveur ──────────────────────────────────────────────────────────
    const result = await apiPost("/api/membre", membre);
    if (result && result.membre) {
        // Le serveur peut avoir réattribué un ID (si nouveau membre)
        if (!idInput && result.membre.id !== membre.id) {
            membres = membres.map(m => m === membre ? result.membre : m);
            localStorage.setItem("membres", JSON.stringify(membres));
        }
        showToast(idInput ? "Modifié + sauvegardé sur le serveur ✓" : "Ajouté + sauvegardé sur le serveur ✓");
    } else if (result === null) {
        showToast("Sauvegardé en local uniquement (serveur hors ligne)", "error");
    }
    // ─────────────────────────────────────────────────────────────────────────

    form.reset();
    document.getElementById("membreId").value = "";
    stepMembreForm(1);
    closeMembreModal();
    // La sauvegarde serveur (apiPost) est terminée à ce stade : on recharge la
    // liste à jour depuis le serveur (comme le fait le bouton Retour via le
    // rechargement de page) pour refléter aussi les modifs faites par d'autres postes.
    await loadMembresFromServer();
    // Nouveau membre : on saute à la dernière page pour qu'il soit visible tout de suite
    if (!idInput) {
        currentPage = Math.ceil(membres.length / itemsPerPage) || 1;
    }
    renderTable();
});

// ===================== Supprimer =====================
function deleteMembre(id) {
    if (confirm("Supprimer ce membre ?")) {
        membres = membres.filter(m => m.id !== id);
        localStorage.setItem("membres", JSON.stringify(membres));
        declencherSauvegardeAutoMembres();
        apiPost("/api/membre/delete", { id });
        renderTable();
        showToast("Membre supprimé", "error");
    }
}

// ===================== Modifier =====================
function editMembre(id) {
    const m = membres.find(m => m.id === id);
    if (!m) return;
    document.getElementById("membreId").value = m.id;
    document.getElementById("prenom").value = m.prenom;
    document.getElementById("nom").value = m.nom;
    document.getElementById("adresse").value = m.adresse;
    document.getElementById("localite").value = m.localite;
    document.getElementById("email").value = m.email;
    document.getElementById("telephone").value = m.telephone;
    document.getElementById("statut").value = m.statut;
    document.getElementById("submit-text").textContent = "Modifier le Membre";
    document.getElementById("membreModalTitle").textContent = "Modifier un Membre";
    stepMembreForm(1);
    showMembreModal();
}

// ===================== Envoyer la carte =====================
function sendMemberCard(id) {
    const membre = membres.find(m => m.id === id);
    if (!membre) return showToast("Membre introuvable", "error");
    
    // Vérifier si l'email est valide
    if (!membre.email || membre.email === "anonyme") {
        showToast("Ce membre n'a pas d'adresse email valide", "error");
        return;
    }
    
    // Sauvegarder l'ID du membre à envoyer dans localStorage
    localStorage.setItem("carteAEnvoyer", JSON.stringify({
        id: membre.id,
        email: membre.email,
        prenom: membre.prenom,
        nom: membre.nom
    }));
    
    // Rediriger vers la page d'envoi des cartes
    window.location.href = "envoi_cartes.html";
}

// ===================== Recherche =====================
let searchTerm = "";

function normaliserTexte(s) {
    return String(s == null ? "" : s)
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().trim();
}

function getFilteredMembres() {
    const mots = normaliserTexte(searchTerm).split(/\s+/).filter(Boolean);
    if (!mots.length) return membres;
    return membres.filter(m => {
        const texte = normaliserTexte(`${m.id || ""} ${m.prenom || ""} ${m.nom || ""} ${m.nom || ""} ${m.prenom || ""}`);
        return mots.every(mot => texte.includes(mot));
    });
}

function onSearchInput(value) {
    searchTerm = value;
    currentPage = 1;
    const clear = document.getElementById("searchClear");
    if (clear) clear.classList.toggle("hidden", !value);
    renderTable();
}

function clearSearch() {
    const input = document.getElementById("searchMembres");
    if (input) { input.value = ""; input.focus(); }
    onSearchInput("");
}

// ===================== Pagination =====================
function renderPagination() {
    const filtres = getFilteredMembres();
    const totalPages = Math.ceil(filtres.length / itemsPerPage) || 1;
    const paginationDiv = document.getElementById("paginationInfo");
    const pageButtons = document.getElementById("pageButtons");
    
    paginationDiv.textContent = searchTerm.trim()
        ? `Page ${currentPage} sur ${totalPages} (${filtres.length} résultat${filtres.length > 1 ? 's' : ''} sur ${membres.length} membres)`
        : `Page ${currentPage} sur ${totalPages} (${membres.length} membres)`;
    
    pageButtons.innerHTML = "";
    
    // Bouton Précédent
    const prevBtn = document.createElement("button");
    prevBtn.textContent = "◀ Précédent";
    prevBtn.disabled = currentPage === 1;
    prevBtn.onclick = () => {
        if (currentPage > 1) {
            currentPage--;
            renderTable();
        }
    };
    pageButtons.appendChild(prevBtn);
    
    // Boutons de pages
    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) {
            const pageBtn = document.createElement("button");
            pageBtn.textContent = i;
            pageBtn.className = i === currentPage ? "active-page" : "";
            pageBtn.onclick = () => {
                currentPage = i;
                renderTable();
            };
            pageButtons.appendChild(pageBtn);
        } else if (i === currentPage - 3 || i === currentPage + 3) {
            const dots = document.createElement("span");
            dots.textContent = "...";
            dots.style.padding = "0 5px";
            pageButtons.appendChild(dots);
        }
    }
    
    // Bouton Suivant
    const nextBtn = document.createElement("button");
    nextBtn.textContent = "Suivant ▶";
    nextBtn.disabled = currentPage === totalPages;
    nextBtn.onclick = () => {
        if (currentPage < totalPages) {
            currentPage++;
            renderTable();
        }
    };
    pageButtons.appendChild(nextBtn);
}

// ===================== Affichage tableau =====================
function renderTable() {
    tableBody.innerHTML = "";
    
    const filtres = getFilteredMembres();
    const totalPagesRT = Math.ceil(filtres.length / itemsPerPage) || 1;
    if (currentPage > totalPagesRT) currentPage = totalPagesRT;
    if (currentPage < 1) currentPage = 1;
    
    if (filtres.length === 0) {
        const msg = membres.length === 0
            ? 'Aucun membre à afficher'
            : 'Aucun membre ne correspond à « ' + searchTerm.replace(/[<>&]/g, '') + ' »';
        tableBody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:20px;">' + msg + '</td></tr>';
        updateTableInfo();
        renderPagination();
        return;
    }
    
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const membresPage = filtres.slice(startIndex, endIndex);
    
    membresPage.forEach(m => {
        // Déterminer l'icône du statut
        let statutIcon = 'fa-user';
        let statutClass = '';
        
        switch(m.statut) {
            case 'benevole':
                statutIcon = 'fa-hands-helping';
                statutClass = 'statut-benevole';
                break;
            case 'admin':
                statutIcon = 'fa-user-shield';
                statutClass = 'statut-admin';
                break;
            case 'inactif':
                statutIcon = 'fa-user-slash';
                statutClass = 'statut-inactif';
                break;
        }
        
        const row = `<tr>
            <td><span class="badge-id">${m.id || ''}</span></td>
            <td>${m.prenom || ''}${m.viaEid ? ' <span class="badge-eid" title="Encodé via scan de la carte d\'identité"><i class="fas fa-id-card"></i></span>' : ''}</td>
            <td><strong>${m.nom || ''}</strong></td>
            <td>${m.adresse || '<span class="empty-field">Non renseigné</span>'}</td>
            <td>${m.localite || '<span class="empty-field">-</span>'}</td>
            <td>${m.email || '<span class="empty-field">-</span>'}</td>
            <td>${m.telephone || '<span class="empty-field">-</span>'}</td>
            <td><span class="statut ${statutClass}"><i class="fas ${statutIcon}"></i> ${m.statut || ''}</span></td>
            <td>${m.dateAdhesion || ''}</td>
            <td class="actions-cell">
                <button class="btn-action btn-edit" onclick="editMembre('${m.id}')" title="Modifier">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="btn-action btn-delete" onclick="deleteMembre('${m.id}')" title="Supprimer">
                    <i class="fas fa-trash"></i>
                </button>
                <button class="btn-action btn-card" onclick="generateCard('${m.id}')" title="Générer carte PDF">
                    <i class="fas fa-id-card"></i>
                </button>
                <button class="btn-action btn-send-card" onclick="sendMemberCard('${m.id}')" title="Envoyer la carte par email">
                    <i class="fas fa-paper-plane"></i>
                </button>
                <button class="btn-action btn-email" onclick="openEmailModal('${m.id}')" title="Envoyer email simple">
                    <i class="fas fa-envelope"></i>
                </button>
                <button class="btn-action btn-tickets" onclick="openTicketsModal('${m.id}')" title="Voir les tickets">
                    <i class="fas fa-receipt"></i>
                </button>
                <button class="btn-action btn-key" onclick="openCredentialsModal('${m.id}')" title="Accès Espace Membre (pseudo / mot de passe)">
                    <i class="fas fa-key"></i>
                </button>
            </td>
        </tr>`;
        tableBody.innerHTML += row;
    });
    
    updateTableInfo();
    renderPagination();
}

// ===================== CSV / JSON =====================
function exportCSV() {
    const csv = [["ID","Prénom","Nom","Adresse","Localité","Email","Téléphone","Statut","Date adhésion"],
        ...membres.map(m => [m.id,m.prenom,m.nom,m.adresse,m.localite,m.email,m.telephone,m.statut,m.dateAdhesion])
    ].map(e => e.join(",")).join("\n");
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "membres.csv";
    a.click();
}

// Export léger : Nom, Prénom, Pseudo, Code d'accès (pour donner les accès Espace Membre)
window.exportCredentialsCSV = function() {
    if (!membres.length) { alert("Aucun membre à exporter."); return; }
    const rows = [
        ["Prénom", "Nom", "Pseudo", "Code d'accès"],
        ...membres.map(m => [m.prenom || '', m.nom || '', m.pseudo || '', m.codeAcces || ''])
    ];
    const csv = "\ufeff" + rows.map(r =>
        r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(";")
    ).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Codes_Pseudos_${new Date().toLocaleDateString('fr-BE').replace(/\//g,'-')}.csv`;
    a.click();
    if (typeof showToast === "function") {
        showToast(`${membres.length} membre(s) exporté(s)`, "success");
    }
};

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim());
    
    return result;
}

function importCSV(file) {
    if (!file) {
        showToast("Aucun fichier sélectionné", "error");
        return;
    }
    
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const text = e.target.result;
            const lines = text.split(/\r?\n/).filter(l => l.trim() !== "");
            
            if (lines.length < 2) {
                showToast("Le fichier CSV est vide ou invalide", "error");
                return;
            }
            
            // Ignorer la première ligne (en-têtes)
            const dataLines = lines.slice(1);
            
            membres = dataLines.map(line => {
                const parts = parseCSVLine(line);
                return {
                    id: parts[0] || generateId(),
                    prenom: parts[1] || '',
                    nom: parts[2] || '',
                    adresse: parts[3] || '',
                    localite: parts[4] || '',
                    email: parts[5] || '',
                    telephone: parts[6] || '',
                    statut: parts[7] || 'inactif',
                    dateAdhesion: parts[8] || new Date().toLocaleDateString()
                };
            });
            
            console.log("Membres importés:", membres);
            
            localStorage.setItem("membres", JSON.stringify(membres));
            const maxId = membres.length ? Math.max(...membres.map(m => parseInt(m.id) || 0)) : 0;
            localStorage.setItem("lastMembreId", maxId);
            currentPage = 1;
            syncToServer("membres", "lastMembreId");
            
            // La liste est déjà la vue permanente : on rafraîchit juste son affichage
            showTab("liste");
            
            showToast(`${membres.length} membre(s) importé(s) ! (sync serveur en cours...)`);
            
        } catch (error) {
            console.error("Erreur import CSV:", error);
            showToast("Erreur lors de l'import CSV: " + error.message, "error");
        }
    };
    reader.readAsText(file);
}

function exportJSON() {
    const blob = new Blob([JSON.stringify(membres,null,2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "membres.json";
    a.click();
}

function importJSON(file) {
    if (!file) {
        showToast("Aucun fichier sélectionné", "error");
        return;
    }
    
    const reader = new FileReader();
    reader.onload = e => {
        try {
            membres = JSON.parse(e.target.result);
            
            console.log("Membres importés:", membres);
            
            localStorage.setItem("membres", JSON.stringify(membres));
            const maxId = membres.length ? Math.max(...membres.map(m => parseInt(m.id) || 0)) : 0;
            localStorage.setItem("lastMembreId", maxId);
            currentPage = 1;
            syncToServer("membres", "lastMembreId");
            
            // La liste est déjà la vue permanente : on rafraîchit juste son affichage
            showTab("liste");
            
            showToast(`${membres.length} membre(s) importé(s) ! (sync serveur en cours...)`);
            
        } catch (error) {
            console.error("Erreur import JSON:", error);
            showToast("Erreur lors de l'import JSON: " + error.message, "error");
        }
    };
    reader.readAsText(file);
}

// ===================== Logo =====================
document.getElementById("logoFile").addEventListener("change", function(e){
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = function(event){
        logoBase64 = event.target.result;
        localStorage.setItem("membresLogoOverride", logoBase64);
        showToast("Logo importé !");
    };
    reader.readAsDataURL(file);
});

// ===================== PDF Cartes =====================
function buildCardDoc(membre, logo) {
    const W = 350, H = 230;   // hauteur augmentée pour le bandeau droits réservés

    // ── Nom entreprise depuis Paramètres ───────────────────────────────────
    const settings    = JSON.parse(localStorage.getItem('companySettings') || '{}');
    const companyName = String(settings.companyName || '').trim() || 'Notre Organisation';

    // ── Palette Vista "thon clair" ──────────────────────────────────────────
    // Fond principal : beige crème nacré, très lumineux
    const BG_CARD    = '#f5f0ea';   // crème chaud (thon clair)
    const BG_HEADER  = '#ede5f7';   // lavande très pâle pour la zone du haut
    const STRIP_TOP  = '#d6c8f0';   // bande supérieure — lilas doux

    // Accents dégradé bleu→violet (Vista glass)
    const BLUE_VIS   = '#4a90d9';   // bleu Vista classique
    const VIOLET_VIS = '#7c4dcc';   // violet Vista
    const BLUE_LT    = '#aac8f0';   // bleu très clair pour reflets
    const VIOLET_LT  = '#c4a8e8';   // violet clair

    // Texte
    const TXT_DARK   = '#2d2250';   // quasi-noir bleuté
    const TXT_MID    = '#5a4a8a';   // violet foncé pour labels
    const TXT_ACCENT = '#3b6bc8';   // bleu royal pour valeurs
    const TXT_SUB    = '#8a7aaa';   // gris-violet pour textes secondaires

    // Séparateur / bordure
    const BORDER_CLR = '#b8a8d8';   // lilas doux
    const SHINE      = '#ffffff';   // blanc pur pour reflet glass

    // ── Cube plat 2D dégradé bleu→violet (coin bas droit) ──────────────────
    // Simple carré arrondi avec 2 rectangles superposés pour simuler le dégradé
    const cbx = 294, cby = 148, cs = 34, cr = 6; // position, taille, rayon

    return {
        pageSize: { width: W, height: H },
        pageMargins: [0, 0, 0, 0],
        content: [
            // ── FOND PRINCIPAL ───────────────────────────────────────────────
            {
                canvas: [
                    // Fond crème nacré global
                    { type: 'rect', x: 0, y: 0, w: W, h: H, color: BG_CARD },

                    // Zone header lavande pâle (haut de carte)
                    { type: 'rect', x: 0, y: 0, w: W, h: 22, color: STRIP_TOP },

                    // Bande de reflet "glass Vista" sur le header — effet nacré
                    { type: 'rect', x: 0, y: 0, w: W, h: 11, color: SHINE, fillOpacity: 0.35 },

                    // Zone corps légèrement plus chaude
                    { type: 'rect', x: 0, y: 22, w: W, h: H - 22, color: BG_HEADER },

                    // Grand orbe bleu Vista — coin bas gauche (halo lumineux)
                    { type: 'ellipse', x: -10, y: H + 20, r1: 120, r2: 90, color: BLUE_VIS, fillOpacity: 0.08 },

                    // Grand orbe violet Vista — coin bas droit
                    { type: 'ellipse', x: W + 10, y: H + 10, r1: 100, r2: 80, color: VIOLET_VIS, fillOpacity: 0.10 },

                    // Orbe léger en haut droite
                    { type: 'ellipse', x: W - 30, y: -20, r1: 80, r2: 60, color: BLUE_LT, fillOpacity: 0.18 },

                    // ── Bordure supérieure bleue Vista ───────────────────────
                    { type: 'line', x1: 0, y1: 0, x2: W, y2: 0, lineWidth: 3, lineColor: BLUE_VIS },
                    { type: 'line', x1: 0, y1: 3, x2: W, y2: 3, lineWidth: 1.2, lineColor: BLUE_LT },

                    // ── Bordure inférieure violette ───────────────────────────
                    { type: 'line', x1: 0, y1: H-1, x2: W, y2: H-1, lineWidth: 2.5, lineColor: VIOLET_VIS },

                    // ── ENCADRÉ LOGO — glass Vista (bord gauche) ─────────────
                    { type: 'rect', x: 12, y: 30, w: 68, h: 68, r: 10, color: SHINE, fillOpacity: 0.55 },
                    { type: 'rect', x: 12, y: 30, w: 68, h: 68, r: 10, lineColor: BLUE_LT, lineWidth: 1.2, color: BG_CARD, fillOpacity: 0 },
                    // Reflet glass haut
                    { type: 'rect', x: 12, y: 30, w: 68, h: 20, r: 8, color: SHINE, fillOpacity: 0.4 },

                    // ── ENCADRÉ QR CODE — glass Vista (bord droit) ───────────
                    { type: 'rect', x: W-84, y: 30, w: 72, h: 72, r: 10, color: SHINE, fillOpacity: 0.55 },
                    { type: 'rect', x: W-84, y: 30, w: 72, h: 72, r: 10, lineColor: VIOLET_LT, lineWidth: 1.2, color: BG_CARD, fillOpacity: 0 },
                    { type: 'rect', x: W-84, y: 30, w: 72, h: 22, r: 8, color: SHINE, fillOpacity: 0.4 },

                    // ── SÉPARATEUR CENTRAL DÉGRADÉ ────────────────────────────
                    { type: 'line', x1: 96, y1: 115, x2: 190, y2: 115, lineWidth: 0.8, lineColor: BLUE_VIS },
                    { type: 'line', x1: 190, y1: 115, x2: W-96, y2: 115, lineWidth: 0.8, lineColor: VIOLET_VIS },

                    // ── CUBE PLAT 2D DÉGRADÉ (coin bas droite) ───────────
                    { type: 'rect', x: cbx, y: cby, w: cs, h: cs, r: cr, color: BLUE_VIS, fillOpacity: 0.85 },
                    { type: 'rect', x: cbx + cs/2, y: cby, w: cs/2, h: cs, r: cr, color: VIOLET_VIS, fillOpacity: 0.72 },
                    { type: 'rect', x: cbx, y: cby, w: cs, h: cs * 0.38, r: cr, color: SHINE, fillOpacity: 0.38 },
                    { type: 'rect', x: cbx, y: cby, w: cs, h: cs, r: cr, lineColor: BLUE_LT, lineWidth: 1, color: BG_CARD, fillOpacity: 0 },
                    { type: 'rect', x: cbx - 18, y: cby + 8, w: 14, h: 14, r: 3, color: VIOLET_LT, fillOpacity: 0.55 },
                    { type: 'rect', x: cbx - 18, y: cby + 8, w: 14, h: 6, r: 3, color: SHINE, fillOpacity: 0.35 },
                    { type: 'rect', x: cbx - 18, y: cby + 8, w: 14, h: 14, r: 3, lineColor: VIOLET_LT, lineWidth: 0.8, color: BG_CARD, fillOpacity: 0 },

                    // ── SÉPARATEUR avant bandeau ─────────────────────────────
                    { type: 'line', x1: 0, y1: H-52, x2: W, y2: H-52, lineWidth: 0.5, lineColor: BORDER_CLR },

                    // ── BANDEAU DROITS RÉSERVÉS — rect arrondi glass ─────────
                    { type: 'rect', x: 12, y: H-48, w: W-24, h: 34, r: 9, color: SHINE, fillOpacity: 0.55 },
                    { type: 'rect', x: 12, y: H-48, w: W-24, h: 14, r: 7, color: SHINE, fillOpacity: 0.35 },
                    { type: 'rect', x: 12, y: H-48, w: W-24, h: 34, r: 9, lineColor: BLUE_VIS, lineWidth: 1.0, color: BG_CARD, fillOpacity: 0 },
                    { type: 'rect', x: 14, y: H-46, w: W-28, h: 30, r: 7, lineColor: VIOLET_LT, lineWidth: 0.4, color: BG_CARD, fillOpacity: 0 },
                ],
                absolutePosition: { x: 0, y: 0 }
            },

            // ── TITRE HEADER ────────────────────────────────────────────────
            {
                text: '✦  CARTE DE MEMBRE DIGITALE  ✦',
                fontSize: 6.5,
                bold: true,
                color: TXT_DARK,
                alignment: 'center',
                characterSpacing: 2,
                absolutePosition: { x: 0, y: 7 },
                width: W
            },

            // ── LOGO IMAGE ─────────────────────────────────────────────────
            {
                image: logo,
                width: 50,
                absolutePosition: { x: 21, y: 39 }
            },

            // ── QR CODE — encadré x:W-84=266, w:72 → centre x=302
            //   fit:62 → demi=31 → x=302-31=271, y=30+(72-62)/2=35
            {
                qr: membre.id || '0',
                fit: 62,
                foreground: TXT_DARK,
                background: '#ffffff',
                absolutePosition: { x: 271, y: 35 }
            },

            // ── DONNÉES MEMBRE ─────────────────────────────────────────────
            // NOM — label + valeur (ligne 1)
            { text: 'NOM', fontSize: 5.5, bold: true, color: TXT_MID, characterSpacing: 1.2,
              absolutePosition: { x: 96, y: 31 } },
            { text: String(membre.prenom || ''), fontSize: 9.5, color: TXT_ACCENT,
              absolutePosition: { x: 148, y: 29 } },

            // PRÉNOM — label + valeur (ligne 2)
            { text: 'PRÉNOM', fontSize: 5.5, bold: true, color: TXT_MID, characterSpacing: 1.2,
              absolutePosition: { x: 96, y: 51 } },
            { text: String(membre.nom || ''), fontSize: 10, bold: true, color: TXT_DARK,
              absolutePosition: { x: 148, y: 49 } },

            // ID — label
            { text: 'ID', fontSize: 5.5, bold: true, color: TXT_MID, characterSpacing: 1.2,
              absolutePosition: { x: 96, y: 71 } },
            // ID — valeur
            { text: '#' + String(membre.id), fontSize: 9, bold: true, color: VIOLET_VIS,
              absolutePosition: { x: 148, y: 69 } },

            // STATUT — label
            { text: 'STATUT', fontSize: 5.5, bold: true, color: TXT_MID, characterSpacing: 1.2,
              absolutePosition: { x: 96, y: 91 } },
            // STATUT — valeur
            { text: String(membre.statut || '').toUpperCase(), fontSize: 8, bold: true, color: BLUE_VIS,
              absolutePosition: { x: 148, y: 90 } },

            // ADHÉSION — label
            { text: 'ADHÉSION', fontSize: 5.5, bold: true, color: TXT_MID, characterSpacing: 1.0,
              absolutePosition: { x: 96, y: 122 } },
            // ADHÉSION — valeur
            { text: String(membre.dateAdhesion || ''), fontSize: 8, color: TXT_ACCENT, italics: true,
              absolutePosition: { x: 152, y: 121 } },

            // ── BANDEAU : droits réservés + membre officiel ─────────────
            // Trick pdfmake : on enveloppe dans un stack avec absolutePosition
            // pour éviter que le texte ne s'insère dans le flux normal
            {
                stack: [
                    {
                        text: '© Tous droits d\'entrée réservés à : ' + companyName,
                        fontSize: 6,
                        bold: true,
                        color: TXT_MID,
                        alignment: 'center',
                        characterSpacing: 0.2,
                        margin: [0, 0, 0, 3]
                    },
                    {
                        text: '★  Membre officiel  ★',
                        fontSize: 5.5,
                        color: TXT_SUB,
                        alignment: 'center',
                        italics: true,
                        characterSpacing: 1.2
                    }
                ],
                absolutePosition: { x: 12, y: H - 43 },
                width: W - 24
            }
        ]
    };
}
function generateCard(id) {
    const membre = membres.find(m => m.id===id);
    if(!membre) return;
    const logo = getLogoBase64() || 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
    pdfMake.createPdf(buildCardDoc(membre, logo)).download(`carte_${membre.id}.pdf`);
}

function generateAllCards() {
    if (membres.length === 0) return showToast("Aucun membre !", "error");

    const loader = document.createElement("div");
    loader.id = "pdfLoader";
    loader.style.cssText = `
        position:fixed; inset:0; background:rgba(13,13,13,.6); backdrop-filter:blur(4px);
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        z-index:9999; color:white; font-family:'DM Sans',sans-serif; gap:16px;
    `;
    loader.innerHTML = `
        <div style="width:48px;height:48px;border:4px solid rgba(255,255,255,.2);border-top-color:#818cf8;border-radius:50%;animation:spin .8s linear infinite;"></div>
        <div style="font-size:1.1rem;font-weight:600;">Génération des cartes en cours…</div>
        <div style="font-size:.85rem;opacity:.7;">${membres.length} carte(s) à générer</div>
        <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    `;
    document.body.appendChild(loader);

    setTimeout(() => {
        try {
            const logo = getLogoBase64() || 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
            // W et H définis dans buildCardDoc (350 x 230)
            const W = 350, H = 230;
            const allContent = [];

            membres.forEach((m, index) => {
                if (index > 0) allContent.push({ text: '', pageBreak: 'before' });
                const cardDoc = buildCardDoc(m, logo);
                allContent.push(...cardDoc.content);
            });

            const doc = {
                pageSize: { width: W, height: H },
                pageMargins: [0, 0, 0, 0],
                content: allContent
            };

            pdfMake.createPdf(doc).download("cartes_membres.pdf", () => {
                document.body.removeChild(loader);
                showToast(`${membres.length} carte(s) générée(s) !`);
            });

        } catch (err) {
            document.body.removeChild(loader);
            showToast("Erreur lors de la génération : " + err.message, "error");
        }
    }, 100);
}

// ===================== ZIP Cartes individuelles =====================
async function generateZipCards() {
    if (membres.length === 0) return showToast("Aucun membre !", "error");
    if (typeof JSZip === "undefined") {
        return showToast("JSZip non chargé. Vérifiez votre connexion.", "error");
    }

    // Indicateur de chargement
    const loader = document.createElement("div");
    loader.id = "zipLoader";
    loader.style.cssText = `
        position:fixed; inset:0; background:rgba(13,13,13,.65); backdrop-filter:blur(5px);
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        z-index:9999; color:white; font-family:'Nunito','DM Sans',sans-serif; gap:16px;
    `;
    loader.innerHTML = `
        <div style="width:52px;height:52px;border:4px solid rgba(255,255,255,.2);border-top-color:#4ade80;border-radius:50%;animation:spinz .8s linear infinite;"></div>
        <div style="font-size:1.15rem;font-weight:700;" id="zipLoaderTitle">Préparation du ZIP…</div>
        <div style="width:280px;background:rgba(255,255,255,.15);border-radius:50px;height:10px;overflow:hidden;">
            <div id="zipProgressBar" style="height:100%;width:0%;background:linear-gradient(90deg,#4ade80,#16a34a);border-radius:50px;transition:width .3s;"></div>
        </div>
        <div style="font-size:.9rem;opacity:.8;" id="zipLoaderSub">0 / ${membres.length} cartes</div>
        <style>@keyframes spinz{to{transform:rotate(360deg)}}</style>
    `;
    document.body.appendChild(loader);

    const logo = getLogoBase64() || 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
    const zip = new JSZip();
    let done = 0;

    // Génère un PDF pour un membre et retourne un Blob
    function generateCardBlob(m) {
        return new Promise((resolve, reject) => {
            try {
                pdfMake.createPdf(buildCardDoc(m, logo)).getBlob(blob => resolve(blob), err => reject(err));
            } catch(e) { reject(e); }
        });
    }

    // Traitement séquentiel pour ne pas saturer la mémoire
    try {
        for (const m of membres) {
            const blob = await generateCardBlob(m);
            const fileName = `carte_${m.id}.pdf`;
            zip.file(fileName, blob);
            done++;
            const pct = Math.round((done / membres.length) * 100);
            const bar = document.getElementById("zipProgressBar");
            const sub = document.getElementById("zipLoaderSub");
            const title = document.getElementById("zipLoaderTitle");
            if (bar) bar.style.width = pct + "%";
            if (sub) sub.textContent = `${done} / ${membres.length} cartes`;
            if (title && done === membres.length) title.textContent = "Compression du ZIP…";
        }

        const zipBlob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(zipBlob);
        const today = new Date().toISOString().slice(0,10);
        a.download = `cartes_membres_${today}.zip`;
        a.click();
        URL.revokeObjectURL(a.href);

        document.body.removeChild(loader);
        showToast(`ZIP généré ! ${membres.length} carte(s) incluse(s) ✅`);

    } catch(err) {
        if (document.body.contains(loader)) document.body.removeChild(loader);
        console.error("Erreur ZIP:", err);
        showToast("Erreur lors de la génération du ZIP : " + err.message, "error");
    }
}


function generateListPDF() {
    if (membres.length === 0) return showToast("Aucun membre !", "error");

    const body = [
        [
            { text: "ID",           style: "tableHeader" },
            { text: "Prénom",       style: "tableHeader" },
            { text: "Nom",          style: "tableHeader" },
            { text: "Adresse",      style: "tableHeader" },
            { text: "Localité",     style: "tableHeader" },
            { text: "Email",        style: "tableHeader" },
            { text: "Téléphone",    style: "tableHeader" },
            { text: "Statut",       style: "tableHeader" },
            { text: "Date adhésion",style: "tableHeader" }
        ],
        ...membres.map(m => [
            m.id           || '',
            m.prenom       || '',
            m.nom          || '',
            m.adresse      || '',
            m.localite     || '',
            m.email        || '',
            m.telephone    || '',
            m.statut       || '',
            m.dateAdhesion || ''
        ])
    ];

    const doc = {
        pageOrientation: 'landscape',
        pageSize: 'A4',
        pageMargins: [20, 30, 20, 30],
        content: [
            { text: "Liste des membres", style: "title", margin: [0, 0, 0, 14] },
            {
                table: {
                    headerRows: 1,
                    // ID, Prénom, Nom, Adresse, Localité, Email, Téléphone, Statut, Date
                    widths: [25, 55, 55, 100, 70, 115, 70, 48, 55],
                    body: body
                },
                layout: {
                    fillColor: (rowIndex) => rowIndex === 0 ? '#3730a3' : (rowIndex % 2 === 0 ? '#f0f0f8' : null),
                    hLineWidth: () => 0.5,
                    vLineWidth: () => 0.5,
                    hLineColor: () => '#cccccc',
                    vLineColor: () => '#cccccc',
                    paddingLeft:  () => 5,
                    paddingRight: () => 5,
                    paddingTop:   () => 5,
                    paddingBottom:() => 5
                }
            }
        ],
        styles: {
            title: { fontSize: 16, bold: true, alignment: 'center', color: '#0d0d0d' },
            tableHeader: { fontSize: 8, bold: true, color: 'white', alignment: 'center' }
        },
        defaultStyle: { fontSize: 8, color: '#0d0d0d' }
    };

    pdfMake.createPdf(doc).open();
}

// ===================== Email =====================
function openEmailModal(membreId=null){
    const select = document.getElementById("emailMembreSelect");
    select.innerHTML = membres.map(m=>
        `<option value="${m.id}" ${m.id===membreId?'selected':''}>${m.prenom} ${m.nom} (${m.email})</option>`
    ).join("");
    const membre = membres.find(m=>m.id===membreId)||membres[0];
    const defaultBody = `Bonjour ${membre.prenom} ${membre.nom},\n\nVeuillez trouver ci-joint votre carte de membre.\n\nVoici vos accès à l'Espace Membre (pour consulter et télécharger vos tickets) :\nPseudo : ${membre.pseudo || '—'}\nMot de passe : ${membre.motDePasse || '—'}\nCode d'accès : ${membre.codeAcces || '—'}\n\nMerci pour vos dons\n\nEnsemble aidons les malvoyants\n\nCordialement,\n\nLECUBECLUBKARAOKEASBL`;
    document.getElementById("emailSubject").value = localStorage.getItem("emailSubject")||"Votre carte de membre digitale";
    document.getElementById("emailBody").value = localStorage.getItem("emailBody")||defaultBody;
    const modal = document.getElementById("emailModal");
    modal.classList.remove("hidden");
    modal.style.display="flex";
}

document.getElementById("emailMembreSelect").addEventListener("change", function() {
    const membreId = this.value;
    const membre = membres.find(m => m.id === membreId);
    if (!membre) return;

    const defaultBody = `Bienvenue ${membre.prenom},\n\n` +
        "Veuillez trouver ci-joint votre carte de membre.\n\n" +
        "Voici vos accès à l'Espace Membre (pour consulter et télécharger vos tickets) :\n" +
        `Pseudo : ${membre.pseudo || '—'}\n` +
        `Mot de passe : ${membre.motDePasse || '—'}\n` +
        `Code d'accès : ${membre.codeAcces || '—'}\n\n` +
        "Merci pour vos dons\n\n" +
        "Ensemble aidons les malvoyants\n\n" +
        "Cordialement,\n\n" +
        "LECUBECLUBKARAOKEASBL";

    document.getElementById("emailBody").value = defaultBody;
});

function closeEmailModal(){
    const modal = document.getElementById("emailModal");
    modal.style.display="none";
    modal.classList.add("hidden");
}

function sendEmail(){
    const membreId = document.getElementById("emailMembreSelect").value;
    const membre = membres.find(m=>m.id===membreId);
    if(!membre) return showToast("Membre introuvable !","error");
    const subject = document.getElementById("emailSubject").value;
    const body = document.getElementById("emailBody").value;
    localStorage.setItem("emailSubject",subject);
    localStorage.setItem("emailBody",body);
    const link = `mailto:${membre.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href=link;
    closeEmailModal();
}

// ===================== Navigation Pagination =====================
function goToFirstPage() {
    currentPage = 1;
    renderTable();
}

function goToLastPage() {
    const totalPages = Math.ceil(getFilteredMembres().length / itemsPerPage) || 1;
    currentPage = totalPages;
    renderTable();
}

// ===================== Mise à jour du rendu du tableau =====================
function updateTableInfo() {
    const totalCount = document.getElementById('totalCount');
    if (totalCount) {
        const nb = getFilteredMembres().length;
        totalCount.textContent = searchTerm.trim() ? `${nb} / ${membres.length}` : membres.length;
    }
}

// ===================== Initialisation =====================
document.addEventListener("DOMContentLoaded", () => {
    const si = document.getElementById("searchMembres");
    if (si) {
        si.addEventListener("input", e => onSearchInput(e.target.value));
        si.addEventListener("keydown", e => { if (e.key === "Escape") clearSearch(); });
    }
    const sc = document.getElementById("searchClear");
    if (sc) sc.addEventListener("click", clearSearch);
});

document.addEventListener("DOMContentLoaded", async () => {
    // Charger d'abord depuis le serveur pour avoir les données à jour
    await loadMembresFromServer();
    migrerAccesMembres();
    renderTable();
    updateTableInfo();
    
    // S'assurer que les modales sont fermées au démarrage
    const emailModal = document.getElementById("emailModal");
    if (emailModal) {
        emailModal.style.display = "none";
    }
    closeMembreModal();
});

// ===================== Modales Import/Export & PDF =====================
function openModalData() {
    const m = document.getElementById("modalData");
    m.classList.remove("hidden");
    m.style.display = "flex";
}
function closeModalData() {
    const m = document.getElementById("modalData");
    m.style.display = "none";
    m.classList.add("hidden");
}
function openModalDocs() {
    const m = document.getElementById("modalDocs");
    m.classList.remove("hidden");
    m.style.display = "flex";
    // Affiche l'état du logo actuel
    const display = document.getElementById("logoFileNameDisplay");
    if (display) {
        const override = localStorage.getItem("membresLogoOverride");
        const settings = JSON.parse(localStorage.getItem("companySettings") || "{}");
        if (override) {
            display.textContent = "Logo personnalisé (cartes)";
            display.style.color = "#7c3aed";
        } else if (settings.companyLogo) {
            display.textContent = "Logo depuis Paramètres ✓";
            display.style.color = "#059669";
        } else {
            display.textContent = "Aucun logo chargé";
            display.style.color = "#94a3b8";
        }
    }
}
function closeModalDocs() {
    const m = document.getElementById("modalDocs");
    m.style.display = "none";
    m.classList.add("hidden");
}

// Réinitialise l'override et revient au logo de Paramètres
function resetLogoOverride() {
    localStorage.removeItem("membresLogoOverride");
    logoBase64 = getLogoBase64();
    const display = document.getElementById("logoFileNameDisplay");
    if (display) {
        const settings = JSON.parse(localStorage.getItem("companySettings") || "{}");
        if (settings.companyLogo) {
            display.textContent = "Logo depuis Paramètres ✓";
            display.style.color = "#059669";
        } else {
            display.textContent = "Aucun logo chargé";
            display.style.color = "#94a3b8";
        }
    }
    showToast("Logo réinitialisé (logo de Paramètres)", "info");
}

function handleLogoUpload(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        logoBase64 = e.target.result;
        localStorage.setItem("membresLogoOverride", logoBase64);
        const display = document.getElementById("logoFileNameDisplay");
        if (display) display.textContent = file.name;
        showToast("Logo importé !");
    };
    reader.readAsDataURL(file);
}

// ===================== Modale Tickets Membre =====================
let ticketsCurrentPage = 1;
const ticketsPerPage = 5;
let allTicketsMembre = [];

function openTicketsModal(membreId) {
    const membre = membres.find(m => m.id === membreId);
    if (!membre) return;

    const ticketsHistorique = JSON.parse(localStorage.getItem("ticketsHistorique")) || [];
    const tickets = JSON.parse(localStorage.getItem("tickets")) || [];

    const ticketsPayes = ticketsHistorique.filter(t =>
        t.membreId === membreId ||
        (t.membreNom === membre.nom && t.membrePrenom === membre.prenom)
    );
    const ticketsEnCours = tickets.filter(t =>
        t.membreId === membreId ||
        (t.membreNom === membre.nom && t.membrePrenom === membre.prenom)
    );

    // Construire la liste complète : en cours d'abord, puis payés du plus récent
    allTicketsMembre = [
        ...ticketsEnCours.map(t => ({ ...t, _paye: false, _total: t.articles ? t.articles.reduce((s,a) => s+(a.prix*a.qte),0) : 0 })),
        ...[...ticketsPayes].reverse().map(t => ({ ...t, _paye: true,  _total: t.total || 0 }))
    ];

    const totalDepense = ticketsPayes.reduce((sum, t) => sum + (t.total || 0), 0);
    const nbTickets = allTicketsMembre.length;

    document.getElementById("ticketsModalNom").textContent = `${membre.prenom} ${membre.nom}`;
    document.getElementById("ticketsModalStats").innerHTML = `
        <div class="ticket-stat">
            <span class="ticket-stat-val">${nbTickets}</span>
            <span class="ticket-stat-label">Ticket(s)</span>
        </div>
        <div class="ticket-stat">
            <span class="ticket-stat-val">${ticketsPayes.length}</span>
            <span class="ticket-stat-label">Payé(s)</span>
        </div>
        <div class="ticket-stat">
            <span class="ticket-stat-val">${ticketsEnCours.length}</span>
            <span class="ticket-stat-label">En cours</span>
        </div>
        <div class="ticket-stat accent">
            <span class="ticket-stat-val">${totalDepense.toFixed(2)} €</span>
            <span class="ticket-stat-label">Total dépensé</span>
        </div>
    `;

    ticketsCurrentPage = 1;
    renderTicketsPage();

    const modal = document.getElementById("ticketsModal");
    modal.classList.remove("hidden");
    modal.style.display = "flex";
}

function renderTicketsPage() {
    const liste = document.getElementById("ticketsModalListe");
    const paginationEl = document.getElementById("ticketsPagination");
    liste.innerHTML = "";

    if (allTicketsMembre.length === 0) {
        liste.innerHTML = `<div class="tickets-empty"><i class="fas fa-receipt"></i><p>Aucun ticket pour ce membre</p></div>`;
        paginationEl.innerHTML = "";
        return;
    }

    const totalPages = Math.ceil(allTicketsMembre.length / ticketsPerPage);
    const start = (ticketsCurrentPage - 1) * ticketsPerPage;
    const page = allTicketsMembre.slice(start, start + ticketsPerPage);

    // Affichage en lignes compactes
    page.forEach((t, idx) => {
        const realIdx = start + idx;
        const badge = t._paye
            ? `<span class="trow-badge paye"><i class="fas fa-check"></i> Payé</span>`
            : `<span class="trow-badge encours"><i class="fas fa-clock"></i> En cours</span>`;
        const modeIcon = { especes: 'fa-coins', banque: 'fa-university', mixte: 'fa-random' }[t.modePaiement] || 'fa-money-bill';
        const nbArticles = (t.articles || []).length;

        liste.innerHTML += `
        <div class="trow" onclick="openTicketDetail(${realIdx})">
            <div class="trow-left">
                <span class="trow-id">#${t.id || '—'}</span>
                <span class="trow-date">${t.datePaiement || t.date || '—'} ${t.heurePaiement || t.heure || ''}</span>
            </div>
            <div class="trow-right">
                <span class="trow-articles">${nbArticles} article(s)</span>
                ${t.modePaiement ? `<span class="trow-mode"><i class="fas ${modeIcon}"></i></span>` : ''}
                ${badge}
                <span class="trow-total">${t._total.toFixed(2)} €</span>
                <i class="fas fa-chevron-right trow-arrow"></i>
            </div>
        </div>`;
    });

    // Pagination
    paginationEl.innerHTML = "";
    const info = document.createElement("span");
    info.className = "tpag-info";
    info.textContent = `Page ${ticketsCurrentPage} / ${totalPages} — ${allTicketsMembre.length} ticket(s)`;
    paginationEl.appendChild(info);

    const btns = document.createElement("div");
    btns.className = "tpag-btns";

    const prev = document.createElement("button");
    prev.className = "tpag-btn";
    prev.innerHTML = `<i class="fas fa-chevron-left"></i>`;
    prev.disabled = ticketsCurrentPage === 1;
    prev.onclick = () => { ticketsCurrentPage--; renderTicketsPage(); };
    btns.appendChild(prev);

    for (let i = 1; i <= totalPages; i++) {
        const btn = document.createElement("button");
        btn.className = "tpag-btn" + (i === ticketsCurrentPage ? " active" : "");
        btn.textContent = i;
        btn.onclick = () => { ticketsCurrentPage = i; renderTicketsPage(); };
        btns.appendChild(btn);
    }

    const next = document.createElement("button");
    next.className = "tpag-btn";
    next.innerHTML = `<i class="fas fa-chevron-right"></i>`;
    next.disabled = ticketsCurrentPage === totalPages;
    next.onclick = () => { ticketsCurrentPage++; renderTicketsPage(); };
    btns.appendChild(next);

    paginationEl.appendChild(btns);
    liste.scrollTop = 0;
}

function openTicketDetail(idx) {
    const t = allTicketsMembre[idx];
    if (!t) return;

    const modeIcon = { especes: 'fa-coins', banque: 'fa-university', mixte: 'fa-random' }[t.modePaiement] || 'fa-money-bill';
    const badge = t._paye
        ? `<span class="tcard-badge paye"><i class="fas fa-check"></i> Payé</span>`
        : `<span class="tcard-badge encours"><i class="fas fa-clock"></i> En cours</span>`;

    const articles = (t.articles || []).map(a =>
        `<div class="tcard-article">
            <span>${a.nom} <em style="color:var(--slate)">×${a.qte}</em></span>
            <span>${(a.prix * a.qte).toFixed(2)} €</span>
        </div>`
    ).join("") || `<span style="color:#94a3b8;font-size:.85rem;">Aucun article</span>`;

    let paiementDetail = "";
    if (t.modePaiement === "especes" && t.montantRecu) {
        paiementDetail = `
            <div class="tdetail-row"><span>Reçu</span><span>${t.montantRecu.toFixed(2)} €</span></div>
            <div class="tdetail-row"><span>Rendu</span><span style="color:var(--emerald)">${(t.rendu||0).toFixed(2)} €</span></div>`;
    } else if (t.modePaiement === "mixte") {
        paiementDetail = `
            <div class="tdetail-row"><span>Espèces</span><span>${(t.montantEspeces||0).toFixed(2)} €</span></div>
            <div class="tdetail-row"><span>Banque</span><span>${(t.montantBanque||0).toFixed(2)} €</span></div>`;
    }

    document.getElementById("ticketDetailContent").innerHTML = `
        <div class="tdetail-header">
            <div>
                <div class="tcard-id" style="font-size:1.1rem;">Ticket #${t.id || '—'}</div>
                <div class="tcard-date" style="margin-top:4px;">${t.datePaiement || t.date || ''} ${t.heurePaiement || t.heure || ''}</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                ${t.modePaiement ? `<span class="tcard-mode"><i class="fas ${modeIcon}"></i> ${t.modePaiement}</span>` : ''}
                ${badge}
            </div>
        </div>
        <div class="tdetail-section">
            <div class="tdetail-section-title"><i class="fas fa-shopping-basket"></i> Articles</div>
            <div class="tcard-articles" style="background:var(--chalk);border-radius:10px;padding:12px;">${articles}</div>
        </div>
        <div class="tdetail-section">
            <div class="tdetail-section-title"><i class="fas fa-money-bill"></i> Paiement</div>
            <div class="tdetail-row total"><span>Total</span><span>${t._total.toFixed(2)} €</span></div>
            ${paiementDetail}
        </div>
    `;

    document.getElementById("ticketDetailModal").classList.remove("hidden");
    document.getElementById("ticketDetailModal").style.display = "flex";
}

function closeTicketDetail() {
    const m = document.getElementById("ticketDetailModal");
    m.style.display = "none";
    m.classList.add("hidden");
}

function renderTicketCard(t, total, paye) {
    const articles = (t.articles || []).map(a =>
        `<div class="tcard-article"><span>${a.nom} ×${a.qte}</span><span>${(a.prix * a.qte).toFixed(2)} €</span></div>`
    ).join("");

    const modeIcon = { especes: 'fa-coins', banque: 'fa-university', mixte: 'fa-random' };
    const badge = paye
        ? `<span class="tcard-badge paye"><i class="fas fa-check"></i> Payé</span>`
        : `<span class="tcard-badge encours"><i class="fas fa-clock"></i> En cours</span>`;

    return `
    <div class="tcard">
        <div class="tcard-header">
            <div class="tcard-info">
                <span class="tcard-id">#${t.id || '—'}</span>
                <span class="tcard-date">${t.datePaiement || t.date || ''} ${t.heurePaiement || t.heure || ''}</span>
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
                ${t.modePaiement ? `<span class="tcard-mode"><i class="fas ${modeIcon[t.modePaiement] || 'fa-money-bill'}"></i> ${t.modePaiement}</span>` : ''}
                ${badge}
            </div>
        </div>
        <div class="tcard-articles">${articles || '<span style="color:#94a3b8;font-size:.85rem;">Aucun article</span>'}</div>
        <div class="tcard-footer">
            <span class="tcard-total">Total : <strong>${(total || 0).toFixed(2)} €</strong></span>
            ${t.rendu ? `<span class="tcard-rendu">Rendu : ${t.rendu.toFixed(2)} €</span>` : ''}
        </div>
    </div>`;
}

function closeTicketsModal() {
    const modal = document.getElementById("ticketsModal");
    modal.style.display = "none";
    modal.classList.add("hidden");
}
