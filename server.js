const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const cors = require('cors');
const { useMongoDBAuthState } = require('./mongoAuth');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

const storage = multer.memoryStorage();
const upload = multer({ storage });

app.use(express.static('public'));

const MONGO_URI = process.env.MONGO_URI || "URL_DE_MONGO_AQUI";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = "llama3-8b-8192";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const activeSessions = {};
const clientConfigs = {}; 
const activeConversations = {}; 
const CONVERSATION_TIMEOUT = 60 * 60 * 1000;

const configSchema = new mongoose.Schema({
    clientId: { type: String, unique: true },
    tipo: String,
    nombre: String,
    telefono: String,
    catalogo: String,
    imagenMenu: String,
    productos: { type: Array, default: [] },
    activo: { type: Boolean, default: true }
});
const ClientConfig = mongoose.models.ClientConfig || mongoose.model('ClientConfig', configSchema);

// === CEREBRO GROQ HÍBRIDO ===
async function cerebroGroq(textoCliente, idNegocio) {
    // Leer datos del negocio desde MongoDB (cache local o DB)
    let config = clientConfigs[idNegocio];
    if (!config) {
        const dbConfig = await ClientConfig.findOne({ clientId: idNegocio });
        if (dbConfig) {
            config = {
                tipo: dbConfig.tipo,
                nombre: dbConfig.nombre,
                catalogo: dbConfig.catalogo,
                productos: dbConfig.productos || []
            };
            clientConfigs[idNegocio] = config;
        }
    }

    const nombreNegocio = config?.nombre || "el negocio";
    const tipoNegocio = config?.tipo || "tienda";
    const catalogo = config?.catalogo || "Catalogo no disponible.";

    // SYSTEM PROMPT dinamico
    const systemPrompt = `Eres el asistente de ATENCION AL CLIENTE de: ${nombreNegocio}.
Tipo de negocio: ${tipoNegocio}.
Catalogo actual: ${catalogo}

REGLAS:
1. Tono: Humano, amable, corto. Como un empleado real de ${nombreNegocio}. Maximo 1 emoji.
2. Identidad: Nunca digas que eres IA o robot. Eres "el asistente de ${nombreNegocio}".
3. Objetivo: Responder dudas, dar precios, tomar pedidos y calcular totales usando SOLO el catalogo de arriba.
4. Anti-Ban Meta: Nunca envies mensajes primero. Nunca uses MAYUSCULAS. Nunca repitas mensajes. Nunca mandes links.
5. Si no esta en el catalogo: "Ese producto no lo tenemos ahora mismo en ${nombreNegocio}, te puedo ofrecer algo similar?"`;

    const response = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + GROQ_API_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: GROQ_MODEL,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: textoCliente }
            ],
            temperature: 0.7,
            max_tokens: 300
        })
    });

    if (!response.ok) {
        throw new Error('Groq API error: ' + response.status);
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();
}

// === FALLBACK ANTI-CAIDA (desde MongoDB) ===
function fallbackMongoDB(textoCliente, config) {
    const txt = textoCliente.toLowerCase();
    const productos = config.productos || [];
    const nombreLocal = config.nombre || "el negocio";
    const catalogoLocal = config.catalogo || "";

    // Buscar productos mencionados
    let encontrados = productos.filter(function(p) { 
        return txt.includes(p.nombre.toLowerCase()) || 
        (p.descripcion && txt.includes(p.descripcion.toLowerCase()));
    });

    // Si hay productos encontrados, responder con precios
    if (encontrados.length > 0) {
        let respuesta = 'Veo que buscas:\n';
        let total = 0;
        encontrados.forEach(function(p) {
            respuesta += p.nombre + ': $' + p.precio + '\n';
            total += parseFloat(p.precio) || 0;
        });
        if (encontrados.length > 1) {
            respuesta += '\nTotal: $' + total.toFixed(2) + '\n\nConfirmas tu pedido? Dime tu direccion para el envio.';
        } else {
            respuesta += '\nCuantas unidades deseas? Dime y lo preparo.';
        }
        return respuesta;
    }

    // Si pide menu
    if (txt.includes('menu') || txt.includes('catalogo')) {
        return 'Nuestro catalogo:\n' + catalogoLocal + '\n\nQue deseas pedir?';
    }

    // Si parece pedido
    if (txt.includes('pedido') || txt.includes('orden') || txt.includes('quiero') || txt.includes('dame')) {
        return 'Gracias por escribir a ' + nombreLocal + '. Escribe "menu" para ver nuestras opciones disponibles.';
    }

    // Respuesta generica
    return 'Hola, gracias por escribir a ' + nombreLocal + '. Escribe "menu" para ver lo que tenemos disponible.';
}

async function connectDB() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("Conectado a MongoDB");
        
        const configs = await ClientConfig.find();
        
        for (const c of configs) {
            clientConfigs[c.clientId] = {
                tipo: c.tipo,
                nombre: c.nombre,
                telefono: c.telefono,
                catalogo: c.catalogo,
                imagenMenu: c.imagenMenu,
                productos: c.productos || [],
                activo: c.activo !== false
            };
        }

    } catch (e) {
        console.error("Error conectando a MongoDB:", e);
    }
}

async function startClientSession(clientId, phoneNumber, res) {
    const { state, saveCreds, removeCreds } = await useMongoDBAuthState(clientId);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    activeSessions[clientId] = sock;
    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.me?.id && phoneNumber) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                if (res) res.json({ success: true, code });
            } catch (err) {
                if (res) res.json({ success: false, error: err.message });
            }
        }, 2000);
    } else {
        if (res) res.json({ success: true, message: 'Ya estaba conectado' });
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            // === MENSAJE AL PROPIETARIO ===
            console.log('[CONEXION] Cliente ' + clientId + ' conectado exitosamente');
            try {
                const config = clientConfigs[clientId] || {};
                const telefonoOwner = config.telefono;
                if (telefonoOwner) {
                    const jidOwner = telefonoOwner.includes('@s.whatsapp.net') 
                        ? telefonoOwner 
                        : telefonoOwner + '@s.whatsapp.net';
                    await sock.sendMessage(jidOwner, { 
                        text: 'Asistente activado y atendiendo clientes 24/7 desde su WhatsApp.' 
                    });
                    console.log('[MENSAJE PROPIETARIO] Notificacion enviada a ' + telefonoOwner);
                }
            } catch (e) {
                console.error('[MENSAJE PROPIETARIO] Error:', e.message);
            }
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(function() { startClientSession(clientId); }, 5000);
            } else {
                await removeCreds();
                delete activeSessions[clientId];
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid.includes('@g.us')) return;

        const sender = msg.key.remoteJid;
        const textoCliente = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || "").trim().toLowerCase();

        if (!textoCliente) return;

        const conversationKey = clientId + '_' + sender;
        const now = Date.now();
        let isBusinessQuery = false;

        if (activeConversations[conversationKey] && (now - activeConversations[conversationKey] < CONVERSATION_TIMEOUT)) {
            isBusinessQuery = true;
        } else {
            const triggerWords = [
                'hola', 'buenas', 'saludo', 'menu', 'catalogo', 
                'pedido', 'orden', 'delivery', 'precio', 'cuanto', 
                'a como', 'tiene', 'venden', 'comprar', 'info', 'direccion', 'ubicacion',
                'quiero', 'dame', 'necesito', 'busco', 'tienen', 'hay', 'deseo', 'mandame'
            ];
            isBusinessQuery = triggerWords.some(function(kw) { return textoCliente.includes(kw); });
        }

        if (!isBusinessQuery) return; 

        activeConversations[conversationKey] = now;

        const config = clientConfigs[clientId] || {};
        if (config.activo === false) {
            console.log('[BOT SUSPENDIDO] Cliente ' + clientId + ' inactivo. Ignorando msj.');
            return;
        }
        console.log('[WS IN] Mensaje recibido de ' + sender + ': ' + textoCliente);

        const tipoNegocio = config.tipo || "Negocio";
        const nombreLocal = config.nombre || "Nuestro Local";
        const catalogoLocal = config.catalogo || "Catalogo no disponible.";
        const imagenMenu = config.imagenMenu || null;

        const saludos = ['hola', 'buenas', 'saludos', 'buenos dias', 'buenas tardes', 'buenas noches'];
        if (saludos.some(function(s) { return textoCliente === s || textoCliente.startsWith(s + ' '); }) && !textoCliente.includes('menu') && !textoCliente.includes('catalogo')) {
            return sock.sendMessage(sender, { text: 'Hola! Gracias por comunicarte con *' + nombreLocal + '*. En que podemos servirte hoy? Escribe *menu* para ver nuestras opciones.' });
        }

        if (textoCliente.includes('menu') || textoCliente.includes('catalogo')) {
            let menuTxt = '*CATALOGO DE ' + nombreLocal.toUpperCase() + '*\n\n' + catalogoLocal + '\n\n_Dime que deseas pedir o si tienes alguna duda._';
            
            if (imagenMenu) {
                try {
                    const base64Data = imagenMenu.replace(/^data:image\/\w+;base64,/, "");
                    const buffer = Buffer.from(base64Data, 'base64');
                    return sock.sendMessage(sender, { image: buffer, caption: menuTxt });
                } catch(e) {
                    return sock.sendMessage(sender, { text: menuTxt });
                }
            } else {
                return sock.sendMessage(sender, { text: menuTxt });
            }
        }

        // === CEREBRO GROQ HIBRIDO ===
        try {
            const respuestaIA = await cerebroGroq(textoCliente, clientId);
            await sock.sendMessage(sender, { text: respuestaIA });
        } catch (error) {
            console.error('[ERROR GROQ] Fallo en cliente ' + clientId + ':', error.message);
            
            // FALLBACK ANTI-CAIDA: responder directo desde MongoDB
            const respuestaFallback = fallbackMongoDB(textoCliente, config);
            await sock.sendMessage(sender, { text: respuestaFallback });
        }
    });
}


app.post('/api/catalogo/:clientId/producto', upload.single('foto_producto'), async (req, res) => {
    const { clientId } = req.params;
    const { nombre, precio, descripcion } = req.body;
    
    let imagenBase64 = null;
    if (req.file) {
        imagenBase64 = 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64');
    }

    const nuevoProducto = {
        id: Date.now().toString(),
        nombre: nombre,
        precio: parseFloat(precio),
        descripcion: descripcion,
        imagen: imagenBase64
    };

    try {
        const ClientConfig = mongoose.models.ClientConfig || mongoose.model('ClientConfig');
        const config = await ClientConfig.findOne({ clientId });
        let productos = config && config.productos ? config.productos : [];
        productos.push(nuevoProducto);

        const catalogoTexto = productos.map(function(p) { return "- " + p.nombre + ": $" + p.precio + " (" + p.descripcion + ")"; }).join("\n");

        await ClientConfig.findOneAndUpdate(
            { clientId },
            { productos: productos, catalogo: catalogoTexto },
            { upsert: true }
        );

        if (!clientConfigs[clientId]) clientConfigs[clientId] = {};
        clientConfigs[clientId].productos = productos;
        clientConfigs[clientId].catalogo = catalogoTexto;

        res.json({ success: true, message: 'Producto aislado y guardado en MongoDB', producto: nuevoProducto });
    } catch(e) {
        console.error("Error guardando producto:", e);
        res.status(500).json({ success: false, error: 'Fallo al guardar en DB' });
    }
});

app.get('/api/catalogo/:clientId/productos', async (req, res) => {
    const { clientId } = req.params;
    if (clientConfigs[clientId] && clientConfigs[clientId].productos) {
        return res.json(clientConfigs[clientId].productos);
    }
    
    try {
        const ClientConfig = mongoose.models.ClientConfig || mongoose.model('ClientConfig');
        const config = await ClientConfig.findOne({ clientId });
        res.json(config && config.productos ? config.productos : []);
    } catch(e) {
        res.json([]);
    }
});

app.post('/api/connect', async (req, res) => {
    const { clientId, phoneNumber, tipoNegocio, nombreLocal, catalogo } = req.body;
    if (!clientId || !phoneNumber) return res.status(400).json({ error: 'Faltan datos' });
    
    await ClientConfig.findOneAndUpdate(
        { clientId },
        { tipo: tipoNegocio, nombre: nombreLocal, telefono: phoneNumber, catalogo: catalogo },
        { upsert: true, new: true }
    );
    
    clientConfigs[clientId] = { tipo: tipoNegocio, nombre: nombreLocal, telefono: phoneNumber, catalogo: catalogo, imagenMenu: null };
    
    if (activeSessions[clientId] && activeSessions[clientId].authState.creds.me?.id) {
        return res.status(400).json({ error: 'El cliente ya esta conectado' });
    }
    startClientSession(clientId, phoneNumber, res);
});

app.post('/api/update_catalog', async (req, res) => {
    const { clientId, catalogo, imagenMenu } = req.body;
    try {
        await ClientConfig.findOneAndUpdate({ clientId }, { catalogo, imagenMenu }, { upsert: true });
        if (!clientConfigs[clientId]) clientConfigs[clientId] = {};
        clientConfigs[clientId].catalogo = catalogo;
        if(imagenMenu !== undefined) clientConfigs[clientId].imagenMenu = imagenMenu;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Error guardando en BD' });
    }
});

app.post('/api/disconnect', async (req, res) => {
    const { clientId } = req.body;
    const sock = activeSessions[clientId];
    if (sock) {
        try { sock.logout(); } catch(e) {}
        delete activeSessions[clientId];
    }
    const { useMongoDBAuthState } = require('./mongoAuth');
    const authState = await useMongoDBAuthState(clientId);
    await authState.removeCreds();
    await ClientConfig.deleteOne({ clientId });
    delete clientConfigs[clientId];
    res.json({ success: true });
});


app.post('/api/toggle-status', async (req, res) => {
    const { clientId } = req.body;
    try {
        const ClientConfig = mongoose.models.ClientConfig || mongoose.model('ClientConfig');
        const config = await ClientConfig.findOne({ clientId });
        if(config) {
            config.activo = config.activo === false ? true : false;
            await config.save();
            if(clientConfigs[clientId]) {
                clientConfigs[clientId].activo = config.activo;
            }
            res.json({ success: true, activo: config.activo });
        } else {
            res.status(404).json({ error: 'Cliente no encontrado' });
        }
    } catch(e) {
        res.status(500).json({ error: 'Error BD' });
    }
});

app.get('/api/status', (req, res) => {
    const status = {};
    for (const [id, config] of Object.entries(clientConfigs)) {
        status[id] = {
            state: activeSessions[id]?.authState?.creds?.me?.id ? 'Conectado (Activo)' : 'Desconectado',
            nombre: config.nombre || 'Sin nombre',
            telefono: config.telefono || 'Desconocido',
            catalogo: config.catalogo || '',
            tieneImagen: !!config.imagenMenu,
            activo: config.activo !== false
        };
    }
    res.json(status);
});

async function reactivarSesiones() {
    try {
        const Auth = mongoose.models.Auth || mongoose.model('Auth');
        const sesiones = await Auth.distinct('clientId');
        for (const clientId of sesiones) {
            startClientSession(clientId, null, null);
        }
    } catch(e) {}
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log('Motor SaaS escuchando en el puerto ' + PORT);
    if (MONGO_URI !== "URL_DE_MONGO_AQUI") {
        await connectDB();
        reactivarSesiones();
    }
});
