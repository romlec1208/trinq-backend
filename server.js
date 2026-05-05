require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend'); // On invite le facteur

const app = express();

// On donne les clés au facteur et à la base de données
const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

app.use(cors());

// ==========================================
// 🔴 LE WEBHOOK STRIPE (La ligne rouge)
// ==========================================
// Stripe a besoin d'un format de texte brut spécial pour communiquer
app.post('/api/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const event = JSON.parse(req.body);

    // Si Stripe nous confirme que le paiement est réussi...
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const customerEmail = session.customer_details.email; // L'email tapé par l'acheteur

        if (customerEmail) {
            // 1. On génère un code VIP unique
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            let vipCode = 'TRINQ-';
            for (let i = 0; i < 4; i++) vipCode += chars.charAt(Math.floor(Math.random() * chars.length));
            vipCode += '-';
            for (let i = 0; i < 4; i++) vipCode += chars.charAt(Math.floor(Math.random() * chars.length));

            console.log(`Paiement reçu ! Création du code ${vipCode}...`);

            // 2. On sauvegarde le code dans Supabase (dans la table vip_codes)
            const { error } = await supabase
                .from('vip_codes')
                .insert([{ code: vipCode, status: 'pending' }]);

            if (error) console.error("Erreur de sauvegarde Supabase :", error);

            // 3. On envoie l'email magique
            try {
                await resend.emails.send({
                    from: 'TRINQ <onboarding@resend.dev>', // C'est l'adresse de test par défaut de Resend
                    to: customerEmail,
                    subject: '💎 Ton Pass VIP TRINQ est là !',
                    html: `<h2>Bienvenue dans le cercle très fermé des VIP TRINQ ! 🍻</h2>
                           <p>Ton paiement a bien été reçu.</p>
                           <p>Voici ton code unique d'activation : <strong>${vipCode}</strong></p>
                           <p>Ouvre TRINQ, va dans le menu, clique sur "J'ai déjà un code VIP" et colle ce code.</p>`
                });
                console.log(`✅ Succès ! Email envoyé à ${customerEmail}`);
            } catch (emailError) {
                console.error("Erreur lors de l'envoi de l'email :", emailError);
            }
        }
    }
    
    // On dit à Stripe "C'est bon, j'ai bien reçu ton appel !"
    res.json({received: true}); 
});

// ==========================================
// 🟢 LE RESTE DU SERVEUR
// ==========================================
// Pour le reste du site, on lit les données normalement
app.use(express.json());

app.get('/', (req, res) => {
    res.send("Salut ! Le moteur de TRINQ tourne parfaitement 🍻");
});

app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'eur',
                    product_data: { name: 'Pass VIP TRINQ 💎', description: 'Accès illimité aux fonctions pro.' },
                    unit_amount: 500, // 5.00 €
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: 'http://localhost:3000/?success=true',
            cancel_url: 'http://localhost:3000/?canceled=true',
        });
        res.json({ url: session.url });
    } catch (error) {
        console.error("Erreur Stripe:", error);
        res.status(500).json({ error: "Erreur lors de la création du paiement." });
    }
});

// --- ROUTE POUR VÉRIFIER ET ACTIVER LE CODE VIP ---
app.post('/api/verify-vip', async (req, res) => {
    const { code } = req.body;
    
    if (!code) {
        return res.status(400).json({ success: false, message: "Aucun code fourni." });
    }

    try {
        // 1. Chercher le code dans la base de données
        const { data, error } = await supabase
            .from('vip_codes')
            .select('*')
            .eq('code', code)
            .single();

        // 2. Vérifications
        if (error || !data) {
            return res.status(404).json({ success: false, message: "Code invalide ou introuvable." });
        }
        if (data.status === 'active') {
            return res.status(400).json({ success: false, message: "Ce code a déjà été utilisé sur un autre appareil." });
        }
        if (data.status === 'revoked') {
            return res.status(400).json({ success: false, message: "Ce code a été révoqué (remboursement)." });
        }

        // 3. Si tout est bon, on l'active !
        const { error: updateError } = await supabase
            .from('vip_codes')
            .update({ status: 'active' })
            .eq('code', code);

        if (updateError) throw updateError;

        res.json({ success: true, message: "Pass VIP activé avec succès ! Bienvenue !" });

    } catch (err) {
        console.error("Erreur vérification VIP :", err);
        res.status(500).json({ success: false, message: "Erreur du serveur." });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur TRINQ démarré sur http://localhost:${PORT}`);
});