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

// 1. STRIPE WEBHOOK (Doit impérativement être AVANT express.json)
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Signature invalide:', err.message);
        return res.status(400).json({ error: err.message });
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const customerEmail = session.customer_details?.email;

        if (customerEmail) {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            let vipCode = 'TRINQ-';
            for (let i = 0; i < 4; i++) vipCode += chars.charAt(Math.floor(Math.random() * chars.length));
            vipCode += '-';
            for (let i = 0; i < 4; i++) vipCode += chars.charAt(Math.floor(Math.random() * chars.length));

            const { error } = await supabase.from('vip_codes').insert([{ code: vipCode, status: 'pending' }]);
            if (error) console.error('Erreur Supabase:', error);

            try {
                await resend.emails.send({
                    from: 'TRINQ <onboarding@resend.dev>',
                    to: customerEmail,
                    subject: '💎 Ton Pass VIP TRINQ est là !',
                    html: `<h2>Bienvenue ! 🍻</h2><p>Ton code : <strong>${vipCode}</strong></p>`
                });
            } catch (e) {
                console.error('Erreur email:', e);
            }
        }
    }
    res.status(200).json({ received: true });
});

// 2. PARSER JSON (Pour toutes les autres routes : Auth, VIP, etc.)
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'ok', message: 'Serveur TRINQ 🍻' }));

// --- CREATION DE COMPTE (INSCRIPTION) ---
app.post('/api/register', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email requis.' });

    try {
        // Vérifie si déjà inscrit
        const { data: existing } = await supabase.from('users').select('id').eq('email', email).single();
        if (existing) return res.status(400).json({ success: false, message: 'Email déjà utilisé.' });

        // Génère un code à 6 chiffres
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // Expire dans 15 min

        // Crée l'utilisateur
        const { error } = await supabase.from('users').insert({
            email,
            login_code: code,
            login_code_expires: expires
        });

        if (error) throw error;

        // Envoie le code par email
        await resend.emails.send({
            from: 'TRINQ <onboarding@resend.dev>',
            to: email, // ⚠️ DOIT ÊTRE TON EMAIL POUR QUE ÇA MARCHE EN MODE TEST
            subject: 'Ton code de connexion TRINQ 🍺',
            html: `<h2>Bienvenue sur TRINQ !</h2><p>Ton code : <strong style="font-size:32px;">${code}</strong></p><p>Valable 15 minutes.</p>`
        });

        res.json({ success: true, message: 'Code envoyé par email !' });
    } catch (err) {
        console.error("Erreur register:", err);
        res.status(500).json({ success: false, message: 'Erreur lors de l\'inscription.' });
    }
});

// --- CONNEXION (ENVOI DU CODE) ---
app.post('/api/login', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email requis.' });

    try {
        const { data: user } = await supabase.from('users').select('id').eq('email', email).single();
        if (!user) return res.status(404).json({ success: false, message: 'Compte introuvable.' });

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();

        await supabase.from('users').update({ login_code: code, login_code_expires: expires }).eq('email', email);

        await resend.emails.send({
            from: 'TRINQ <onboarding@resend.dev>',
            to: email, // ⚠️ DOIT ÊTRE TON EMAIL POUR QUE ÇA MARCHE EN MODE TEST
            subject: 'Connexion TRINQ 🍺',
            html: `<h2>Rebonjour !</h2><p>Ton code de connexion : <strong style="font-size:32px;">${code}</strong></p>`
        });

        res.json({ success: true, message: 'Code envoyé par email !' });
    } catch (err) {
        console.error("Erreur login:", err);
        res.status(500).json({ success: false, message: 'Erreur lors de la connexion.' });
    }
});

// --- VÉRIFICATION DU CODE A 6 CHIFFRES ---
app.post('/api/verify-login', async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ success: false, message: 'Données manquantes.' });

    try {
        const { data: user } = await supabase.from('users').select('*').eq('email', email).eq('login_code', code).single();

        if (!user) return res.status(401).json({ success: false, message: 'Code incorrect.' });
        if (new Date(user.login_code_expires) < new Date()) return res.status(401).json({ success: false, message: 'Code expiré. Recommence.' });

        // Invalide le code après utilisation
        await supabase.from('users').update({ login_code: null, login_code_expires: null }).eq('email', email);

        res.json({ success: true, message: 'Connecté !', user: { id: user.id, email: user.email, is_vip: user.is_vip } });
    } catch (err) {
        console.error("Erreur verify-login:", err);
        res.status(500).json({ success: false, message: 'Erreur serveur.' });
    }
});

// --- PAIEMENT STRIPE VIP ---
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price_data: { currency: 'eur', product_data: { name: 'Pass VIP TRINQ 💎' }, unit_amount: 500 }, quantity: 1 }],
            mode: 'payment',
            success_url: 'https://melodic-creponne-95434f.netlify.app/?success=true',
            cancel_url: 'https://melodic-creponne-95434f.netlify.app/?canceled=true',
        });
        res.json({ url: session.url });
    } catch (error) {
        console.error('Erreur Stripe:', error);
        res.status(500).json({ error: 'Erreur paiement.' });
    }
});

// --- VERIFICATION DU CODE VIP TRINQ-XXXX ---
app.post('/api/verify-vip', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'Aucun code fourni.' });
    const cleanCode = code.trim().toUpperCase();

    try {
        const { data, error } = await supabase.from('vip_codes').select('*').eq('code', cleanCode).single();

        if (error || !data) return res.status(404).json({ success: false, message: 'Code invalide ou introuvable.' });
        if (data.status === 'active') return res.status(400).json({ success: false, message: 'Code déjà utilisé.' });
        if (data.status === 'revoked') return res.status(400).json({ success: false, message: 'Code révoqué.' });

        await supabase.from('vip_codes').update({ status: 'active' }).eq('code', cleanCode);
        res.json({ success: true, message: 'Pass VIP activé ! 🥂' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erreur serveur.' });
    }
});

// --- AUTHENTIFICATION UNIQUE (MAGIC CODE) ---
app.post('/api/auth', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email requis.' });
    try {
        let { data: user } = await supabase.from('users').select('id').eq('email', email).single();
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();

        if (!user) await supabase.from('users').insert({ email, login_code: code, login_code_expires: expires });
        else await supabase.from('users').update({ login_code: code, login_code_expires: expires }).eq('email', email);

        await resend.emails.send({
            from: 'TRINQ <onboarding@resend.dev>',
            to: email, // Doit être ton email si Resend non validé
            subject: 'Code Connexion TRINQ 🍺',
            html: `<h2>Connexion TRINQ</h2><p>Ton code secret : <strong style="font-size:32px;">${code}</strong></p>`
        });
        res.json({ success: true, message: 'Code envoyé !' });
    } catch (err) { res.status(500).json({ success: false }); }
});

// --- SET USERNAME ---
app.post('/api/set-username', async (req, res) => {
    const { email, username } = req.body;
    try {
        await supabase.from('users').update({ username }).eq('email', email);
        res.json({ success: true, username });
    } catch (err) { res.status(500).json({ success: false }); }
});

// --- LEADERBOARD ---
app.get('/api/leaderboard', async (req, res) => {
    try {
        const { data } = await supabase.from('users').select('username, score, is_vip').not('username', 'is', null).order('score', { ascending: false }).limit(10);
        res.json({ success: true, leaderboard: data });
    } catch (err) { res.status(500).json({ success: false }); }
});

// --- AJOUTER DES POINTS ---
app.post('/api/add-score', async (req, res) => {
    const { email, points } = req.body;
    try {
        const { data } = await supabase.from('users').select('score').eq('email', email).single();
        if (data) await supabase.from('users').update({ score: (data.score || 0) + points }).eq('email', email);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Serveur TRINQ démarré sur le port ${PORT}`));