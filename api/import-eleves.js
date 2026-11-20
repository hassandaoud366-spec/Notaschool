const { createClient } = require('@supabase/supabase-js');

/* Import massif d'élèves (Excel/CSV) — réservé Administrateur + Directeur.
   Sécurité : le rôle de l'appelant est revérifié ICI, côté serveur, via son
   jeton Supabase + la table profiles — pas seulement masqué dans l'interface.
   Les données élèves/classes de Notaschool sont stockées dans UNE seule ligne
   JSON (table notaschool_data, clé 'main'). Cette fonction lit cette ligne,
   fusionne les nouveaux élèves validés dedans (sans toucher au reste : notes,
   absences, conseils, établissement...), puis réécrit la ligne via service_role. */

function normMatricule(m){ return String(m || '').trim().toLowerCase(); }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
    res.status(500).json({ error: 'Configuration serveur manquante (variables d\'environnement Supabase).' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: 'Authentification requise.' });
    return;
  }

  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: callerData, error: callerErr } = await anonClient.auth.getUser(token);
  if (callerErr || !callerData || !callerData.user) {
    res.status(401).json({ error: 'Session invalide.' });
    return;
  }

  const { data: callerProfile, error: callerProfileErr } = await adminClient
    .from('profiles')
    .select('role, actif, etablissement_id')
    .eq('id', callerData.user.id)
    .maybeSingle();

  if (callerProfileErr) {
    res.status(500).json({ error: 'Erreur lecture profil : ' + callerProfileErr.message });
    return;
  }
  // Seule véritable protection : réservé Administrateur + Directeur, vérifié ici côté serveur.
  if (!callerProfile || (callerProfile.role !== 'admin' && callerProfile.role !== 'directeur') || !callerProfile.actif) {
    res.status(403).json({ error: 'Réservé aux administrateurs et directeurs.' });
    return;
  }

  const body = req.body || {};
  const lignes = Array.isArray(body.eleves) ? body.eleves : [];
  if (!lignes.length) {
    res.status(400).json({ error: 'Aucune ligne à importer.' });
    return;
  }
  if (lignes.length > 1000) {
    res.status(400).json({ error: 'Lot trop volumineux (max 1000 lignes par envoi, l\'application découpe automatiquement les gros fichiers).' });
    return;
  }

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

  // Lecture de la ligne unique de données (lecture-fusion-écriture, service_role = pas de RLS).
  const { data: row, error: readErr } = await adminClient
    .from('notaschool_data')
    .select('payload')
    .eq('school_key', etablissementId)
    .maybeSingle();

  if (readErr) {
    res.status(500).json({ error: 'Erreur lecture des données : ' + readErr.message });
    return;
  }

  const safePayload = row && row.payload ? row.payload : {};
  const classes = Array.isArray(safePayload.classes) ? safePayload.classes : [];
  const eleves = Array.isArray(safePayload.eleves) ? safePayload.eleves.slice() : [];

  const classeIdsValides = new Set(classes.map(function (c) { return c.id; }));
  const matriculesExistants = new Set(eleves.map(function (e) { return normMatricule(e.matricule); }));

  const importes = [];
  const rejetes = [];

  lignes.forEach(function (l, idx) {
    const nom = String(l.nom || '').trim();
    const prenom = String(l.prenom || '').trim();
    const matricule = String(l.matricule || '').trim();
    const classeId = String(l.classeId || '').trim();
    const sexe = String(l.sexe || '').trim().toUpperCase();
    const dateNaissance = String(l.dateNaissance || '').trim();
    const matNorm = normMatricule(matricule);

    if (!nom || !prenom || !matricule || !classeId) {
      rejetes.push({ ligne: idx + 1, matricule: matricule, raison: 'Champ obligatoire manquant (nom, prénom, matricule ou classe).' });
      return;
    }
    if (!classeIdsValides.has(classeId)) {
      rejetes.push({ ligne: idx + 1, matricule: matricule, raison: 'Classe introuvable côté serveur.' });
      return;
    }
    if (matriculesExistants.has(matNorm)) {
      rejetes.push({ ligne: idx + 1, matricule: matricule, raison: 'Matricule déjà utilisé (doublon).' });
      return;
    }

    const nouvEleve = {
      id: 'imp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10),
      classeId: classeId,
      nom: nom,
      prenom: prenom,
      sexe: (sexe === 'M' || sexe === 'F') ? sexe : '',
      dateNaissance: dateNaissance,
      matricule: matricule,
      photo: ''
    };
    eleves.push(nouvEleve);
    matriculesExistants.add(matNorm);
    importes.push(nouvEleve);
  });

  if (importes.length) {
    const nouveauPayload = Object.assign({}, safePayload, { eleves: eleves });
    const { error: writeErr } = await adminClient
      .from('notaschool_data')
      .upsert({ school_key: etablissementId, payload: nouveauPayload, updated_at: new Date().toISOString() }, { onConflict: 'school_key' });

    if (writeErr) {
      res.status(500).json({ error: 'Erreur enregistrement : ' + writeErr.message });
      return;
    }
  }

  res.status(200).json({
    ok: true,
    totalLignes: lignes.length,
    importes: importes.length,
    rejetes: rejetes
  });
};
