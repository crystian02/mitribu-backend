const { WebpayPlus } = require('transbank-sdk');
const supabase = require('../services/supabase');

module.exports.controller = (app, io) => {

  // =====================================================
  // 1️⃣ INICIAR PAGO (Create Transaction)
  // =====================================================
  app.post('/api/payments/create', async (req, res) => {
    // buyOrder es el ID del pedido (UUID) y sessionId es el ID del usuario
    const { buyOrder, sessionId, amount } = req.body;

    // Detectar automáticamente la URL de Render para construir el retorno de Transbank
    // Transbank requiere HTTPS y una URL pública (no localhost)
    const host = process.env.RENDER_EXTERNAL_URL || process.env.API_URL || 'http://localhost:10000';
    const returnUrl = `${host}/api/payments/confirm`;

    try {
      console.log(`🚀 Iniciando pago: Orden ${buyOrder} por $${amount}`);

      // 1. Registrar el intento en la tabla 'payments' de Supabase
      // Se requiere que services/supabase.js use la SERVICE_ROLE_KEY para saltar RLS
      const { error: paymentError } = await supabase
        .from('payments')
        .insert({
          order_id: buyOrder,      
          user_id: sessionId,       
          amount: parseInt(amount), // Webpay Plus solo acepta montos enteros
          status: 'pending',        
          provider: 'webpay',
          buy_order: `BT-${Date.now()}` // Identificador único para la sesión de Transbank
        });

      if (paymentError) {
        console.error("❌ Error Supabase al insertar pago:", paymentError.message);
        return res.status(500).json({ 
          error: "No se pudo registrar el pago en la base de datos",
          details: paymentError.message 
        });
      }

      // 2. Crear la transacción en Transbank Webpay Plus
      // Se usan las variables de entorno configuradas en Render (TBK_API_KEY, etc)
      const createResponse = await new WebpayPlus.Transaction().create(
        buyOrder, 
        sessionId, 
        parseInt(amount), 
        returnUrl
      );

      res.json(createResponse);

    } catch (error) {
      // Si llegamos aquí, es probable que las credenciales de Transbank estén mal 
      // o la URL de retorno no sea HTTPS/válida.
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
    // Transbank envía el token vía POST o GET dependiendo del flujo
    const token = req.body.token_ws || req.query.token_ws;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    if (!token) {
      console.log("⚠️ Pago anulado: No se recibió token del usuario");
      // Redirigir al cliente a una pantalla de fallo en la App
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

        // 1. Actualizar el registro del Pago como exitoso
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
          .eq('order_id', buy_order);

        // 2. Marcar la Orden como pagada para que el comercio empiece a preparar
        const { data: order } = await supabase
          .from('orders')
          .update({ status: 'paid', updated_at: new Date() })
          .eq('id', buy_order)
          .select('shop_id, customer_id')
          .single();

        // 3. Notificar en tiempo real mediante Sockets
        if (order) {
          // Notificar al panel del Vendedor
          io.emit(`new_paid_order_shop_${order.shop_id}`, {
            order_id: buy_order,
            status: 'paid'
          });
          // Notificar al cliente en la App móvil
          io.emit(`order_update_user_${order.customer_id}`, {
            order_id: buy_order,
            status: 'paid'
          });
        }

        // Redirección de éxito capturada por el WebView en Flutter
        return res.send(`
          <script>
            window.location.href="${frontendUrl}/api/payments/confirm/result?status=paid&order=${buy_order}"
          </script>
        `);

      } else {
        console.log("❌ Pago rechazado por Transbank:", status);
        
        await supabase
          .from('payments')
          .update({ status: 'failed', updated_at: new Date() })
          .eq('order_id', buy_order);

        return res.send(`
          <script>
            window.location.href="${frontendUrl}/api/payments/confirm/result?status=failed&order=${buy_order}"
          </script>
        `);
      }

    } catch (error) {
      console.error("❌ Error en Proceso de Confirmación (Commit):", error.message);
      res.status(500).send("Error interno procesando la confirmación del pago.");
    }
  });

};