const { createClient } = require('@supabase/supabase-js');

/* Import du fichier "Vœux 2nde" : chaque élève a 2 vœux, c'est le Vœu 2 qui est retenu
   (si le Vœu 2 est vide, on utilise le Vœu 1). La série retenue est enregistrée sur la
   fiche élève. Rattachement par matricule.
   Réservé Administrateur + Directeur — revérifié ICI, côté serveur. */

function normMatricule(m){ return String(m || '').trim().toLowerCase(); }

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
  const lignes = Array.isArray(body.lignes) ? body.lignes : [];
  if (!lignes.length) { res.status(400).json({ error: 'Aucune ligne à importer.' }); return; }
  if (lignes.length > 1000) { res.status(400).json({ error: 'Lot trop volumineux (max 1000 lignes par envoi).' }); return; }

  // Établissement concerné : pour un directeur, toujours forcé à SON PROPRE
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
  const eleves = Array.isArray(payload.eleves) ? payload.eleves.slice() : [];
  const eleveParMatricule = {};
  eleves.forEach(function(e){ eleveParMatricule[normMatricule(e.matricule)] = e; });

  const importes = [];
  const ignores = [];

  lignes.forEach(function(l, idx){
    const matricule = String(l.matricule || '').trim();
    const matNorm = normMatricule(matricule);
    const ligneNum = l.ligne || (idx + 2);
    const voeu1 = String(l.voeu1 || '').trim();
    const voeu2 = String(l.voeu2 || '').trim();

    if (!matricule) { ignores.push({ ligne: ligneNum, matricule: '', raison: 'Matricule manquant.' }); return; }
    const eleve = eleveParMatricule[matNorm];
    if (!eleve) { ignores.push({ ligne: ligneNum, matricule: matricule, raison: 'Matricule inconnu.' }); return; }
    if (!voeu1 && !voeu2) { ignores.push({ ligne: ligneNum, matricule: matricule, raison: 'Aucun vœu renseigné.' }); return; }

    const serieRetenue = voeu2 || voeu1;
    eleve.voeu1 = voeu1;
    eleve.voeu2 = voeu2;
    eleve.serieRetenue = serieRetenue;

    importes.push({ ligne: ligneNum, matricule: matricule, serieRetenue: serieRetenue });
  });

  if (importes.length) {
    const nouveauPayload = Object.assign({}, payload, { eleves: eleves });
    const { error: writeErr } = await adminClient
      .from('notaschool_data')
      .upsert({ school_key: etablissementId, payload: nouveauPayload, updated_at: new Date().toISOString() }, { onConflict: 'school_key' });
    if (writeErr) { res.status(500).json({ error: 'Erreur enregistrement : ' + writeErr.message }); return; }
  }

  res.status(200).json({ ok: true, totalLignes: lignes.length, importes: importes.length, ignores: ignores });
};
