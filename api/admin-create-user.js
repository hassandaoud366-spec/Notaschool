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
    .select('role, actif')
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
    active: true
  });

  if (insertErr) {
    await adminClient.auth.admin.deleteUser(newUserId);
    res.status(400).json({ error: 'Profil non créé, opération annulée : ' + insertErr.message });
    return;
  }

  res.status(200).json({ ok: true, userId: newUserId, identifiant, role });
};
