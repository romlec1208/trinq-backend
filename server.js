const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

app.use(cors());

// WEBHOOK STRIPE — AVANT express.json()
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
                console.log('Email envoyé à', customerEmail);
            } catch (e) {
                console.error('Erreur email:', e);
            }
        }
    }

    res.status(200).json({ received: true });
});

app.use(express.json());

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Serveur TRINQ 🍻' });
});

app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price_data: { currency: 'eur', product_data: { name: 'Pass VIP TRINQ 💎' }, unit_amount: 500 }, quantity: 1 }],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL || 'http://localhost:5500'}/?success=true`,
            cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:5500'}/?canceled=true`,
        });
        res.json({ url: session.url });
    } catch (error) {
        console.error('Erreur Stripe:', error);
        res.status(500).json({ error: 'Erreur paiement.' });
    }
});

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

app.get('/api/debug-db', async (req, res) => {
    const { data, error } = await supabase.from('vip_codes').select('*');
    res.json({ success: !error, count: data?.length, error, sample: data?.slice(0, 3) });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Serveur TRINQ démarré sur le port ${PORT}`));
