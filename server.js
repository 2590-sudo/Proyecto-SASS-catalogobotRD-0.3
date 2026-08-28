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
const GROQ_MODEL = "openai/gpt-oss-20b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const activeSessions = {};
const clientConfigs = {}; 
const activeConversations = {}; 
const reconnectAttempts = {}; 
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

// === CEREBRO GROQ - TODO PASA POR AQUI ===
async function handleWithGroq(textoCliente, idNegocio) {
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
    const productos = config?.productos || [];

    const systemPrompt = 'Eres el asistente de atencion al cliente de: ' + nombreNegocio + '. ' +
        'Tipo de negocio: ' + tipoNegocio + '. ' +
        'Responde amable, corto, en español dominicano. ' +
        'Usa solo la info de estos productos: ' + JSON.stringify(productos) + '. ' +
        'Si no esta el producto, di que no lo tenemos. ' +
        'Maximo 1 emoji. Nunca digas que eres IA o robot. ' +
        'Eres el asistente de ' + nombreNegocio + '. ' +
        'Nunca uses mayusculas en todo el mensaje. Nunca mandes links.';

    console.log('Llamando a Groq con:', textoCliente);
    console.log('Modelo:', GROQ_MODEL);
    console.log('Negocio:', nombreNegocio, '- Productos:', productos.length);

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
        const errBody = await response.text();
        console.error('[GROQ HTTP ERROR]', response.status, errBody);
        throw new Error('Groq HTTP ' + response.status + ': ' + errBody);
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();
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
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('[DESCONEXION] Cliente ' + clientId + ' cayo. Codigo: ' + statusCode + '. Reconectando...');
            if (shouldReconnect) {
                if (!reconnectAttempts[clientId]) reconnectAttempts[clientId] = 0;
                reconnectAttempts[clientId]++;
                const delay = Math.min(5000 * reconnectAttempts[clientId], 60000);
                console.log('[RECONEXION] Cliente ' + clientId + ' intento #' + reconnectAttempts[clientId] + ' en ' + delay + 'ms');
                setTimeout(function() {
                    startClientSession(clientId).then(function() {
                        reconnectAttempts[clientId] = 0;
                    }).catch(function(e) {
                        console.error('[RECONEXION ERROR] Cliente ' + clientId + ':', e.message);
                    });
                }, delay);
            } else {
                await removeCreds();
                delete activeSessions[clientId];
                console.log('[SESION ELIMINADA] Cliente ' + clientId + ' cerro sesion manualmente.');
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
        activeConversations[conversationKey] = Date.now();

        const config = clientConfigs[clientId] || {};
        if (config.activo === false) {
            console.log('[BOT SUSPENDIDO] Cliente ' + clientId + ' inactivo. Ignorando msj.');
            return;
        }
        console.log('[WS IN] Mensaje recibido de ' + sender + ': ' + textoCliente);

        // === TODO VA A GROQ - SIN MENSAJES FIJOS ===
        try {
            const respuestaIA = await handleWithGroq(textoCliente, clientId);
            console.log('[GROQ RESPUESTA]', respuestaIA);
            await sock.sendMessage(sender, { text: respuestaIA });
        } catch (error) {
            console.error('[ERROR GROQ] Fallo en cliente ' + clientId + ':', error.message);
            await sock.sendMessage(sender, { text: 'Un momento, tengo un problema tecnico. Vuelvo enseguida.' });
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
