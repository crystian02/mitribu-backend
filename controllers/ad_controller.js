const supabase = require('../services/supabase');
const admin = require('../services/firebase');
const { notifyUser } = require('../utils/notification_helper'); // <--- IMPORTANTE: Importamos el helper

module.exports.controller = function(app, io) {

    // --- APROBAR AVISO ---
    app.post('/api/ads/approve', async (req, res) => {
        const { requestId } = req.body;
        console.log(`📢 Aprobando solicitud: ${requestId}`);

        try {
            // 1. Actualizar a 'approved' y traer datos del dueño (owner_id)
            const { data: request, error } = await supabase
                .from('ad_requests')
                .update({ status: 'approved', approved_at: new Date() })
                .eq('id', requestId)
                .select('*, shops(owner_id, name)') // JOIN para saber de quién es la tienda
                .single();

            if (error || !request) return res.status(404).json({error: 'Solicitud no encontrada'});

            // 2. Notificar a TODOS LOS CLIENTES (Broadcast masivo)
            const broadcastMsg = {
                topic: 'clientes_general',
                notification: { 
                    title: request.title, 
                    body: request.body, 
                    image: request.image_url 
                },
                data: { route: request.target_route, type: 'ad_broadcast' }
            };
            await admin.messaging().send(broadcastMsg);

            // 3. Notificar al DUEÑO (Personal) ✅
            if (request.shops && request.shops.owner_id) {
                await notifyUser(
                    request.shops.owner_id, 
                    "¡Aviso Aprobado! 🚀", 
                    "Tu publicidad ya se envió a todos los clientes.",
                    { type: 'ad_status', status: 'approved' }
                );
            }

            return res.json({ success: true, message: 'Aprobado y enviado.' });
        } catch (err) {
            console.error(err);
            return res.status(500).json({ error: err.message });
        }
    });

    // --- RECHAZAR AVISO (NUEVA RUTA) ---
    app.post('/api/ads/reject', async (req, res) => {
        const { requestId, reason } = req.body;
        
        try {
            const { data: request, error } = await supabase
                .from('ad_requests')
                .update({ status: 'rejected', rejection_reason: reason })
                .eq('id', requestId)
                .select('*, shops(owner_id)')
                .single();

            if (error || !request) return res.status(404).json({error: 'Error al rechazar'});

            // Notificar al DUEÑO del rechazo
            if (request.shops && request.shops.owner_id) {
                await notifyUser(
                    request.shops.owner_id, 
                    "Solicitud Rechazada ⚠️", 
                    `Admin: "${reason}"`,
                    { type: 'ad_status', status: 'rejected' }
                );
            }

            return res.json({ success: true });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });
};