const { WebpayPlus } = require('transbank-sdk');
const supabase = require('../services/supabase');

module.exports.controller = (app, io) => {

  // =====================================================
  // 1️⃣ INICIAR PAGO (Create Transaction)
  // =====================================================
  app.post('/api/payments/create', async (req, res) => {
    // sessionId suele ser el user.id y buyOrder el order.id
    const { buyOrder, sessionId, amount } = req.body;

    // Detectar si estamos en Render o Local para la URL de retorno
    const host = process.env.RENDER_EXTERNAL_URL || process.env.API_URL || 'http://localhost:3000';
    const returnUrl = `${host}/api/payments/confirm`;

    try {
      console.log(`🚀 Iniciando pago: Orden ${buyOrder} por $${amount}`);

      // 1. Registrar el intento en la tabla 'payments'
      // IMPORTANTE: Asegúrate de que services/supabase.js use la SERVICE_ROLE_KEY
      const { error: paymentError } = await supabase
        .from('payments')
        .insert({
          order_id: buyOrder,      // El UUID de la orden
          user_id: sessionId,       // El UUID del cliente
          amount: parseInt(amount), // Webpay requiere enteros
          status: 'pending',        // Usar el valor exacto del ENUM en tu DB
          provider: 'webpay',
          buy_order: `BT-${Date.now()}` // Identificador interno para Transbank
        });

      if (paymentError) {
        console.error("❌ Error Supabase al insertar pago:", paymentError.message);
        return res.status(500).json({ 
          error: "No se pudo registrar el pago en la base de datos",
          details: paymentError.message 
        });
      }

      // 2. Crear la transacción en Transbank
      // Usamos buyOrder (ID de la orden) como identificador principal
      const createResponse = await new WebpayPlus.Transaction().create(
        buyOrder, 
        sessionId, 
        parseInt(amount), 
        returnUrl
      );

      res.json(createResponse);

    } catch (error) {
      console.error("❌ Error crítico en Webpay Create:", error);
      res.status(500).json({ error: 'Error de conexión con el proveedor de pagos' });
    }
  });

  // =====================================================
  // 2️⃣ CONFIRMAR PAGO (Commit Transaction)
  // =====================================================
  app.all('/api/payments/confirm', async (req, res) => {
    const token = req.body.token_ws || req.query.token_ws;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    if (!token) {
      console.log("⚠️ Pago anulado: No se recibió token");
      return res.send(`
        <script>
          window.location.href="${frontendUrl}/payment-failed?reason=user_aborted"
        </script>
      `);
    }

    try {
      const tx = new WebpayPlus.Transaction();
      const commitResponse = await tx.commit(token);

      const { buy_order, status, authorization_code, card_detail, transaction_date } = commitResponse;

      if (status === 'AUTHORIZED') {
        console.log("✅ Pago autorizado con éxito:", buy_order);

        // 1. Actualizar Pago y Orden en una sola transacción lógica
        // Actualizar Pago
        await supabase
          .from('payments')
          .update({
            status: 'paid', // O el valor 'completed' según tu ENUM
            token: token,
            authorization_code: authorization_code,
            card_last4: card_detail?.card_number?.slice(-4),
            transaction_date: transaction_date,
            updated_at: new Date()
          })
          .eq('order_id', buy_order);

        // Actualizar Orden
        const { data: order } = await supabase
          .from('orders')
          .update({ status: 'paid', updated_at: new Date() })
          .eq('id', buy_order)
          .select('shop_id, customer_id')
          .single();

        // 2. Notificaciones en tiempo real
        if (order) {
          // Al Vendedor
          io.emit(`new_paid_order_shop_${order.shop_id}`, {
            order_id: buy_order,
            status: 'paid'
          });
          // Al Cliente (si tienes un socket escuchando en la app)
          io.emit(`order_update_user_${order.customer_id}`, {
            order_id: buy_order,
            status: 'paid'
          });
        }

        return res.send(`<script>window.location.href="${frontendUrl}/payment-success?order=${buy_order}"</script>`);

      } else {
        console.log("❌ Pago rechazado por Transbank:", status);
        await supabase.from('payments').update({ status: 'failed' }).eq('order_id', buy_order);
        return res.send(`<script>window.location.href="${frontendUrl}/payment-failed?order=${buy_order}"</script>`);
      }

    } catch (error) {
      console.error("❌ Error en Confirmación:", error);
      res.status(500).send("Error interno procesando el pago.");
    }
  });
};