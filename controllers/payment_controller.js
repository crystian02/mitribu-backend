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
  // 2️⃣ CONFIRMAR PAGO Y DESCONTAR STOCK MULTI-TIENDA (Commit)
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

        // 1. Actualizar estado del pago en la tabla payments
        await supabase.from('payments').update({
          status: 'paid', token: token, authorization_code: authorization_code,
          card_last4: card_detail?.card_number?.slice(-4), transaction_date: transaction_date, updated_at: new Date()
        }).eq('buy_order', buy_order);

        // 2. Verificar si la orden pertenece a un Lote (Multi-Tienda)
        const { data: mainOrder } = await supabase.from('orders').select('batch_id, shop_id, customer_id').eq('id', uuidOriginal).single();

        let ordersToProcess = [];

        if (mainOrder && mainOrder.batch_id) {
          // Es un pedido multi-tienda: traemos todas las órdenes de este lote
          console.log(`📦 Procesando Lote Multi-Tienda: ${mainOrder.batch_id}`);
          const { data: batchOrders } = await supabase.from('orders').select('id, shop_id, customer_id').eq('batch_id', mainOrder.batch_id);
          ordersToProcess = batchOrders || [];
        } else if (mainOrder) {
          // Es un pedido simple (compatible con versiones anteriores)
          ordersToProcess = [{ id: uuidOriginal, shop_id: mainOrder.shop_id, customer_id: mainOrder.customer_id }];
        }

        // 3. Procesar cada orden (Actualizar estado, QR, Stock y Sockets)
        for (const order of ordersToProcess) {
          const currentOrderId = order.id;

          // A. Marcar orden como pagada
          await supabase.from('orders').update({ status: 'paid', updated_at: new Date() }).eq('id', currentOrderId);

          // B. Crear QR de entrega
          const qrSecret = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
          await supabase.from('delivery_tokens').insert({ order_id: currentOrderId, qr_secret: qrSecret });

          // C. Descontar Stock de esta tienda
          const { data: orderItems } = await supabase
            .from('order_items')
            .select('product_id, quantity, products(shop_id)')
            .eq('order_id', currentOrderId);

          if (orderItems && orderItems.length > 0) {
            for (const item of orderItems) {
              if (item.products) {
                const { data: currentProduct } = await supabase.from('products').select('stock').eq('id', item.product_id).single();

                if (currentProduct) {
                  const newStock = Math.max(0, currentProduct.stock - item.quantity); 
                  await supabase.from('products').update({ stock: newStock })
                    .eq('id', item.product_id)
                    .eq('shop_id', item.products.shop_id); 
                    
                  console.log(`➖ Stock descontado: -${item.quantity} al producto ${item.product_id} (Tienda: ${item.products.shop_id})`);
                }
              }
            }
          }

          // D. Notificar vía Sockets al comercio y al cliente
          io.emit(`new_paid_order_shop_${order.shop_id}`, { order_id: currentOrderId, status: 'paid' });
          io.emit(`order_update_user_${order.customer_id}`, { order_id: currentOrderId, status: 'paid' });
        }
        
        // ✅ NUEVO: Notificar a todos los repartidores activos que hay un nuevo viaje disponible
        io.emit('new_order_available');

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
      console.log(`⏪ Iniciando reembolso para orden/lote vinculado a: ${orderId}`);

      const { data: payment, error: fetchError } = await supabase.from('payments').select('id, token, amount, buy_order').eq('order_id', orderId).eq('status', 'paid').single();
      if (fetchError || !payment) return res.status(404).json({ error: "No se encontró un pago aprobado para esta orden o ya fue reembolsado." });

      const refundAmount = amount ? parseInt(amount) : payment.amount;
      const refundResponse = await new WebpayPlus.Transaction().refund(payment.token, refundAmount);

      if (refundResponse.type === 'REVERSED' || refundResponse.type === 'NULLIFIED') {
        
        // 1. Marcar el pago como reembolsado
        await supabase.from('payments').update({ status: 'refunded', updated_at: new Date() }).eq('order_id', orderId);
        await supabase.from('payment_events').insert({ payment_id: payment.id, event_type: 'refund', raw_payload: refundResponse });

        // 2. Verificar si es Lote para cancelar y reponer todo
        const { data: mainOrder } = await supabase.from('orders').select('batch_id').eq('id', orderId).single();
        
        let ordersToRefund = [];
        if (mainOrder && mainOrder.batch_id) {
          const { data: batchOrders } = await supabase.from('orders').select('id').eq('batch_id', mainOrder.batch_id);
          ordersToRefund = batchOrders || [];
        } else {
          ordersToRefund = [{ id: orderId }];
        }

        // 3. Procesar anulación por cada orden
        for (const order of ordersToRefund) {
          await supabase.from('orders').update({ status: 'cancelled', updated_at: new Date() }).eq('id', order.id);

          const { data: orderItems } = await supabase
            .from('order_items')
            .select('product_id, quantity, products(shop_id, name, stock)')
            .eq('order_id', order.id);

          if (orderItems && orderItems.length > 0) {
            for (const item of orderItems) {
              if (item.products) {
                const newStock = item.products.stock + item.quantity;
                await supabase.from('products').update({ stock: newStock }).eq('id', item.product_id).eq('shop_id', item.products.shop_id); 
                console.log(`➕ Se devolvieron ${item.quantity} unidades de "${item.products.name}" a la tienda ID: ${item.products.shop_id}`);
              }
            }
          }
        }

        // 💡 Opcional: Notificar a los repartidores que un pedido fue cancelado para que refresquen su lista
        io.emit('new_order_available');

        res.json({ success: true, message: "Reembolso y reposición multitienda procesados", details: refundResponse });
      } else {
        res.status(400).json({ error: "Transbank rechazó el reembolso", details: refundResponse });
      }

    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

};