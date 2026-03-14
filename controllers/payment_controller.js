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
      // Generamos el ID corto para Transbank (Max 26 caracteres)
      const shortBuyOrder = `${buyOrder.substring(0, 8)}-${Date.now().toString().slice(-10)}`;
      
      console.log(`🚀 Iniciando pago: Orden ${buyOrder} (ID Transbank: ${shortBuyOrder}) por $${amount}`);

      // 1. Registrar el intento en la tabla 'payments'
      const { error: paymentError } = await supabase
        .from('payments')
        .insert({
          order_id: buyOrder,      // UUID de 36 caracteres para tu DB
          user_id: sessionId,       
          amount: parseInt(amount), 
          status: 'pending',        
          provider: 'webpay',
          buy_order: shortBuyOrder  // ID corto para Transbank
        });

      if (paymentError) {
        console.error("❌ Error Supabase al insertar pago:", paymentError.message);
        return res.status(500).json({ 
          error: "No se pudo registrar el pago en la base de datos",
          details: paymentError.message 
        });
      }

      // 2. Crear transacción en Transbank
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

      if (status === 'AUTHORIZED') {
        console.log("✅ Pago autorizado con éxito:", buy_order);

        // 1. BUSQUEDA CORREGIDA: Usamos 'buy_order' (ID corto) para encontrar el registro
        const { data: paymentRecord, error: fetchError } = await supabase
          .from('payments')
          .update({
            status: 'paid', 
            token: token,
            authorization_code: authorization_code,
            card_last4: card_detail?.card_number?.slice(-4),
            transaction_date: transaction_date,
            updated_at: new Date()
          })
          .eq('buy_order', buy_order) // <--- CAMBIO CLAVE: Buscamos por el ID corto
          .select('order_id')
          .single();

        if (fetchError || !paymentRecord) {
           console.error("❌ No se encontró el registro con buy_order:", buy_order);
           throw new Error("No se encontró el registro del pago");
        }

        const uuidOriginal = paymentRecord.order_id; // Ahora tenemos el UUID real

        // 2. Actualizar la Orden original usando el UUID
        const { data: order } = await supabase
          .from('orders')
          .update({ status: 'paid', updated_at: new Date() })
          .eq('id', uuidOriginal)
          .select('shop_id, customer_id')
          .single();

        // 3. Notificaciones Sockets
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
        await supabase.from('payments').update({ status: 'failed' }).eq('buy_order', buy_order);
        
        return res.send(`
          <script>
            window.location.href="${frontendUrl}/api/payments/confirm/result?status=failed"
          </script>
        `);
      }

    } catch (error) {
      console.error("❌ Error en Confirmación:", error.message);
      res.status(500).send("Error interno procesando la confirmación del pago.");
    }
  });

};