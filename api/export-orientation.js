const { createClient } = require('@supabase/supabase-js');
const ExcelJS = require('exceljs');

/* Génère le modèle "Orientation Établissement" (élèves de 9e), pré-rempli avec les
   colonnes A à J (identité + moyenne générale annuelle déjà calculée par Notaschool).
   Les colonnes K (BEF), L (vœux), M (Moy Adm) et N (Orientations) restent vides :
   elles ne sont JAMAIS calculées ici, uniquement importées plus tard.
   Réservé Administrateur + Directeur — revérifié ici, côté serveur. */

const HEADERS = [
  'Numero', 'Matricule', 'Nom', 'DN', 'Genre', 'Lieu de Naissance', 'Nationalite',
  'Etablissement', 'Classe', 'CONTROLE.CONTINU  coef: 1.00', 'BEF', 'vœux', 'Moy Adm', 'Orientations'
];
const COL_WIDTHS = { A:8.67, B:14.4, C:8.67, D:8.67, E:8.67, F:8.67, G:8.67, H:8.67, I:8.67, J:11.42, K:14.27, L:8.67, M:11.42, N:13.98 };
const GRAY = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF969696' } };
const THIN = { style: 'thin' };
const BORDER_ALL = { top: THIN, bottom: THIN, left: THIN, right: THIN };

function moyenneAnnuelleEleve(eleveId, matieresClasse, notes){
  // Moyenne générale annuelle = (T1+T2+T3)/3, calculée exactement comme sur le bulletin : jamais via BEF/Moy Adm.
  var tris = [1,2,3];
  var moyennesTri = tris.map(function(tri){
    var total = 0, poids = 0;
    matieresClasse.forEach(function(m){
      var cle = eleveId + '_' + m.id + '_' + tri;
      var entry = notes[cle];
      if(!entry || !Array.isArray(entry.valeurs)) return;
      var vals = entry.valeurs.filter(function(v){ return typeof v === 'number' && !isNaN(v); });
      if(!vals.length) return;
      var moyMatiere = vals.reduce(function(a,b){return a+b;},0) / vals.length;
      total += moyMatiere; poids += 1;
    });
    return poids ? total / poids : null;
  });
  var valides = moyennesTri.filter(function(v){ return v !== null; });
  if(!valides.length) return null;
  return valides.reduce(function(a,b){return a+b;},0) / valides.length;
}

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
    .from('profiles').select('role, actif').eq('id', callerData.user.id).maybeSingle();
  if (callerProfileErr) { res.status(500).json({ error: 'Erreur lecture profil : ' + callerProfileErr.message }); return; }
  if (!callerProfile || (callerProfile.role !== 'admin' && callerProfile.role !== 'directeur') || !callerProfile.actif) {
    res.status(403).json({ error: 'Réservé aux administrateurs et directeurs.' }); return;
  }

  const { data: row, error: readErr } = await adminClient
    .from('notaschool_data').select('payload').eq('school_key', 'main').maybeSingle();
  if (readErr) { res.status(500).json({ error: 'Erreur lecture des données : ' + readErr.message }); return; }

  const payload = row && row.payload ? row.payload : {};
  const school = payload.school || {};
  const classes = Array.isArray(payload.classes) ? payload.classes : [];
  const eleves = Array.isArray(payload.eleves) ? payload.eleves : [];
  const matieres = Array.isArray(payload.matieres) ? payload.matieres : [];
  const notes = payload.notes && typeof payload.notes === 'object' ? payload.notes : {};

  const classes9e = classes.filter(function(c){ return c.niveau === '9e'; });
  const classeIds9e = new Set(classes9e.map(function(c){ return c.id; }));
  const classeParId = {}; classes.forEach(function(c){ classeParId[c.id] = c; });
  const eleves9e = eleves.filter(function(e){ return classeIds9e.has(e.classeId); })
    .sort(function(a,b){ return ((a.nom||'')+(a.prenom||'')).localeCompare((b.nom||'')+(b.prenom||''), 'fr'); });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Etablissement');

  HEADERS.forEach(function(h, i){
    var cell = ws.getCell(1, i + 1);
    cell.value = h;
    cell.font = { name: 'Calibri', size: 12, bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'bottom', textRotation: (i === 9 ? 90 : 0) };
    cell.border = BORDER_ALL;
    if (i === 9 || i === 10 || i === 12) cell.fill = GRAY; // J, K, M
  });
  ws.getRow(1).height = 168;

  Object.keys(COL_WIDTHS).forEach(function(letter, i){ ws.getColumn(i + 1).width = COL_WIDTHS[letter]; });

  var ligne = 2;
  eleves9e.forEach(function(e, idx){
    var c = classeParId[e.classeId];
    var matieresClasse = matieres.filter(function(m){ return m.classeId === e.classeId; });
    var moyAnnuelle = moyenneAnnuelleEleve(e.id, matieresClasse, notes);
    var valeurs = [
      idx + 1,
      e.matricule || '',
      ((e.nom || '') + ' ' + (e.prenom || '')).trim(),
      e.dateNaissance || '',
      e.sexe || '',
      e.lieuNaissance || '',
      e.nationalite || '',
      school.nom || '',
      c ? c.nom : '',
      moyAnnuelle !== null ? Math.round(moyAnnuelle * 100) / 100 : '',
      e.noteBEF !== undefined && e.noteBEF !== null ? e.noteBEF : '',
      e.voeuFiliere || '',
      e.moyenneAdmission !== undefined && e.moyenneAdmission !== null ? e.moyenneAdmission : '',
      e.orientationFinale || ''
    ];
    valeurs.forEach(function(v, i){
      var cell = ws.getCell(ligne, i + 1);
      cell.value = v;
      cell.font = { name: 'Calibri', size: 12, bold: true };
      cell.border = BORDER_ALL;
      if (i === 9 || i === 10 || i === 12) cell.fill = GRAY;
    });
    ligne++;
  });
  // Lignes vides restantes jusqu'à 600, avec la même mise en forme (grille "prête à remplir").
  for (; ligne <= 601; ligne++) {
    for (var col = 1; col <= 14; col++) {
      var cell2 = ws.getCell(ligne, col);
      cell2.border = BORDER_ALL;
      cell2.font = { name: 'Calibri', size: 12, bold: true };
      if (col === 10 || col === 11 || col === 13) cell2.fill = GRAY;
    }
  }

  ws.autoFilter = 'A1:N601';
  ws.dataValidations.add('L2:L601', { type: 'list', allowBlank: true, formulae: ['"LG,LT"'], showErrorMessage: true, errorStyle: 'stop', errorTitle: 'Vœu', error: 'Choisir LG ou LT' });
  ws.dataValidations.add('N2:N601', { type: 'list', allowBlank: true, formulae: ['"LG,LT,RED,Abandon"'], showErrorMessage: true, errorStyle: 'stop', error: 'Choisir une valeur dans la liste' });
  ws.dataValidations.add('J2:K601', { type: 'decimal', allowBlank: true, operator: 'between', formulae: [0, 20], showErrorMessage: true, errorStyle: 'stop', error: 'Note entre 0 et 20' });
  ws.dataValidations.add('M2:M601', { type: 'decimal', allowBlank: true, operator: 'between', formulae: [0, 20], showErrorMessage: true, errorStyle: 'stop', error: 'Note entre 0 et 20' });

  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="Notaschool_modele_orientation.xlsx"');
  res.status(200).send(Buffer.from(buffer));
};
