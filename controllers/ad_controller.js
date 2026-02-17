// controllers/ad_controller.js
const supabase = require('../services/supabase');
const NotificationService = require('../services/notification_service');
const { notifyUser } = require('../utils/notification_helper');
const { isAdmin } = require('../middleware/isAdmin');

module.exports.controller = function (app, io) {

  // =====================================================
  // APROBAR AVISO
  // =====================================================
  app.post('/api/ads/approve', isAdmin, async (req, res) => {
    const { requestId } = req.body;

    try {

      // 1️⃣ Obtener solicitud (NO aprobar aún)
      const { data: request, error } = await supabase
        .from('ad_requests')
        .select('*, shops(owner_id, name)')
        .eq('id', requestId)
        .single();

      if (error || !request) {
        return res.status(404).json({ error: 'Solicitud no encontrada' });
      }

      if (request.status !== 'pending') {
        return res.status(400).json({ error: 'La solicitud ya fue procesada' });
      }

      // 2️⃣ Enviar notificación usando NotificationService
      const result = await NotificationService.sendBroadcast({
        shopId: request.is_global ? null : request.shop_id,
        title: request.title,
        body: request.body,
        image: request.image_url,
        data: {
          route: request.target_route || '',
          type: 'ad_broadcast'
        }
      });

      const totalSuccess = result.success;
      const totalFail = result.failed;

      if (totalSuccess === 0) {
        await supabase
          .from('ad_requests')
          .update({ send_status: 'failed' })
          .eq('id', requestId);

        return res.status(500).json({
          error: 'No se pudo entregar la campaña a ningún dispositivo'
        });
      }

      // 5️⃣ Solo aprobar si hubo al menos un envío exitoso
      if (totalSuccess > 0) {

        await supabase
          .from('ad_requests')
          .update({
            status: 'approved',
            send_status: totalFail === 0 ? 'sent' : 'partial',
            approved_at: new Date(),
            sent_at: new Date()
          })
          .eq('id', requestId);

      } else {

        await supabase
          .from('ad_requests')
          .update({
            send_status: 'failed'
          })
          .eq('id', requestId);

        return res.status(500).json({
          error: 'No se pudo entregar la campaña a ningún dispositivo'
        });
      }

      // 6️⃣ Notificar al dueño del comercio
      if (request.shops?.owner_id) {
        await notifyUser(
          request.shops.owner_id,
          "¡Aviso Aprobado! 🚀",
          `Enviado a ${totalSuccess} dispositivos.`,
          { type: 'ad_status', status: 'approved' }
        );
      }

      return res.json({
        success: true,
        delivered: totalSuccess,
        failed: totalFail,
        cleaned_tokens: result.cleaned
      });

    } catch (err) {

      console.error("❌ Error enviando campaña:", err);

      await supabase
        .from('ad_requests')
        .update({ send_status: 'failed' })
        .eq('id', requestId);

      return res.status(500).json({ error: err.message });
    }
  });



  // =====================================================
  // RECHAZAR AVISO
  // =====================================================
  app.post('/api/ads/reject', isAdmin, async (req, res) => {
    const { requestId, reason } = req.body;

    try {

      const { data: request, error } = await supabase
        .from('ad_requests')
        .update({
          status: 'rejected',
          rejection_reason: reason
        })
        .eq('id', requestId)
        .select('*, shops(owner_id)')
        .single();

      if (error || !request) {
        return res.status(404).json({ error: 'Solicitud no encontrada' });
      }

      if (request.shops?.owner_id) {
        await notifyUser(
          request.shops.owner_id,
          "Solicitud Rechazada ⚠️",
          `Motivo: ${reason}`,
          { type: 'ad_status', status: 'rejected' }
        );
      }

      return res.json({ success: true });

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

};