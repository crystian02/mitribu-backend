// controllers/payment_controller.js
const { WebpayPlus } = require('transbank-sdk');
const supabase = require('../services/supabase');

module.exports.controller = (app, io) => {

  // =====================================================
  // 1️⃣ INICIAR PAGO
  // =====================================================
  app.post('/api/payments/create', async (req, res) => {
    const { buyOrder, sessionId, amount } = req.body;

    const host = process.env.API_URL || 'http://localhost:3000';
    const returnUrl = `${host}/api/payments/confirm`;

    try {

      // Crear registro en tabla payments (estado pending)
      const { error: paymentError } = await supabase
        .from('payments')
        .insert({
          order_id: buyOrder,
          user_id: sessionId,
          amount: amount,
          status: 'pending',
          provider: 'webpay'
        });

      if (paymentError) {
        console.error("Error creando payment:", paymentError);
        return res.status(500).json({ error: "No se pudo registrar el pago" });
      }

      const createResponse = await new WebpayPlus.Transaction().create(
        buyOrder,
        sessionId,
        amount,
        returnUrl
      );

      res.json(createResponse);

    } catch (error) {
      console.error("Error Webpay Create:", error);
      res.status(500).json({ error: 'Error iniciando pago con Transbank' });
    }
  });



  // =====================================================
  // 2️⃣ CONFIRMAR PAGO
  // =====================================================
  app.all('/api/payments/confirm', async (req, res) => {

    const token = req.body.token_ws || req.query.token_ws;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    if (!token) {
      return res.send(`
        <script>
          alert("Pago anulado por usuario");
          window.location.href="${frontendUrl}/payment-failed"
        </script>
      `);
    }

    try {

      const tx = new WebpayPlus.Transaction();
      const commitResponse = await tx.commit(token);

      const {
        buy_order,
        amount,
        status,
        authorization_code,
        card_detail,
        transaction_date
      } = commitResponse;

      if (status === 'AUTHORIZED') {

        console.log("✅ Pago autorizado:", buy_order);

        // 1️⃣ Actualizar tabla payments
        await supabase
          .from('payments')
          .update({
            status: 'paid',
            token: token,
            authorization_code: authorization_code,
            card_last4: card_detail?.card_number?.slice(-4) || null,
            transaction_date: transaction_date,
            updated_at: new Date()
          })
          .eq('order_id', buy_order);

        // 2️⃣ Actualizar orden
        const { data: order, error: orderError } = await supabase
          .from('orders')
          .update({
            status: 'paid',
            updated_at: new Date()
          })
          .eq('id', buy_order)
          .select('shop_id')
          .single();

        if (orderError) {
          console.error("Error actualizando orden:", orderError);
        }

        // 3️⃣ Emitir evento tiempo real al comercio
        if (order) {
          io.emit(`new_paid_order_shop_${order.shop_id}`, {
            order_id: buy_order,
            amount: amount,
            status: 'paid'
          });
        }

        return res.send(`
          <script>
            window.location.href="${frontendUrl}/payment-success?order=${buy_order}"
          </script>
        `);

      } else {

        console.log("❌ Pago rechazado:", buy_order);

        // Actualizar tabla payments como rejected
        await supabase
          .from('payments')
          .update({
            status: 'failed',
            token: token,
            updated_at: new Date()
          })
          .eq('order_id', buy_order);

        return res.send(`
          <script>
            window.location.href="${frontendUrl}/payment-failed"
          </script>
        `);
      }

    } catch (error) {

      console.error("❌ Error Webpay Commit:", error);

      return res.status(500).send("Error procesando la confirmación del pago.");
    }
  });

};