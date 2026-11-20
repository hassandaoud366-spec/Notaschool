const { createClient } = require('@supabase/supabase-js');
const ExcelJS = require('exceljs');

/* Génère le modèle "Vœux 2nde" pour une classe de 2nde donnée (ou toutes),
   pré-rempli avec matricule/nom/prénom/classe, avec les listes déroulantes de séries
   (feuille "Listes") sur les colonnes Vœu 1 et Vœu 2.
   Réservé Administrateur + Directeur — revérifié ici, côté serveur. */

const HEADERS = ['Numero', 'Matricule', 'Nom', 'Prénom', 'Classe', 'Vœu 1', 'Vœu 2', 'Série retenue'];
const COL_WIDTHS = [8.96, 14.4, 23.99, 21.99, 9.99, 10.99, 8.67, 13.99];
const SERIES_DEFAUT = ['ES', 'L', 'S', 'SG-OGRH', 'SG-GFM', 'SG-IAG'];
const THIN = { style: 'thin' };
const BORDER_ALL = { top: THIN, bottom: THIN, left: THIN, right: THIN };
const FONT_BASE = { name: 'Calibri', size: 12, bold: true };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Méthode non autorisée.' }); return; }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
    res.status(500).json({ error: 'Configuration serveur manquante.' }); return;
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'Authentification requise.' }); return; }

  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: callerData, error: callerErr } = await anonClient.auth.getUser(token);
  if (callerErr || !callerData || !callerData.user) { res.status(401).json({ error: 'Session invalide.' }); return; }

  const { data: callerProfile, error: callerProfileErr } = await adminClient
    .from('profiles').select('role, actif, etablissement_id').eq('id', callerData.user.id).maybeSingle();
  if (callerProfileErr) { res.status(500).json({ error: 'Erreur lecture profil : ' + callerProfileErr.message }); return; }
  if (!callerProfile || (callerProfile.role !== 'admin' && callerProfile.role !== 'directeur') || !callerProfile.actif) {
    res.status(403).json({ error: 'Réservé aux administrateurs et directeurs.' }); return;
  }

  const body = req.body || {};
  const classeId = body.classeId === 'all' || !body.classeId ? null : String(body.classeId);

  // Établissement exporté : pour un directeur, toujours forcé à SON PROPRE
  // établissement (jamais déduit de ce que le client envoie) ; pour l'admin,
  // celui actuellement géré dans l'application, vérifié qu'il existe réellement.
  let etablissementId;
  if (callerProfile.role === 'directeur') {
    etablissementId = callerProfile.etablissement_id;
  } else {
    etablissementId = String(body.etablissementId || '').trim() || callerProfile.etablissement_id || 'main';
    const { data: etabExiste, error: etabErr } = await adminClient
      .from('etablissements').select('id').eq('id', etablissementId).maybeSingle();
    if (etabErr) { res.status(500).json({ error: 'Erreur vérification établissement : ' + etabErr.message }); return; }
    if (!etabExiste) { res.status(400).json({ error: 'Établissement invalide ou introuvable.' }); return; }
  }
  if (!etablissementId) { res.status(400).json({ error: 'Établissement introuvable.' }); return; }

  const { data: row, error: readErr } = await adminClient
    .from('notaschool_data').select('payload').eq('school_key', etablissementId).maybeSingle();
  if (readErr) { res.status(500).json({ error: 'Erreur lecture des données : ' + readErr.message }); return; }

  const payload = row && row.payload ? row.payload : {};
  const classes = Array.isArray(payload.classes) ? payload.classes : [];
  const eleves = Array.isArray(payload.eleves) ? payload.eleves : [];

  const classes2nde = classes.filter(function(c){ return c.niveau === '2nde' && (!classeId || c.id === classeId); });
  const classeIds = new Set(classes2nde.map(function(c){ return c.id; }));
  const classeParId = {}; classes.forEach(function(c){ classeParId[c.id] = c; });

  const eleves2nde = eleves.filter(function(e){ return classeIds.has(e.classeId); })
    .sort(function(a,b){ return ((a.nom||'')+(a.prenom||'')).localeCompare((b.nom||'')+(b.prenom||''), 'fr'); });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Voeux 2nde1');
  const wsListes = wb.addWorksheet('Listes');

  HEADERS.forEach(function(h, i){
    var cell = ws.getCell(1, i + 1);
    cell.value = h; cell.font = FONT_BASE; cell.alignment = { horizontal: 'center' }; cell.border = BORDER_ALL;
  });
  ws.getRow(1).height = 30;
  COL_WIDTHS.forEach(function(w, i){ ws.getColumn(i + 1).width = w; });

  var ligne = 2;
  eleves2nde.forEach(function(e, idx){
    var c = classeParId[e.classeId];
    var valeurs = [idx + 1, e.matricule || '', e.nom || '', e.prenom || '', c ? c.nom : '', e.voeu1 || '', e.voeu2 || ''];
    valeurs.forEach(function(v, i){
      var cell = ws.getCell(ligne, i + 1);
      cell.value = v; cell.font = FONT_BASE; cell.alignment = { horizontal: 'center' }; cell.border = BORDER_ALL;
    });
    var serieCell = ws.getCell(ligne, 8);
    serieCell.value = { formula: 'IF(G' + ligne + '<>"",G' + ligne + ',"")' };
    serieCell.font = FONT_BASE; serieCell.alignment = { horizontal: 'center' }; serieCell.border = BORDER_ALL;
    ws.getRow(ligne).height = 15.75;
    ligne++;
  });
  for (; ligne <= 81; ligne++) {
    for (var col = 1; col <= 8; col++) {
      var cell2 = ws.getCell(ligne, col);
      cell2.border = BORDER_ALL; cell2.font = FONT_BASE; cell2.alignment = { horizontal: 'center' };
      if (col === 8) cell2.value = { formula: 'IF(G' + ligne + '<>"",G' + ligne + ',"")' };
    }
  }

  ws.dataValidations.add('F2:G81', { type: 'list', allowBlank: true, formulae: ['Listes!$A$2:$A$20'], showErrorMessage: true, errorStyle: 'stop', errorTitle: 'Série', error: 'Choisir une série dans la liste' });

  wsListes.getCell('A1').value = 'Séries'; wsListes.getCell('A1').font = FONT_BASE;
  wsListes.getCell('C1').value = 'Ajoutez ou modifiez les séries dans la colonne A (lignes 2 à 20).';
  SERIES_DEFAUT.forEach(function(s, i){ wsListes.getCell('A' + (i + 2)).value = s; });
  wsListes.getColumn(1).width = 11.99;

  const buffer = await wb.xlsx.writeBuffer();
  const nomFichier = classeId && classeParId[classeId] ? ('Notaschool_modele_voeux_' + classeParId[classeId].nom.replace(/[^a-zA-Z0-9]/g, '_') + '.xlsx') : 'Notaschool_modele_voeux_2nde.xlsx';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="' + nomFichier + '"');
  res.status(200).send(Buffer.from(buffer));
};
