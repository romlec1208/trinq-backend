const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const { Resend } = require('resend');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: ['https://trinq.be', 'http://localhost:3000', 'https://melodic-creponne-95434f.netlify.app'],
        methods: ['GET', 'POST']
    }
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);


app.use(cors({ origin: ['https://trinq.be', 'https://melodic-creponne-95434f.netlify.app'] }));

/* =========================================
   ROOMS EN MÉMOIRE
   ========================================= */
const rooms = {};

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

/* =========================================
   SOCKET.IO — MULTIJOUEUR
   ========================================= */
io.on('connection', (socket) => {
    console.log('🔌 Connecté:', socket.id);

    // CRÉER UNE ROOM (hôte VIP uniquement)
    socket.on('create-room', ({ email, username }) => {
        let code;
        do { code = generateRoomCode(); } while (rooms[code]);

        rooms[code] = {
            host: socket.id,
            hostEmail: email,
            members: [{ socketId: socket.id, username: username || 'Hôte', email }],
            drinks: [],
            currentPlace: null,
            neverPhrase: null,
            createdAt: Date.now()
        };

        socket.join(code);
        socket.roomCode = code;
        socket.emit('room-created', { code, room: rooms[code] });
        console.log(`🏠 Room créée: ${code} par ${email}`);
    });

    // REJOINDRE UNE ROOM
    socket.on('join-room', ({ code, username, email }) => {
        const room = rooms[code];
        if (!room) {
            socket.emit('room-error', { message: 'Room introuvable. Vérifie le code.' });
            return;
        }

        room.members.push({ socketId: socket.id, username: username || 'Invité', email });
        socket.join(code);
        socket.roomCode = code;

        // Envoie l'état actuel au nouveau membre
        socket.emit('room-joined', { code, room });

        // Prévient tout le monde
        io.to(code).emit('member-joined', {
            username: username || 'Invité',
            members: room.members,
            drinks: room.drinks
        });

        console.log(`👤 ${username} a rejoint la room ${code}`);
    });

    // AJOUTER UNE BOISSON
    socket.on('add-drink', ({ code, drink }) => {
        const room = rooms[code];
        if (!room) return;

        room.drinks.push(drink);
        io.to(code).emit('drinks-updated', { drinks: room.drinks });
    });

    // SUPPRIMER UNE BOISSON
    socket.on('remove-drink', ({ code, index }) => {
        const room = rooms[code];
        if (!room) return;

        room.drinks.splice(index, 1);
        io.to(code).emit('drinks-updated', { drinks: room.drinks });
    });

    // CHANGER DE LIEU
    socket.on('update-place', ({ code, place }) => {
        const room = rooms[code];
        if (!room) return;

        room.currentPlace = place;
        io.to(code).emit('place-updated', { place });
    });

    // ARCHIVER LA TOURNÉE (hôte uniquement)
    socket.on('archive-round', ({ code, roundData }) => {
        const room = rooms[code];
        if (!room || room.host !== socket.id) return;

        room.drinks = [];
        io.to(code).emit('round-archived', { roundData });
    });

    // "JE N'AI JAMAIS" — phrase IA partagée
    socket.on('never-phrase', ({ code, phrase }) => {
        const room = rooms[code];
        if (!room) return;

        room.neverPhrase = phrase;
        io.to(code).emit('never-phrase-broadcast', { phrase });
    });

    // DÉCONNEXION
    socket.on('disconnect', () => {
        const code = socket.roomCode;
        if (!code || !rooms[code]) return;

        const room = rooms[code];
        room.members = room.members.filter(m => m.socketId !== socket.id);

        if (room.host === socket.id) {
            // L'hôte part → ferme la room
            io.to(code).emit('room-closed', { message: "L'hôte a quitté la soirée." });
            delete rooms[code];
            console.log(`❌ Room ${code} fermée (hôte parti)`);
        } else {
            io.to(code).emit('member-left', { members: room.members });
        }
    });
});

/* =========================================
   MIDDLEWARES HTTP
   ========================================= */
app.use((req, res, next) => {
    if (req.originalUrl === '/api/webhook') next();
    else express.json()(req, res, next);
});

/* =========================================
   ROUTES API
   ========================================= */
app.post('/api/auth', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email requis' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { data: existingUser } = await supabase.from('users').select('email').eq('email', email).single();
    if (!existingUser) {
        await supabase.from('users').insert([{ email, score: 0, is_vip: false }]);
    }

    await supabase.from('users').update({ auth_code: code, auth_expires: expiresAt }).eq('email', email);

    try {
        await resend.emails.send({
            from: 'TRINQ <noreply@trinq.be>',
            to: email,
            subject: '🍺 Ton code de connexion TRINQ',
            html: `<h2>Ton code : <strong>${code}</strong></h2><p>Valable 10 minutes.</p>`
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Erreur envoi email' });
    }
});

app.post('/api/verify-login', async (req, res) => {
    const { email, code } = req.body;
    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();

    if (!user || user.auth_code !== code) return res.json({ success: false, message: 'Code incorrect' });
    if (new Date() > new Date(user.auth_expires)) return res.json({ success: false, message: 'Code expiré' });

    await supabase.from('users').update({ auth_code: null, auth_expires: null }).eq('email', email);
    res.json({ success: true, user: { email: user.email, username: user.username, score: user.score, is_vip: user.is_vip } });
});

app.post('/api/verify-vip', async (req, res) => {
    const { code, email } = req.body;
    const { data: vipCode } = await supabase.from('vip_codes').select('*').eq('code', code).single();

    if (!vipCode) return res.json({ success: false, message: 'Code invalide' });
    if (vipCode.used) return res.json({ success: false, message: 'Code déjà utilisé' });

    await supabase.from('vip_codes').update({ used: true, used_by: email, used_at: new Date().toISOString() }).eq('code', code);
    await supabase.from('users').update({ is_vip: true, vip_code: code }).eq('email', email);

    res.json({ success: true });
});

app.post('/api/create-checkout-session', async (req, res) => {
    const { email } = req.body;
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price_data: { currency: 'eur', product_data: { name: 'TRINQ VIP' }, unit_amount: 500 }, quantity: 1 }],
            mode: 'payment',
            customer_email: email || undefined,
            success_url: 'https://trinq.be/?success=true',
            cancel_url: 'https://trinq.be/?canceled=true',
        });
        res.json({ url: session.url });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    } catch (e) {
        return res.status(400).send(`Webhook Error: ${e.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const email = session.customer_email;

        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let vipCode = 'TRINQ-';
        for (let i = 0; i < 4; i++) vipCode += chars[Math.floor(Math.random() * chars.length)];
        vipCode += '-';
        for (let i = 0; i < 4; i++) vipCode += chars[Math.floor(Math.random() * chars.length)];

        await supabase.from('vip_codes').insert([{ code: vipCode, used: false, created_for: email }]);

        if (email) {
            await resend.emails.send({
                from: 'TRINQ <noreply@trinq.be>',
                to: email,
                subject: '🎉 Ton code VIP TRINQ',
                html: `<h2>Bienvenue dans le club !</h2><p>Ton code VIP : <strong>${vipCode}</strong></p><p>Active-le dans l'app TRINQ.</p>`
            });
        }
    }
    res.json({ received: true });
});

app.post('/api/set-username', async (req, res) => {
    const { email, username } = req.body;
    const { error } = await supabase.from('users').update({ username }).eq('email', email);
    if (error) return res.status(500).json({ success: false });
    res.json({ success: true });
});

app.get('/api/leaderboard', async (req, res) => {
    const { data, error } = await supabase.from('users').select('username, score, is_vip').order('score', { ascending: false }).limit(10);
    if (error) return res.status(500).json({ error });
    res.json(data);
});

app.post('/api/add-score', async (req, res) => {
    const { email, points } = req.body;
    const { data: user } = await supabase.from('users').select('score').eq('email', email).single();
    const newScore = (user?.score || 0) + points;
    await supabase.from('users').update({ score: newScore }).eq('email', email);
    res.json({ success: true, score: newScore });
});

app.post('/api/sync-up', async (req, res) => {
    const { email, history, favorites } = req.body;
    const { error } = await supabase.from('users').update({ history, favorites }).eq('email', email);
    if (error) return res.status(500).json({ success: false });
    res.json({ success: true });
});

app.post('/api/sync-down', async (req, res) => {
    const { email } = req.body;
    const { data, error } = await supabase.from('users').select('history, favorites').eq('email', email).single();
    if (error) return res.status(500).json({ success: false });
    res.json({ success: true, data });
});

app.get('/api/debug-db', async (req, res) => {
    const { data, error } = await supabase.from('users').select('email, username, score, is_vip').limit(5);
    if (error) return res.status(500).json({ error });
    res.json(data);
});

app.post('/api/auth', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email requis' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    console.log("🔵 /api/auth appelé pour :", email);
    console.log("🔵 Code généré :", code);
    console.log("🔵 Resend initialisé ?", resend ? "OUI" : "NON");

    const { data: existingUser } = await supabase.from('users').select('email').eq('email', email).single();
    if (!existingUser) {
        await supabase.from('users').insert([{ email, score: 0, is_vip: false }]);
    }

    await supabase.from('users').update({ auth_code: code, auth_expires: expiresAt }).eq('email', email);

    try {
        console.log("📧 ENVOI EMAIL À :", email);
        const response = await resend.emails.send({
            from: 'TRINQ <noreply@trinq.be>',
            to: email,
            subject: '🍺 Ton code de connexion TRINQ',
            html: `<h2>Ton code : <strong>${code}</strong></h2><p>Valable 10 minutes.</p>`
        });
        console.log("✅ RÉPONSE RESEND :", response);
        res.json({ success: true });
    } catch (e) {
        console.error("❌ ERREUR RESEND :", e.message, e);
        res.status(500).json({ success: false, message: 'Erreur envoi email: ' + e.message });
    }
});

/* =========================================
   DÉMARRAGE
   ========================================= */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 TRINQ backend running on port ${PORT}`));

