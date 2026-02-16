const supabase = require('../services/supabase');
const { notifyUser } = require('../utils/notification_helper');

module.exports.controller = function(app, io) {

    // Crear Ticket de Soporte (Desde la App del Cliente)
    app.post('/api/support/create', async (req, res) => {
        const { userId, shopId, type, subject, message } = req.body;

        try {
            // 1. Guardar el ticket en Supabase
            const { data: ticket, error } = await supabase
                .from('support_tickets')
                .insert({
                    user_id: userId,
                    shop_id: shopId,
                    type: type, // 'reclamo', 'sugerencia', 'bug'
                    subject: subject,
                    message: message,
                    status: 'pendiente'
                })
                .select('*, shops(owner_id, name)') // Traer info del dueño
                .single();

            if (error) throw error;

            // 2. Notificar al DUEÑO DE LA TIENDA ✅
            if (ticket.shops && ticket.shops.owner_id) {
                const emoji = type === 'reclamo' ? '🚨' : '💡';
                
                await notifyUser(
                    ticket.shops.owner_id,
                    `Nuevo ${type} recibido ${emoji}`,
                    `${subject}: ${message.substring(0, 40)}...`,
                    { 
                        type: 'support_ticket', 
                        ticketId: ticket.id,
                        route: '/vendor/support' // Ruta interna de la app vendedor
                    }
                );
            }

            return res.json({ success: true, ticketId: ticket.id });

        } catch (err) {
            console.error('Error support:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    });
};