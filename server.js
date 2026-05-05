require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'ok', message: 'Serveur TRINQ 🍻' }));

// --- INSCRIPTION ---
app.post('/api/register', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email requis.' });

    // Vérifie si déjà inscrit
    const { data: existing } = await supabase
        .from('users')
        .select('id')
        .eq('email', email)
        .single();

    if (existing) return res.status(400).json({ success: false, message: 'Email déjà utilisé.' });

    // Génère un code à 6 chiffres
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min

    // Crée l'utilisateur
    const { error } = await supabase.from('users').insert({
        email,
        login_code: code,
        login_code_expires: expires
    });

    if (error) return res.status(500).json({ success: false, message: 'Erreur serveur.' });

    // Envoie le code par email
    await resend.emails.send({
        from: 'TRINQ <onboarding@resend.dev>',
        to: email,
        subject: 'Ton code de connexion TRINQ 🍺',
        html: `<h2>Bienvenue sur TRINQ !</h2><p>Ton code : <strong style="font-size:32px;">${code}</strong></p><p>Valable 15 minutes.</p>`
    });

    res.json({ success: true, message: 'Code envoyé par email !' });
});

// --- CONNEXION ---
app.post('/api/login', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email requis.' });

    const { data: user } = await supabase
        .from('users')
        .select('id')
        .eq('email', email)
        .single();

    if (!user) return res.status(404).json({ success: false, message: 'Compte introuvable.' });
    // ... reste du code
});

// --- VÉRIFICATION CODE ---
app.post('/api/verify-login', async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ success: false, message: 'Données manquantes.' });

    const { data: user } = await supabase
        .from('users')
        .select('*')
        .eq('email', email)
        .eq('login_code', code)
        .single();

    if (!user) return res.status(401).json({ success: false, message: 'Code incorrect.' });

    if (new Date(user.login_code_expires) < new Date()) {
        return res.status(401).json({ success: false, message: 'Code expiré. Recommence.' });
    }

    // Invalide le code après utilisation
    await supabase.from('users').update({
        login_code: null,
        login_code_expires: null
    }).eq('email', email);

    res.json({ success: true, message: 'Connecté !', user: { id: user.id, email: user.email, is_vip: user.is_vip } });
});

// --- VERIFY VIP ---
app.post('/api/verify-vip', async (req, res) => {
    const { code, deviceId } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'Code manquant.' });

    const { data: vipCode, error } = await supabase
        .from('vip_codes')
        .select('*')
        .eq('code', code.toUpperCase())
        .single();

    if (error || !vipCode) return res.status(404).json({ success: false, message: 'Code invalide.' });
    if (vipCode.is_used) return res.status(403).json({ success: false, message: 'Code déjà utilisé.' });

    await supabase.from('vip_codes').update({
        is_used: true,
        used_at: new Date().toISOString(),
        device_id: deviceId
    }).eq('code', code.toUpperCase());

    res.json({ success: true, message: 'Pass VIP activé ! 🥂' });
});

// --- STRIPE ---
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price_data: { currency: 'eur', product_data: { name: 'Pass VIP TRINQ 💎' }, unit_amount: 500 }, quantity: 1 }],
            mode: 'payment',
            success_url: 'https://trinq.be?vip=success',
            cancel_url: 'https://trinq.be?vip=cancel',
        });
        res.json({ url: session.url });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erreur paiement.' });
    }
});

// --- DEBUG ---
app.get('/api/debug-db', async (req, res) => {
    const { data, error } = await supabase.from('vip_codes').select('*');
    res.json({ success: !error, count: data?.length, error, sample: data?.slice(0, 3) });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Serveur TRINQ démarré sur le port ${PORT}`));
