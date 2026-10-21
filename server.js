// ======== server.js ========
const express = require("express");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const XLSX = require("xlsx");

// Charger la config
const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
const app = express();
const PORT = 3000;

// Dossier de sauvegarde Excel
const SAUVEGARDE_DIR = path.join(__dirname, "sauvegarde données");
if (!fs.existsSync(SAUVEGARDE_DIR)) {
  fs.mkdirSync(SAUVEGARDE_DIR, { recursive: true });
  console.log(`📁 Dossier créé : ${SAUVEGARDE_DIR}`);
}

app.use(cors());
app.use(express.json({ limit: "10mb" })); // limite augmentée pour les factures avec QR base64

// Création du transporteur gmail
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: config.smtp.auth.user,
    pass: config.smtp.auth.pass,
  },
});

// ============================================================
// ROUTE 1 : Envoi des cartes membres (inchangé — carte PDF obligatoire)
// ============================================================
app.post("/send-email", async (req, res) => {
  const { id, email, subject, body } = req.body;
  if (!id || !email) return res.status(400).json({ error: "ID ou email manquant" });

  const pdfPath = path.join(config.dossierCartes, `carte_${id}.pdf`);
  if (!fs.existsSync(pdfPath)) {
    return res.status(404).json({ error: `Carte introuvable : ${pdfPath}` });
  }

  try {
    const info = await transporter.sendMail({
      from: `"${config.nomEntreprise || config.smtp.auth.user}" <${config.smtp.auth.user}>`,
      to: email,
      subject: subject || `Votre carte de membre #${id}`,
      text: body || `Bonjour,\n\nVeuillez trouver ci-joint votre carte de membre #${id}.\n\nCordialement,\nLe service adhérents`,
      attachments: [{ filename: `carte_${id}.pdf`, path: pdfPath }],
    });

    console.log(`✅ Carte envoyée à ${email} (${info.messageId})`);
    res.json({ success: true, messageId: info.messageId });
  } catch (err) {
    console.error("❌ Erreur d'envoi carte :", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE 1b : Mailing général (affiches / événements)
// Envoi simple avec pièce jointe image optionnelle en base64
// ============================================================
app.post("/send-mailing", async (req, res) => {
  const { id, email, subject, body, attachmentBase64, attachmentName, attachmentMime } = req.body;
  if (!email) return res.status(400).json({ error: "Email manquant" });

  const attachments = [];
  if (attachmentBase64 && attachmentName) {
    attachments.push({
      filename: attachmentName,
      content: Buffer.from(attachmentBase64, 'base64'),
      contentType: attachmentMime || 'image/png'
    });
  }

  try {
    const info = await transporter.sendMail({
      from: `"${config.nomEntreprise || config.smtp.auth.user}" <${config.smtp.auth.user}>`,
      to: email,
      subject: subject || `Un message du Cube Club`,
      text: body || `Bonjour,\n\nCordialement,`,
      attachments,
    });

    console.log(`✅ Mailing envoyé à ${email} (${info.messageId})`);
    res.json({ success: true, messageId: info.messageId });
  } catch (err) {
    console.error("❌ Erreur mailing :", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE 2 : Envoi des factures (nouveau)
// La facture est générée côté navigateur et envoyée ici
// sous forme HTML dans l'email + pièce jointe .html imprimable
// ============================================================
app.post("/send-email-facture", async (req, res) => {
  const { id, email, subject, body, statut, montant, factureHtml, lettreHtml, societe, membre } = req.body;

  if (!id || !email) return res.status(400).json({ error: "ID ou email manquant" });

  // Normaliser le statut (enlever accents)
  const statutNorm = (statut || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const couleurStatut = statutNorm === 'paye' ? '#38a86a' : statutNorm === 'impaye' ? '#d94040' : '#e8830a';
  const labelStatut   = statutNorm === 'paye' ? '✅ PAYÉE' : statutNorm === 'impaye' ? '⚠️ IMPAYÉE' : '⏳ À ENCAISSER';

  const nomSociete = societe?.nom || config.nomEntreprise || '';
  const nomMembre  = membre ? `${membre.prenom || ''} ${membre.nom || ''}`.trim() : 'Client';
  const montantStr = montant ? Number(montant).toFixed(2) : '0.00';

  // HTML de l'email (inline, compatible tous clients mail)
  const emailHtml = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Facture FAC-${id}</title></head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:'Segoe UI',Arial,sans-serif;color:#1e3048;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:30px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(31,80,135,0.12);">
        <tr><td style="background:linear-gradient(90deg,#145f8a,#5bb3d4,#e8a838);height:7px;"></td></tr>
        <tr>
          <td style="padding:28px 36px 20px;border-bottom:2px solid #e8f0f8;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td>
                  <div style="font-size:20px;font-weight:800;color:#145f8a;">${nomSociete}</div>
                  ${societe?.adresse ? `<div style="color:#5a7a96;font-size:13px;margin-top:4px;">${societe.adresse}${societe?.localite ? ', ' + societe.localite : ''}</div>` : ''}
                  ${societe?.numero ? `<div style="display:inline-block;background:#145f8a;color:white;padding:3px 12px;border-radius:50px;font-size:11px;font-weight:700;margin-top:6px;">N° ${societe.numero}</div>` : ''}
                </td>
                <td align="right" valign="top">
                  <div style="display:inline-block;background:${couleurStatut};color:white;padding:8px 18px;border-radius:50px;font-size:12px;font-weight:800;letter-spacing:0.5px;">${labelStatut}</div>
                  <div style="color:#5a7a96;font-size:12px;margin-top:8px;">FAC-${id}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 36px;">
            <div style="font-size:15px;line-height:1.8;color:#1e3048;">${(body || '').replace(/\n/g, '<br>')}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 36px 28px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#145f8a,#2a7faa);border-radius:12px;overflow:hidden;">
              <tr>
                <td style="padding:16px 22px;color:rgba(255,255,255,0.8);font-size:12px;font-weight:700;text-transform:uppercase;">Référence</td>
                <td style="padding:16px 22px;color:rgba(255,255,255,0.8);font-size:12px;font-weight:700;text-transform:uppercase;text-align:right;">Montant TTC</td>
              </tr>
              <tr>
                <td style="padding:0 22px 16px;color:white;font-size:16px;font-weight:800;">FAC-${id} — ${nomMembre}</td>
                <td style="padding:0 22px 16px;color:white;font-size:22px;font-weight:800;text-align:right;font-family:Georgia,serif;">${montantStr} €</td>
              </tr>
            </table>
          </td>
        </tr>
        ${statutNorm === 'impaye' ? `
        <tr>
          <td style="padding:0 36px 20px;">
            <div style="background:#fdeaea;border:2px solid rgba(217,64,64,0.3);border-radius:12px;padding:14px 18px;color:#d94040;font-weight:700;font-size:13px;">
              ⚠️ Cette facture est impayée. Merci de procéder au règlement dans les meilleurs délais.
              ${societe?.iban ? `<br><br>💳 <strong>IBAN :</strong> ${societe.iban} &mdash; Comm. : FAC-${id}` : ''}
            </div>
          </td>
        </tr>` : ''}
        ${societe?.iban && statutNorm === 'encaisser' ? `
        <tr>
          <td style="padding:0 36px 20px;">
            <div style="background:#e6f7ed;border:2px solid rgba(56,168,106,0.25);border-radius:12px;padding:14px 18px;font-size:13px;">
              💳 <strong>Virement :</strong> ${societe.iban} &mdash; Communication : FAC-${id}
            </div>
          </td>
        </tr>` : ''}
        <tr>
          <td style="padding:20px 36px;background:#f8fbff;border-top:2px solid #e8f0f8;text-align:center;color:#5a7a96;font-size:12px;border-radius:0 0 16px 16px;">
            📎 La facture détaillée est jointe à cet email en pièce jointe.<br>
            <strong style="color:#145f8a;">${nomSociete}</strong>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  // Pièce jointe : la facture HTML complète (envoyée par le navigateur)
  const attachments = [];
  // Facture HTML (document complet avec responsive CSS intégré)
  if (factureHtml) {
    attachments.push({
      filename: `Facture_FAC-${id}.html`,
      content: factureHtml,
      contentType: 'text/html; charset=utf-8'
    });
  }

  // Mise en demeure (document complet avec responsive CSS intégré)
  if (lettreHtml) {
    attachments.push({
      filename: `Mise_en_demeure_FAC-${id}.html`,
      content: lettreHtml,
      contentType: 'text/html; charset=utf-8'
    });
    console.log(`⚖️  Mise en demeure jointe pour FAC-${id}`);
  }

  try {
    const info = await transporter.sendMail({
      from: `"${nomSociete}" <${config.smtp.auth.user}>`,
      to: email,
      subject: subject || `Votre facture FAC-${id} — ${nomSociete}`,
      text: `${(body || '').replace(/<[^>]*>/g, '')}\n\nMontant : ${montantStr} €\nRéférence : FAC-${id}`,
      html: emailHtml,
      attachments,
    });

    console.log(`✅ Facture FAC-${id} envoyée à ${email} (${info.messageId})`);
    res.json({ success: true, messageId: info.messageId });
  } catch (err) {
    console.error("❌ Erreur envoi facture :", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE 3 : Export Excel — Rapports Z
// ============================================================
app.post("/export-excel-rapports", (req, res) => {
  try {
    const { rapports } = req.body;
    if (!Array.isArray(rapports)) return res.status(400).json({ error: "Données invalides" });
    const wb = XLSX.utils.book_new();
    const resumeRows = [["N° Rapport","Type","Date Clôture","Heure Clôture","Date Ouverture","Heure Ouverture","Utilisateur","CA Net (€)","CA Global (€)","Total Espèces (€)","Total Banque (€)","Fond de Caisse (€)","Total Global (€)","Nb Tickets","Nb Tickets Actifs","Articles Vendus","Valeur Offerts (€)","Total Dons (€)","Dons Espèces (€)","Dons Banque (€)"]];
    rapports.forEach(r => { resumeRows.push([`${r.type}-${r.numero}`,r.type,r.dateCloture,r.heureCloture,r.dateOuverture,r.heureOuverture,r.utilisateur||'',parseFloat(r.ca||0),parseFloat(r.caGlobal||r.ca||0),parseFloat(r.totalEspeces||0),parseFloat(r.totalBanque||0),parseFloat(r.fondCaisse||0),parseFloat(r.totalGlobal||0),parseInt(r.nbTickets||0),parseInt(r.nbTicketsActifs||0),parseInt(r.totalArticles||0),parseFloat(r.totalOfferts||0),parseFloat(r.totalDons||0),parseFloat(r.donsEspeces||0),parseFloat(r.donsBanque||0)]); });
    const wsResume = XLSX.utils.aoa_to_sheet(resumeRows);
    wsResume['!cols'] = resumeRows[0].map(() => ({ wch: 18 }));
    XLSX.utils.book_append_sheet(wb, wsResume, "Résumé Rapports");
    const tvaRows = [["N° Rapport","Date","Taux TVA (%)","Base HTVA (€)","Montant TVA (€)","Total TVAC (€)"]];
    rapports.forEach(r => { if (r.tvaVentilation) { Object.keys(r.tvaVentilation).sort((a,b)=>parseFloat(a)-parseFloat(b)).forEach(taux => { const v = r.tvaVentilation[taux]; tvaRows.push([`${r.type}-${r.numero}`,r.dateCloture,parseFloat(taux),parseFloat(v.base||0),parseFloat(v.tva||0),parseFloat(v.total||0)]); }); } });
    const wsTva = XLSX.utils.aoa_to_sheet(tvaRows);
    wsTva['!cols'] = tvaRows[0].map(() => ({ wch: 18 }));
    XLSX.utils.book_append_sheet(wb, wsTva, "Ventilation TVA");
    const artRows = [["N° Rapport","Date","Catégorie","Article","Quantité","Total (€)"]];
    rapports.forEach(r => { if (r.categories) { Object.keys(r.categories).forEach(cat => { Object.keys(r.categories[cat]).forEach(art => { const obj = r.categories[cat][art]; artRows.push([`${r.type}-${r.numero}`,r.dateCloture,cat,art,parseInt(obj.qte||0),parseFloat(obj.total||0)]); }); }); } });
    const wsArt = XLSX.utils.aoa_to_sheet(artRows);
    wsArt['!cols'] = artRows[0].map(() => ({ wch: 20 }));
    XLSX.utils.book_append_sheet(wb, wsArt, "Articles par Catégorie");
    const isAuto = req.query.auto === '1';
    const dateStr = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    // Auto : écrase le fichier courant. Manuel : fichier horodaté archivé.
    const saveName = isAuto ? 'sauvegarde_courante_rapports.xlsx' : `rapports_${dateStr}.xlsx`;
    XLSX.writeFile(wb, path.join(SAUVEGARDE_DIR, saveName));
    if (!isAuto) console.log(`💾 Export manuel rapports : ${saveName}`);
    if (isAuto) { return res.json({ success: true }); } // pas de téléchargement en mode auto
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="Rapports_Z_${dateStr}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) { console.error("❌ Erreur export rapports :", err.message); res.status(500).json({ error: err.message }); }
});

// ============================================================
// ROUTE 4 : Import Excel — Rapports Z (reconstruction complète avec catégories + TVA)
// ============================================================
app.post("/import-excel-rapports", express.raw({ type: 'application/octet-stream', limit: '20mb' }), (req, res) => {
  try {
    const wb = XLSX.read(req.body, { type: 'buffer' });

    // ---- Feuille résumé ----
    const ws = wb.Sheets["Résumé Rapports"];
    if (!ws) return res.status(400).json({ error: "Feuille 'Résumé Rapports' introuvable" });
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    rows.shift();
    const rapports = rows.filter(r => r[0]).map(r => ({
      numero: r[0]?.toString().split('-')[1] || r[0],
      type: r[1] || 'Z',
      dateCloture: r[2] || '', heureCloture: r[3] || '',
      dateOuverture: r[4] || '', heureOuverture: r[5] || '',
      utilisateur: r[6] || '',
      ca: parseFloat(r[7]) || 0, caGlobal: parseFloat(r[8]) || 0,
      totalEspeces: parseFloat(r[9]) || 0, totalBanque: parseFloat(r[10]) || 0,
      fondCaisse: parseFloat(r[11]) || 0, totalGlobal: parseFloat(r[12]) || 0,
      nbTickets: parseInt(r[13]) || 0, nbTicketsActifs: parseInt(r[14]) || 0,
      totalArticles: parseInt(r[15]) || 0, totalOfferts: parseFloat(r[16]) || 0,
      totalDons: parseFloat(r[17]) || 0, donsEspeces: parseFloat(r[18]) || 0,
      donsBanque: parseFloat(r[19]) || 0,
      categories: {}, tvaVentilation: {}, articlesOfferts: {}
    }));

    // Index rapports par clé "TYPE-NUM"
    const idx = {};
    rapports.forEach(r => { idx[`${r.type}-${r.numero}`] = r; });

    // ---- Feuille TVA ----
    if (wb.Sheets["Ventilation TVA"]) {
      const tvaRows = XLSX.utils.sheet_to_json(wb.Sheets["Ventilation TVA"], { header: 1 });
      tvaRows.shift();
      tvaRows.forEach(r => {
        const rapport = idx[r[0]];
        if (!rapport) return;
        const taux = r[2]?.toString();
        if (!taux) return;
        rapport.tvaActif = true;
        rapport.tvaVentilation[taux] = {
          base: parseFloat(r[3]) || 0,
          tva: parseFloat(r[4]) || 0,
          total: parseFloat(r[5]) || 0
        };
      });
    }

    // ---- Feuille articles par catégorie ----
    if (wb.Sheets["Articles par Catégorie"]) {
      const artRows = XLSX.utils.sheet_to_json(wb.Sheets["Articles par Catégorie"], { header: 1 });
      artRows.shift();
      artRows.forEach(r => {
        const rapport = idx[r[0]];
        if (!rapport || !r[2] || !r[3]) return;
        const cat = r[2].toString();
        const art = r[3].toString();
        if (!rapport.categories[cat]) rapport.categories[cat] = {};
        rapport.categories[cat][art] = {
          qte: parseInt(r[4]) || 0,
          total: parseFloat(r[5]) || 0
        };
      });
    }

    console.log(`📥 Import rapports depuis Excel : ${rapports.length} rapports (avec catégories + TVA)`);
    res.json({ success: true, count: rapports.length, rapports });
  } catch (err) { console.error("❌ Erreur import rapports :", err.message); res.status(500).json({ error: err.message }); }
});

// ============================================================
// ROUTE 5 : Export Excel — Tickets Historique
// ============================================================
app.post("/export-excel-tickets", (req, res) => {
  try {
    const { tickets } = req.body;
    if (!Array.isArray(tickets)) return res.status(400).json({ error: "Données invalides" });
    const wb = XLSX.utils.book_new();
    const ticketRows = [["ID","N° Ticket","Date","Heure","Mode Paiement","Total (€)","Espèces (€)","Banque (€)","Table","Statut","Remboursé","Supprimé","Articles"]];
    tickets.forEach(t => { const articlesStr = Array.isArray(t.articles) ? t.articles.map(a=>`${a.nom||a.name} x${a.quantite||a.qty||1} (${parseFloat(a.prixTotal||a.prix||0).toFixed(2)}€)`).join(' | ') : ''; ticketRows.push([t.id||'',t.numero||t.id||'',t.datePaiement||t.date||'',t.heurePaiement||t.heure||'',t.modePaiement||'',parseFloat(t.total||0),parseFloat(t.montantEspeces||0),parseFloat(t.montantBanque||0),t.table||t.tableNom||'',t.statut||'',t.refundedAt?'Oui':'Non',t.deletedAt?'Oui':'Non',articlesStr]); });
    const wsTickets = XLSX.utils.aoa_to_sheet(ticketRows);
    wsTickets['!cols'] = [8,10,12,10,16,12,12,12,12,12,12,12,40].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, wsTickets, "Tickets");
    const detailRows = [["ID Ticket","N° Ticket","Date","Article","Catégorie","Quantité","Prix unitaire (€)","Total ligne (€)","Offert"]];
    tickets.forEach(t => { if (Array.isArray(t.articles)) { t.articles.forEach(a => { detailRows.push([t.id||'',t.numero||t.id||'',t.datePaiement||t.date||'',a.nom||a.name||'',a.categorie||a.category||'',parseInt(a.quantite||a.qty||1),parseFloat(a.prix||a.prixUnitaire||0),parseFloat(a.prixTotal||(a.prix*(a.quantite||1))||0),a.offert?'Oui':'Non']); }); } });
    const wsDetail = XLSX.utils.aoa_to_sheet(detailRows);
    wsDetail['!cols'] = detailRows[0].map(()=>({wch:18}));
    XLSX.utils.book_append_sheet(wb, wsDetail, "Détail Articles");
    const isAuto = req.query.auto === '1';
    const dateStr = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    const saveName = isAuto ? 'sauvegarde_courante_tickets.xlsx' : `tickets_${dateStr}.xlsx`;
    XLSX.writeFile(wb, path.join(SAUVEGARDE_DIR, saveName));
    if (!isAuto) console.log(`💾 Export manuel tickets : ${saveName}`);
    if (isAuto) { return res.json({ success: true }); }
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="Historique_Tickets_${dateStr}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) { console.error("❌ Erreur export tickets :", err.message); res.status(500).json({ error: err.message }); }
});

// ============================================================
// ROUTE 6 : Import Excel — Tickets Historique
// ============================================================
app.post("/import-excel-tickets", express.raw({ type: 'application/octet-stream', limit: '20mb' }), (req, res) => {
  try {
    const wb = XLSX.read(req.body, { type: 'buffer' });
    const ws = wb.Sheets["Tickets"];
    if (!ws) return res.status(400).json({ error: "Feuille 'Tickets' introuvable" });
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    rows.shift();
    const tickets = rows.filter(r => r[0]).map(r => ({ id: r[0]?.toString()||'', numero: r[1]||r[0]||'', datePaiement: r[2]||'', heurePaiement: r[3]||'', modePaiement: r[4]||'', total: parseFloat(r[5])||0, montantEspeces: parseFloat(r[6])||0, montantBanque: parseFloat(r[7])||0, table: r[8]||'', statut: r[9]||'', articles: [] }));
    console.log(`📥 Import tickets depuis Excel : ${tickets.length} tickets`);
    res.json({ success: true, count: tickets.length, tickets });
  } catch (err) { console.error("❌ Erreur import tickets :", err.message); res.status(500).json({ error: err.message }); }
});

// ============================================================
// ROUTE 7 : Export Excel — Membres
// ============================================================
app.post("/export-excel-membres", (req, res) => {
  try {
    const { membres } = req.body;
    if (!Array.isArray(membres)) return res.status(400).json({ error: "Données invalides" });
    const wb = XLSX.utils.book_new();
    const rows = [["ID","Prénom","Nom","Adresse","Localité","Email","Téléphone","Statut","Date Adhésion"]];
    membres.forEach(m => { rows.push([m.id||'',m.prenom||'',m.nom||'',m.adresse||'',m.localite||'',m.email||'',m.telephone||'',m.statut||'',m.dateAdhesion||'']); });
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [8,14,14,22,16,26,14,14,14].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, "Membres");
    const actifs = membres.filter(m=>m.statut?.toLowerCase()==='actif').length;
    const statsRows = [["Statistique","Valeur"],["Total membres",membres.length],["Membres actifs",actifs],["Membres inactifs",membres.length-actifs],["Export le",new Date().toLocaleDateString('fr-BE')]];
    const wsStats = XLSX.utils.aoa_to_sheet(statsRows);
    wsStats['!cols'] = [{wch:20},{wch:14}];
    XLSX.utils.book_append_sheet(wb, wsStats, "Statistiques");
    const isAuto = req.query.auto === '1';
    const dateStr = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    const saveName = isAuto ? 'sauvegarde_courante_membres.xlsx' : `membres_${dateStr}.xlsx`;
    XLSX.writeFile(wb, path.join(SAUVEGARDE_DIR, saveName));
    if (!isAuto) console.log(`💾 Export manuel membres : ${saveName}`);
    if (isAuto) { return res.json({ success: true }); }
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="Membres_${dateStr}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) { console.error("❌ Erreur export membres :", err.message); res.status(500).json({ error: err.message }); }
});

// ============================================================
// ROUTE 8 : Import Excel — Membres
// ============================================================
app.post("/import-excel-membres", express.raw({ type: 'application/octet-stream', limit: '10mb' }), (req, res) => {
  try {
    const wb = XLSX.read(req.body, { type: 'buffer' });
    const ws = wb.Sheets["Membres"];
    if (!ws) return res.status(400).json({ error: "Feuille 'Membres' introuvable" });
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    rows.shift();
    const membres = rows.filter(r=>r[1]||r[2]).map(r => ({ id: r[0]?.toString()||String(Date.now()+Math.random()), prenom: r[1]||'', nom: r[2]||'', adresse: r[3]||'', localite: r[4]||'', email: r[5]||'', telephone: r[6]||'', statut: r[7]||'Actif', dateAdhesion: r[8]||new Date().toLocaleDateString('fr-BE') }));
    console.log(`📥 Import membres depuis Excel : ${membres.length} membres`);
    res.json({ success: true, count: membres.length, membres });
  } catch (err) { console.error("❌ Erreur import membres :", err.message); res.status(500).json({ error: err.message }); }
});

// ============================================================
// Démarrage
// ============================================================
app.listen(PORT, () => {
  console.log(`🚀 Serveur d'envoi en ligne sur http://localhost:${PORT}`);
  console.log(`   → POST /send-email               (cartes membres — PDF obligatoire)`);
  console.log(`   → POST /send-mailing              (mailing général — affiche optionnelle)`);
  console.log(`   → POST /send-email-facture        (factures)`);
  console.log(`   → POST /export-excel-rapports     (export + sauvegarde rapports)`);
  console.log(`   → POST /import-excel-rapports     (import rapports depuis Excel)`);
  console.log(`   → POST /export-excel-tickets      (export + sauvegarde tickets)`);
  console.log(`   → POST /import-excel-tickets      (import tickets depuis Excel)`);
  console.log(`   → POST /export-excel-membres      (export + sauvegarde membres)`);
  console.log(`   → POST /import-excel-membres      (import membres depuis Excel)`);
  console.log(`   → 📁 Sauvegardes dans : ${SAUVEGARDE_DIR}`);
});
