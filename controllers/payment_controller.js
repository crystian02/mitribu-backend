// controllers/payment_controller.js
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
      
      const { error: paymentError } = await supabase.from('payments').insert({
        order_id: buyOrder, user_id: sessionId, amount: parseInt(amount), 
        status: 'pending', provider: 'webpay', buy_order: shortBuyOrder
      });

      if (paymentError) return res.status(500).json({ error: paymentError.message });

      const createResponse = await new WebpayPlus.Transaction().create(shortBuyOrder, sessionId, parseInt(amount), returnUrl);
      res.json(createResponse);

    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // =====================================================
  // 2️⃣ CONFIRMAR PAGO Y DESCONTAR STOCK (Commit)
  // =====================================================
  app.all('/api/payments/confirm', async (req, res) => {
    const token = req.body.token_ws || req.query.token_ws;
    const frontendUrl = process.env.FRONTEND_URL || 'https://mitribu-backend.onrender.com';

    if (!token) return res.send(`<script>window.location.href="${frontendUrl}/api/payments/confirm/result?status=failed&reason=user_aborted"</script>`);

    try {
      const commitResponse = await new WebpayPlus.Transaction().commit(token);
      const { buy_order, status, authorization_code, card_detail, transaction_date } = commitResponse;

      const { data: paymentRecord, error: fetchError } = await supabase.from('payments').select('order_id, status').eq('buy_order', buy_order).single();

      if (fetchError || !paymentRecord) return res.send(`<script>window.location.href="${frontendUrl}/api/payments/confirm/result?status=failed&reason=record_not_found"</script>`);

      if (status === 'AUTHORIZED') {
        const uuidOriginal = paymentRecord.order_id;

        // 1. Actualizar pago
        await supabase.from('payments').update({
          status: 'paid', token: token, authorization_code: authorization_code,
          card_last4: card_detail?.card_number?.slice(-4), transaction_date: transaction_date, updated_at: new Date()
        }).eq('buy_order', buy_order);

        // 2. Crear QR
        const qrSecret = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
        await supabase.from('delivery_tokens').insert({ order_id: uuidOriginal, qr_secret: qrSecret });

        // 3. Actualizar Orden
        const { data: order } = await supabase.from('orders').update({ status: 'paid', updated_at: new Date() }).eq('id', uuidOriginal).select('shop_id, customer_id').single();

        // =========================================================
        // ✅ AQUÍ ESTÁ LO QUE FALTABA: DESCONTAR STOCK AL VENDER
        // =========================================================
        console.log("📉 Descontando stock de los productos vendidos...");
        
        const { data: orderItems } = await supabase
          .from('order_items')
          .select('product_id, quantity, products(shop_id)')
          .eq('order_id', uuidOriginal);

        if (orderItems && orderItems.length > 0) {
          for (const item of orderItems) {
            if (item.products) {
              const { data: currentProduct } = await supabase.from('products').select('stock').eq('id', item.product_id).single();

              if (currentProduct) {
                // Evitar que el stock baje de cero (por seguridad)
                const newStock = Math.max(0, currentProduct.stock - item.quantity); 
                
                await supabase.from('products').update({ stock: newStock })
                  .eq('id', item.product_id)
                  .eq('shop_id', item.products.shop_id); // Seguro multi-tienda
                  
                console.log(`➖ Stock descontado: -${item.quantity} al producto ${item.product_id} (Tienda: ${item.products.shop_id})`);
              }
            }
          }
        }

        // 5. Notificar a las apps (Sockets)
        if (order) {
          io.emit(`new_paid_order_shop_${order.shop_id}`, { order_id: uuidOriginal, status: 'paid' });
          io.emit(`order_update_user_${order.customer_id}`, { order_id: uuidOriginal, status: 'paid' });
        }

        return res.send(`<script>window.location.href="${frontendUrl}/api/payments/confirm/result?status=paid&order=${uuidOriginal}"</script>`);

      } else {
        await supabase.from('payments').update({ status: 'failed', updated_at: new Date() }).eq('buy_order', buy_order);
        return res.send(`<script>window.location.href="${frontendUrl}/api/payments/confirm/result?status=failed"</script>`);
      }

    } catch (error) {
      res.status(500).send(`Error interno procesando la confirmación: ${error.message}`);
    }
  });

  // =====================================================
  // 3️⃣ REEMBOLSO / ANULACIÓN (Refund) + REPOSICIÓN MULTI-TIENDA
  // =====================================================
  app.post('/api/payments/refund', async (req, res) => {
    const { orderId, amount } = req.body; 

    try {
      console.log(`⏪ Iniciando reembolso para orden: ${orderId}`);

      const { data: payment, error: fetchError } = await supabase.from('payments').select('id, token, amount, buy_order').eq('order_id', orderId).eq('status', 'paid').single();
      if (fetchError || !payment) return res.status(404).json({ error: "No se encontró un pago aprobado para esta orden o ya fue reembolsado." });

      const refundAmount = amount ? parseInt(amount) : payment.amount;
      const refundResponse = await new WebpayPlus.Transaction().refund(payment.token, refundAmount);

      if (refundResponse.type === 'REVERSED' || refundResponse.type === 'NULLIFIED') {
        
        await supabase.from('payments').update({ status: 'refunded', updated_at: new Date() }).eq('order_id', orderId);
        await supabase.from('orders').update({ status: 'cancelled', updated_at: new Date() }).eq('id', orderId);
        await supabase.from('payment_events').insert({ payment_id: payment.id, event_type: 'refund', raw_payload: refundResponse });

        // =========================================================
        // ✅ AQUÍ ESTÁ LO QUE FALTABA: REPONER STOCK
        // =========================================================
        console.log("📦 Iniciando reposición de stock en el comercio...");
        
        const { data: orderItems } = await supabase
          .from('order_items')
          .select('product_id, quantity, products(shop_id, name, stock)')
          .eq('order_id', orderId);

        if (orderItems && orderItems.length > 0) {
          for (const item of orderItems) {
            if (item.products) {
              const newStock = item.products.stock + item.quantity;
              await supabase.from('products').update({ stock: newStock }).eq('id', item.product_id).eq('shop_id', item.products.shop_id); 
              console.log(`➕ Se devolvieron ${item.quantity} unidades de "${item.products.name}" a la tienda ID: ${item.products.shop_id}`);
            }
          }
        }

        res.json({ success: true, message: "Reembolso y reposición procesados", details: refundResponse });
      } else {
        res.status(400).json({ error: "Transbank rechazó el reembolso", details: refundResponse });
      }

    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

};