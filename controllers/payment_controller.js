const { WebpayPlus } = require('transbank-sdk');
const supabase = require('../services/supabase');

module.exports.controller = (app, io) => {

  // =====================================================
  // 1️⃣ INICIAR PAGO (Create Transaction)
  // =====================================================
  app.post('/api/payments/create', async (req, res) => {
    const { buyOrder, sessionId, amount } = req.body;

    const host = process.env.RENDER_EXTERNAL_URL || process.env.API_URL || 'http://localhost:10000';
    const returnUrl = `${host}/api/payments/confirm`;

    try {
      const shortBuyOrder = `${buyOrder.substring(0, 8)}-${Date.now().toString().slice(-10)}`;
      
      console.log(`🚀 Iniciando pago: Orden ${buyOrder} (ID Transbank: ${shortBuyOrder}) por $${amount}`);

      const { error: paymentError } = await supabase
        .from('payments')
        .insert({
          order_id: buyOrder,
          user_id: sessionId,       
          amount: parseInt(amount), 
          status: 'pending',        
          provider: 'webpay',
          buy_order: shortBuyOrder
        });

      if (paymentError) {
        console.error("❌ Error Supabase al insertar pago:", paymentError.message);
        return res.status(500).json({ 
          error: "No se pudo registrar el pago en la base de datos",
          details: paymentError.message 
        });
      }

      console.log(`✅ Registro insertado en Supabase con buy_order: ${shortBuyOrder}`);

      const createResponse = await new WebpayPlus.Transaction().create(
        shortBuyOrder, 
        sessionId, 
        parseInt(amount), 
        returnUrl
      );

      res.json(createResponse);

    } catch (error) {
      console.error("❌ Error crítico en Webpay Create:", error.message);
      res.status(500).json({ 
        error: 'Error de conexión con el proveedor de pagos',
        message: error.message 
      });
    }
  });


  // =====================================================
  // 2️⃣ CONFIRMAR PAGO (Commit Transaction)
  // =====================================================
  app.all('/api/payments/confirm', async (req, res) => {
    const token = req.body.token_ws || req.query.token_ws;
    const frontendUrl = process.env.FRONTEND_URL || 'https://mitribu-backend.onrender.com';

    if (!token) {
      console.log("⚠️ Pago anulado por el usuario");
      return res.send(`
        <script>
          window.location.href="${frontendUrl}/api/payments/confirm/result?status=failed&reason=user_aborted"
        </script>
      `);
    }

    try {
      const tx = new WebpayPlus.Transaction();
      const commitResponse = await tx.commit(token);
      const { buy_order, status, authorization_code, card_detail, transaction_date } = commitResponse;

      console.log(`🔍 Buscando registro con buy_order: "${buy_order}"`);

      // ✅ PASO 1: Buscar el registro PRIMERO (separado del update)
      const { data: paymentRecord, error: fetchError } = await supabase
        .from('payments')
        .select('order_id, status')
        .eq('buy_order', buy_order)
        .single();

      if (fetchError || !paymentRecord) {
        console.error("❌ Registro no encontrado en DB:", fetchError?.message);
        console.error("   buy_order buscado:", buy_order);

        // Debug: mostrar últimos 5 registros para diagnosticar
        const { data: recent } = await supabase
          .from('payments')
          .select('buy_order, order_id, created_at')
          .order('created_at', { ascending: false })
          .limit(5);
        console.error("   Últimos 5 registros en payments:", JSON.stringify(recent));

        return res.send(`
          <script>
            window.location.href="${frontendUrl}/api/payments/confirm/result?status=failed&reason=record_not_found"
          </script>
        `);
      }

      if (status === 'AUTHORIZED') {
        console.log("✅ Pago autorizado con éxito para ID corto:", buy_order);

        // ✅ PASO 2: Actualizar el registro ahora que sabemos que existe
        await supabase
          .from('payments')
          .update({
            status: 'paid', 
            token: token,
            authorization_code: authorization_code,
            card_last4: card_detail?.card_number?.slice(-4),
            transaction_date: transaction_date,
            updated_at: new Date()
          })
          .eq('buy_order', buy_order);

        const uuidOriginal = paymentRecord.order_id;

        // ✅ PASO 3: Actualizar la orden original como pagada
        const { data: order, error: orderError } = await supabase
          .from('orders')
          .update({ status: 'paid', updated_at: new Date() })
          .eq('id', uuidOriginal)
          .select('shop_id, customer_id')
          .single();

        if (orderError) {
          console.error("❌ Error actualizando orden original:", orderError.message);
        }

        // ✅ PASO 4: Notificaciones en tiempo real mediante Sockets
        if (order) {
          io.emit(`new_paid_order_shop_${order.shop_id}`, {
            order_id: uuidOriginal,
            status: 'paid'
          });
          io.emit(`order_update_user_${order.customer_id}`, {
            order_id: uuidOriginal,
            status: 'paid'
          });
        }

        return res.send(`
          <script>
            window.location.href="${frontendUrl}/api/payments/confirm/result?status=paid&order=${uuidOriginal}"
          </script>
        `);

      } else {
        console.log("❌ Pago rechazado por Transbank:", status);

        await supabase
          .from('payments')
          .update({ status: 'failed', updated_at: new Date() })
          .eq('buy_order', buy_order);

        return res.send(`
          <script>
            window.location.href="${frontendUrl}/api/payments/confirm/result?status=failed"
          </script>
        `);
      }

    } catch (error) {
      console.error("❌ Error en Confirmación:", error.message);
      res.status(500).send(`Error interno procesando la confirmación: ${error.message}`);
    }
  });

};