const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const mongoose = require('mongoose');

const AuthSchema = new mongoose.Schema({
    clientId: { type: String, required: true },
    file: { type: String, required: true },
    data: { type: String, required: true }
});

// Indice para búsquedas rápidas
AuthSchema.index({ clientId: 1, file: 1 }, { unique: true });

const Auth = mongoose.models.Auth || mongoose.model('Auth', AuthSchema);

async function useMongoDBAuthState(clientId) {
    const readData = async (file) => {
        try {
            const doc = await Auth.findOne({ clientId, file });
            if (doc) {
                return JSON.parse(doc.data, BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            return null;
        }
    };

    const writeData = async (file, data) => {
        try {
            const str = JSON.stringify(data, BufferJSON.replacer);
            await Auth.updateOne({ clientId, file }, { data: str }, { upsert: true });
        } catch (e) {
            console.error('[MONGO AUTH] Error guardando ' + file + ':', e.message);
        }
    };

    const removeData = async (file) => {
        try {
            await Auth.deleteOne({ clientId, file });
        } catch (e) {
            console.error('[MONGO AUTH] Error borrando ' + file + ':', e.message);
        }
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const file = `${category}-${id}`;
                            tasks.push(value ? writeData(file, value) : removeData(file));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData('creds', creds),
        removeCreds: async () => {
            await Auth.deleteMany({ clientId });
        }
    };
}

module.exports = { useMongoDBAuthState };
