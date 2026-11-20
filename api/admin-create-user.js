const { createClient } = require('@supabase/supabase-js');

const ROLES_VALIDES = ['admin', 'directeur', 'enseignant', 'secretaire', 'surveillant'];
const ROLES_DIRECTEUR_PEUT_CREER = ['enseignant', 'secretaire', 'surveillant'];

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
  if (!callerProfile || (callerProfile.role !== 'admin' && callerProfile.role !== 'directeur') || !callerProfile.actif) {
    res.status(403).json({ error: 'Réservé aux administrateurs et directeurs.' });
    return;
  }

  const body = req.body || {};
  const identifiant = String(body.identifiant || '').trim();
  const password = String(body.password || '');
  const role = String(body.role || '');
  const nomComplet = String(body.nomComplet || '').trim();

  if (!/^[A-Za-z0-9_-]{3,32}$/.test(identifiant)) {
    res.status(400).json({ error: 'Identifiant invalide (3 à 32 caractères : lettres, chiffres, - ou _).' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
    return;
  }
  if (!ROLES_VALIDES.includes(role)) {
    res.status(400).json({ error: 'Rôle invalide.' });
    return;
  }
  if (callerProfile.role === 'directeur' && !ROLES_DIRECTEUR_PEUT_CREER.includes(role)) {
    res.status(403).json({ error: 'Un directeur ne peut créer que des comptes Enseignant, Secrétaire ou Surveillant.' });
    return;
  }

  // Établissement du nouveau compte : revérifié ici, côté serveur, et jamais déduit
  // tel quel de ce que le client envoie. Un directeur ne peut créer un compte que
  // dans SON PROPRE établissement, quoi qu'il envoie dans la requête — on ignore
  // body.etablissementId pour un directeur et on force sa propre valeur.
  // L'administrateur principal peut choisir l'établissement (celui qu'il gère
  // actuellement dans l'application), mais celui-ci doit exister réellement.
  let etablissementId;
  if (callerProfile.role === 'directeur') {
    etablissementId = callerProfile.etablissement_id;
  } else {
    etablissementId = String(body.etablissementId || '').trim() || callerProfile.etablissement_id || 'main';
    const { data: etabExiste, error: etabErr } = await adminClient
      .from('etablissements')
      .select('id')
      .eq('id', etablissementId)
      .maybeSingle();
    if (etabErr) {
      res.status(500).json({ error: 'Erreur vérification établissement : ' + etabErr.message });
      return;
    }
    if (!etabExiste) {
      res.status(400).json({ error: 'Établissement invalide ou introuvable.' });
      return;
    }
  }
  if (!etablissementId) {
    res.status(400).json({ error: 'Établissement introuvable pour ce compte.' });
    return;
  }

  const email = identifiant.toLowerCase() + '@notaschool.internal';

  const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { identifiant }
  });

  if (createErr || !created || !created.user) {
    res.status(400).json({ error: 'Création du compte impossible : ' + (createErr ? createErr.message : 'erreur inconnue') });
    return;
  }

  const newUserId = created.user.id;

  const { error: insertErr } = await adminClient.from('profiles').insert({
    id: newUserId,
    identifiant,
    role,
    full_name: nomComplet || identifiant,
    email,
    actif: true,
    active: true,
    etablissement_id: etablissementId
  });

  if (insertErr) {
    await adminClient.auth.admin.deleteUser(newUserId);
    res.status(400).json({ error: 'Profil non créé, opération annulée : ' + insertErr.message });
    return;
  }

  res.status(200).json({ ok: true, userId: newUserId, identifiant, role, etablissementId });
};
