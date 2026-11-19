const { createClient } = require('@supabase/supabase-js');

/* Import du fichier "Orientation Établissement" (retour des résultats BEF).
   Les colonnes sont lues par POSITION par le client (K=BEF, L=vœux, M=Moy Adm, N=Orientations)
   et envoyées ici déjà nettoyées. Ce fichier ne recalcule JAMAIS la Note BEF ni la Moyenne
   d'admission : il se contente de les enregistrer sur la fiche élève, uniquement pour les
   élèves de 9e. La Moyenne générale annuelle du bulletin continue d'être (T1+T2+T3)/3,
   indépendamment de ces deux valeurs.
   Réservé Administrateur + Directeur — revérifié ICI, côté serveur. */

function normMatricule(m){ return String(m || '').trim().toLowerCase(); }
var VOEUX_VALIDES = ['LG', 'LT'];
var ORIENTATIONS_VALIDES = ['LG', 'LT', 'RED', 'Abandon'];

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

  const body = req.body || {};
  const lignes = Array.isArray(body.lignes) ? body.lignes : [];
  if (!lignes.length) { res.status(400).json({ error: 'Aucune ligne à importer.' }); return; }
  if (lignes.length > 1000) { res.status(400).json({ error: 'Lot trop volumineux (max 1000 lignes par envoi).' }); return; }

  const { data: row, error: readErr } = await adminClient
    .from('notaschool_data').select('payload').eq('school_key', 'main').maybeSingle();
  if (readErr) { res.status(500).json({ error: 'Erreur lecture des données : ' + readErr.message }); return; }

  const payload = row && row.payload ? row.payload : {};
  const classes = Array.isArray(payload.classes) ? payload.classes : [];
  const eleves = Array.isArray(payload.eleves) ? payload.eleves.slice() : [];

  const classeIds9e = new Set(classes.filter(function(c){ return c.niveau === '9e'; }).map(function(c){ return c.id; }));
  const eleveParMatricule = {};
  eleves.forEach(function(e){ eleveParMatricule[normMatricule(e.matricule)] = e; });

  const importes = [];
  const ignores = [];
  const erreurs = [];

  lignes.forEach(function(l, idx){
    const matricule = String(l.matricule || '').trim();
    const matNorm = normMatricule(matricule);
    const ligneNum = l.ligne || (idx + 2);

    if (!matricule) { erreurs.push({ ligne: ligneNum, matricule: '', raison: 'Matricule manquant.' }); return; }
    const eleve = eleveParMatricule[matNorm];
    if (!eleve) { ignores.push({ ligne: ligneNum, matricule: matricule, raison: 'Matricule inconnu.' }); return; }
    if (!classeIds9e.has(eleve.classeId)) { ignores.push({ ligne: ligneNum, matricule: matricule, raison: 'Élève non en 9e.' }); return; }

    const noteBEF = l.noteBEF === '' || l.noteBEF === null || l.noteBEF === undefined ? null : parseFloat(String(l.noteBEF).replace(',', '.'));
    const moyenneAdmission = l.moyenneAdmission === '' || l.moyenneAdmission === null || l.moyenneAdmission === undefined ? null : parseFloat(String(l.moyenneAdmission).replace(',', '.'));
    const voeuFiliere = String(l.voeuFiliere || '').trim();
    const orientationFinale = String(l.orientationFinale || '').trim();

    if (noteBEF !== null && (isNaN(noteBEF) || noteBEF < 0 || noteBEF > 20)) { erreurs.push({ ligne: ligneNum, matricule: matricule, raison: 'Note BEF invalide (doit être entre 0 et 20).' }); return; }
    if (moyenneAdmission !== null && (isNaN(moyenneAdmission) || moyenneAdmission < 0 || moyenneAdmission > 20)) { erreurs.push({ ligne: ligneNum, matricule: matricule, raison: 'Moyenne d\'admission invalide (doit être entre 0 et 20).' }); return; }
    if (voeuFiliere && VOEUX_VALIDES.indexOf(voeuFiliere.toUpperCase()) === -1) { erreurs.push({ ligne: ligneNum, matricule: matricule, raison: 'Vœu invalide (doit être LG ou LT).' }); return; }
    if (orientationFinale && ORIENTATIONS_VALIDES.map(function(v){return v.toUpperCase();}).indexOf(orientationFinale.toUpperCase()) === -1) { erreurs.push({ ligne: ligneNum, matricule: matricule, raison: 'Orientation invalide (doit être LG, LT, RED ou Abandon).' }); return; }

    if (noteBEF !== null) eleve.noteBEF = noteBEF;
    if (moyenneAdmission !== null) eleve.moyenneAdmission = moyenneAdmission;
    if (voeuFiliere) eleve.voeuFiliere = voeuFiliere.toUpperCase();
    if (orientationFinale) eleve.orientationFinale = orientationFinale;

    importes.push({ ligne: ligneNum, matricule: matricule });
  });

  if (importes.length) {
    const nouveauPayload = Object.assign({}, payload, { eleves: eleves });
    const { error: writeErr } = await adminClient
      .from('notaschool_data')
      .upsert({ school_key: 'main', payload: nouveauPayload, updated_at: new Date().toISOString() }, { onConflict: 'school_key' });
    if (writeErr) { res.status(500).json({ error: 'Erreur enregistrement : ' + writeErr.message }); return; }
  }

  res.status(200).json({ ok: true, totalLignes: lignes.length, importes: importes.length, ignores: ignores, erreurs: erreurs });
};
