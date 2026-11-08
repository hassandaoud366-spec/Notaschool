// Notaschool - Création sécurisée des comptes utilisateurs
// Administrateur uniquement.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

const ROLES_VALIDES = [
  'admin',
  'directeur',
  'enseignant',
  'secretaire'
];

const IDENTIFIANT_DOMAIN = '@notaschool.internal';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Méthode non autorisée.'
    });
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
    return res.status(500).json({
      error: 'Configuration serveur incomplète.'
    });
  }

  try {
    // 1. Vérification de la session de l'administrateur

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : '';

    if (!token) {
      return res.status(401).json({
        error: 'Authentification requise.'
      });
    }

    const clientOptions = {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    };

    const anonClient = createClient(
      SUPABASE_URL,
      ANON_KEY,
      clientOptions
    );

    const { data: callerData, error: callerErr } =
      await anonClient.auth.getUser(token);

    if (callerErr || !callerData?.user) {
      return res.status(401).json({
        error: 'Session invalide. Veuillez vous reconnecter.'
      });
    }

    const callerId = callerData.user.id;

    // 2. Client administrateur sécurisé

    const adminClient = createClient(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      clientOptions
    );

    // 3. Vérification du profil de l'administrateur

    const { data: callerProfile, error: profileErr } =
      await adminClient
        .from('profiles')
        .select('role, actif, active, school_id')
        .eq('id', callerId)
        .maybeSingle();

    if (
      profileErr ||
      !callerProfile ||
      callerProfile.role !== 'admin' ||
      callerProfile.actif !== true ||
      callerProfile.active !== true
    ) {
      return res.status(403).json({
        error: 'Accès réservé aux administrateurs actifs.'
      });
    }

    // 4. Lecture des données reçues

    const body = typeof req.body === 'string'
      ? JSON.parse(req.body || '{}')
      : (req.body || {});

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({
        error: 'Données invalides.'
      });
    }

    const identifiant = String(body.identifiant || '')
      .trim()
      .toLowerCase();

    const password = typeof body.password === 'string'
      ? body.password
      : '';

    const role = String(body.role || '').trim();

    const nomComplet = String(
      body.nomComplet || body.full_name || ''
    ).trim();

    // 5. Validation des données

    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(identifiant)) {
      return res.status(400).json({
        error: 'Identifiant invalide.'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: 'Le mot de passe doit contenir au moins 6 caractères.'
      });
    }

    if (!ROLES_VALIDES.includes(role)) {
      return res.status(400).json({
        error: 'Rôle invalide.'
      });
    }

    if (!nomComplet) {
      return res.status(400).json({
        error: 'Le nom complet est obligatoire.'
      });
    }

    // 6. Création de l'adresse interne

    const email = identifiant + IDENTIFIANT_DOMAIN;

    // 7. Création du compte dans Supabase Auth

    const { data: created, error: createErr } =
      await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          identifiant,
          full_name: nomComplet
        }
      });

    if (createErr || !created?.user?.id) {
      const message = createErr?.message || '';

      if (/already registered|already exists/i.test(message)) {
        return res.status(409).json({
          error: 'Cet identifiant est déjà utilisé.'
        });
      }

      console.error('Erreur création Auth:', message);

      return res.status(400).json({
        error: 'Impossible de créer le compte utilisateur.'
      });
    }

    // CORRECTION : récupération du véritable UUID Supabase

    const newUserId = created.user.id;

    // 8. Création du profil dans la table profiles

    const { error: insertErr } = await adminClient
      .from('profiles')
      .insert({
        id: newUserId,
        school_id: callerProfile.school_id,
        identifiant,
        email,
        role,
        full_name: nomComplet,
        actif: true,
        active: true,
        must_change_password: true
      });

    // 9. Annulation si le profil n'a pas été créé

    if (insertErr) {
      console.error('Erreur insertion profil:', insertErr);

      const { error: deleteErr } =
        await adminClient.auth.admin.deleteUser(newUserId);

      if (deleteErr) {
        console.error('Erreur suppression compte Auth:', deleteErr);
      }

      return res.status(400).json({
        error: 'Création du profil impossible. Vérifiez les données.'
      });
    }

    // 10. Confirmation de création

    return res.status(201).json({
      ok: true,
      id: newUserId,
      identifiant,
      role,
      full_name: nomComplet,
      must_change_password: true
    });

  } catch (err) {
    console.error('Erreur admin-create-user:', err);

    return res.status(500).json({
      error: 'Une erreur interne est survenue.'
    });
  }
};
