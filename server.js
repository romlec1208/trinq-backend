// server.js — VERSION CORRIGÉE ET COMPLÈTE

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');

const app = express();

// ============================================
// INITIALISATION DES CLIENTS
// ============================================
const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(
    process.env.SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_KEY // ⚠️ Utilise la SERVICE_KEY, pas l'ANON_KEY !
);

// ============================================
// CORS — Configuration explicite
// ============================================
const corsOptions = {
    origin: [
        'http://localhost:3000',
        'http://127.0.0.1:5500',  // Live Server VS Code
        'http://localhost:5500',
        'https://trinq.be',       // Ton domaine prod
        // Ajoute ici tous tes domaines frontend
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
};
app.use(cors(corsOptions));

// ============================================
// 🔴 WEBHOOK STRIPE
// IMPORTANT : Doit être déclaré AVANT express.json()
// ============================================
app.post(
    '/api/webhook', 
    express.raw({ type: 'application/json' }), // Raw body obligatoire pour Stripe
    async (req, res) => {
        
        // --- 1. VÉRIFICATION DE LA SIGNATURE STRIPE ---
        const sig = req.headers['stripe-signature'];
        let event;

        try {
            event = stripe.webhooks.constructEvent(
                req.body,                           // Body brut (Buffer)
                sig,                                // Signature Stripe
                process.env.STRIPE_WEBHOOK_SECRET   // Secret depuis le dashboard Stripe
            );
        } catch (err) {
            // Si la signature est invalide, on rejette
            console.error('❌ Signature Webhook invalide:', err.message);
            return res.status(400).json({ error: `Webhook Error: ${err.message}` });
        }

        // --- 2. TRAITEMENT DE L'ÉVÉNEMENT ---
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const customerEmail = session.customer_details?.email;

            console.log(`✅ Paiement confirmé pour : ${customerEmail}`);

            // --- 3. VÉRIFICATION EMAIL ---
            if (!customerEmail) {
                console.error('❌ Pas d\'email client dans la session Stripe');
                return res.status(200).json({ received: true }); // On répond 200 à Stripe quand même
            }

            // --- 4. GÉNÉRATION DU CODE VIP ---
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            let vipCode = 'TRINQ-';
            for (let i = 0; i < 4; i++) {
                vipCode += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            vipCode += '-';
            for (let i = 0; i < 4; i++) {
                vipCode += chars.charAt(Math.floor(Math.random() * chars.length));
            }

            console.log(`🔑 Code VIP généré : ${vipCode}`);

            // --- 5. INSERTION DANS SUPABASE ---
            const { data: insertData, error: insertError } = await supabase
                .from('vip_codes')
                .insert([{ 
                    code: vipCode, 
                    status: 'pending',
                    // Tu peux aussi stocker l'email pour le support :
                    // email: customerEmail 
                }])
                .select(); // .select() pour voir ce qui a été inséré

            if (insertError) {
                console.error('❌ Erreur Supabase INSERT:', insertError);
                // On NE renvoie PAS d'erreur à Stripe (sinon il va réessayer en boucle)
                // On log l'erreur et on continue quand même avec l'email
            } else {
                console.log('✅ Code sauvegardé en DB:', insertData);
            }

            // --- 6. ENVOI EMAIL VIA RESEND ---
            try {
                const emailResult = await resend.emails.send({
                    from: 'TRINQ <onboarding@resend.dev>',
                    to: customerEmail,
                    subject: '💎 Ton Pass VIP TRINQ est là !',
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                            <h2>Bienvenue dans le cercle VIP TRINQ ! 🍻</h2>
                            <p>Ton paiement a bien été reçu. Merci !</p>
                            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
                                <p style="font-size: 14px; color: #666;">Ton code d'activation unique :</p>
                                <strong style="font-size: 28px; letter-spacing: 4px; color: #000;">${vipCode}</strong>
                            </div>
                            <p><strong>Comment l'utiliser :</strong></p>
                            <ol>
                                <li>Ouvre TRINQ</li>
                                <li>Va dans le menu (☰)</li>
                                <li>Clique sur "J'ai déjà un code VIP"</li>
                                <li>Colle ce code</li>
                            </ol>
                            <p style="color: #999; font-size: 12px;">⚠️ Ce code est personnel et ne peut être activé que sur un seul appareil.</p>
                        </div>
                    `
                });
                console.log(`✅ Email envoyé à ${customerEmail}`, emailResult);
            } catch (emailError) {
                console.error('❌ Erreur envoi email:', emailError);
            }
        }

        // --- 7. RÉPONSE À STRIPE ---
        // TOUJOURS répondre 200 à Stripe pour éviter les retentatives
        res.status(200).json({ received: true });
    }
);

// ============================================
// EXPRESS.JSON — Déclaré APRÈS le webhook
// ============================================
app.use(express.json());

// ============================================
// ROUTE : Test serveur
// ============================================
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Serveur TRINQ opérationnel 🍻',
        timestamp: new Date().toISOString()
    });
});

// ============================================
// ROUTE : Création session Stripe
// ============================================
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'eur',
                    product_data: { 
                        name: 'Pass VIP TRINQ 💎', 
                        description: 'Accès illimité aux fonctions pro.' 
                    },
                    unit_amount: 500, // 5.00 €
                },
                quantity: 1,
            }],
            mode: 'payment',
            // ⚠️ Remplace par tes vraies URLs en prod
            success_url: `${process.env.FRONTEND_URL || 'http://localhost:5500'}/?success=true`,
            cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:5500'}/?canceled=true`,
        });

        console.log(`💳 Session Stripe créée : ${session.id}`);
        res.json({ url: session.url });

    } catch (error) {
        console.error('❌ Erreur Stripe:', error);
        res.status(500).json({ error: 'Erreur lors de la création du paiement.' });
    }
});

// ============================================
// ROUTE : Vérification et activation du code VIP
// ============================================
app.post('/api/verify-vip', async (req, res) => {
    const { code } = req.body;

    // --- Validation basique ---
    if (!code || typeof code !== 'string') {
        return res.status(400).json({ 
            success: false, 
            message: 'Aucun code fourni.' 
        });
    }

    // Nettoyage du code (espaces, majuscules)
    const cleanCode = code.trim().toUpperCase();

    console.log(`🔍 Vérification du code : "${cleanCode}"`);

    try {
        // --- Recherche en DB ---
        const { data, error } = await supabase
            .from('vip_codes')
            .select('*')
            .eq('code', cleanCode)
            .single();

        // Log pour déboguer
        console.log('Résultat Supabase - data:', data, '| error:', error);

        // --- Gestion des erreurs Supabase ---
        if (error) {
            // "PGRST116" = aucune ligne trouvée (normal si code invalide)
            if (error.code === 'PGRST116') {
                return res.status(404).json({ 
                    success: false, 
                    message: 'Code invalide ou introuvable.' 
                });
            }
            // Autre erreur DB
            throw error;
        }

        if (!data) {
            return res.status(404).json({ 
                success: false, 
                message: 'Code invalide ou introuvable.' 
            });
        }

        // --- Vérification du statut ---
        if (data.status === 'active') {
            return res.status(400).json({ 
                success: false, 
                message: 'Ce code a déjà été utilisé sur un autre appareil.' 
            });
        }

        if (data.status === 'revoked') {
            return res.status(400).json({ 
                success: false, 
                message: 'Ce code a été révoqué (remboursement).' 
            });
        }

        // --- Activation ! ---
        const { error: updateError } = await supabase
            .from('vip_codes')
            .update({ status: 'active' })
            .eq('code', cleanCode);

        if (updateError) throw updateError;

        console.log(`🎉 Code ${cleanCode} activé avec succès !`);
        res.status(200).json({ 
            success: true, 
            message: 'Pass VIP activé avec succès ! Bienvenue dans le club 🥂' 
        });

    } catch (err) {
        console.error('❌ Erreur vérification VIP:', err);
        res.status(500).json({ 
            success: false, 
            message: 'Erreur du serveur. Réessaie dans un moment.' 
        });
    }
});

// ============================================
// DÉMARRAGE
// ============================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, ...);
    console.log(`🚀 Serveur TRINQ démarré sur le port ${PORT}`);
    console.log(`📋 Variables d'env détectées :`);
    console.log(`   - SUPABASE_URL: ${process.env.SUPABASE_URL ? '✅' : '❌ MANQUANTE'}`);
    console.log(`   - SUPABASE_SERVICE_KEY: ${process.env.SUPABASE_SERVICE_KEY ? '✅' : '❌ MANQUANTE'}`);
    console.log(`   - STRIPE_SECRET_KEY: ${process.env.STRIPE_SECRET_KEY ? '✅' : '❌ MANQUANTE'}`);
    console.log(`   - STRIPE_WEBHOOK_SECRET: ${process.env.STRIPE_WEBHOOK_SECRET ? '✅' : '❌ MANQUANTE'}`);
    console.log(`   - RESEND_API_KEY: ${process.env.RESEND_API_KEY ? '✅' : '❌ MANQUANTE'}`);
});

// ROUTE DE DEBUG — À SUPPRIMER APRÈS TEST
app.get('/api/debug-db', async (req, res) => {
    try {
        const { data, error, count } = await supabase
            .from('vip_codes')
            .select('*', { count: 'exact' });
        
        res.json({ 
            success: !error,
            count: count,
            error: error,
            sample: data?.slice(0, 3) // 3 premiers codes (masqués en prod !)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
