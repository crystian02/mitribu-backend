// controllers/support_controller.js
const supabase = require('../services/supabase');
const { notifyUser } = require('../utils/notification_helper');

module.exports.controller = function (app, io) {

  // =====================================================
  // CREAR TICKET DE SOPORTE
  // =====================================================
  app.post('/api/support/create', async (req, res) => {

    try {

      // 🔐 NO confiar en userId del cliente
      const userId = req.user?.id;
      const { shopId, type, subject, message } = req.body;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: "No autenticado"
        });
      }

      if (!shopId || !type || !subject || !message) {
        return res.status(400).json({
          success: false,
          error: "Faltan campos obligatorios"
        });
      }

      // Validar tipo permitido
      const allowedTypes = ['reclamo', 'sugerencia', 'bug', 'otro'];
      if (!allowedTypes.includes(type)) {
        return res.status(400).json({
          success: false,
          error: "Tipo inválido"
        });
      }

      // 1️⃣ Guardar ticket
      const { data: ticket, error } = await supabase
        .from('support_tickets')
        .insert({
          user_id: userId,
          shop_id: shopId,
          type: type,
          subject: subject,
          message: message,
          status: 'pendiente'
        })
        .select('*, shops(owner_id, name)')
        .single();

      if (error) throw error;

      // 2️⃣ Notificar dueño de la tienda
      if (ticket.shops?.owner_id) {

        const emoji =
          type === 'reclamo' ? '🚨' :
          type === 'bug' ? '🐛' :
          type === 'sugerencia' ? '💡' : '📩';

        await notifyUser(
          ticket.shops.owner_id,
          `Nuevo ${type} recibido ${emoji}`,
          `${subject.substring(0, 50)}`,
          {
            type: 'support_ticket',
            ticketId: ticket.id,
            route: '/vendor/support'
          }
        );

        // 3️⃣ Emitir evento en tiempo real al dashboard vendedor
        io.emit(`new_support_ticket_shop_${shopId}`, {
          ticket_id: ticket.id,
          subject: subject,
          type: type,
          status: 'pendiente'
        });
      }

      return res.json({
        success: true,
        ticketId: ticket.id
      });

    } catch (err) {

      console.error('❌ Error support:', err);

      return res.status(500).json({
        success: false,
        error: err.message
      });
    }
  });

};