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
        order_id: buyOrder,
        user_id: sessionId,
        amount: parseInt(amount),
        status: 'pending',
        provider: 'webpay',
        buy_order: shortBuyOrder
      });

      if (paymentError) return res.status(500).json({ error: paymentError.message });

      const createResponse = await new WebpayPlus.Transaction().create(
        shortBuyOrder,
        sessionId,
        parseInt(amount),
        returnUrl
      );

      res.json(createResponse);

    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // =====================================================
  // 2️⃣ CONFIRMAR PAGO (CON ESTADOS SEPARADOS)
  // =====================================================
  app.all('/api/payments/confirm', async (req, res) => {
    const token = req.body.token_ws || req.query.token_ws;
    const frontendUrl = process.env.FRONTEND_URL || 'https://mitribu-backend.onrender.com';

    if (!token) {
      return res.send(`<script>window.location.href="${frontendUrl}/api/payments/confirm/result?status=failed&reason=user_aborted"</script>`);
    }

    try {
      const commitResponse = await new WebpayPlus.Transaction().commit(token);

      const {
        buy_order,
        status,
        authorization_code,
        card_detail,
        transaction_date
      } = commitResponse;

      const { data: paymentRecord, error: fetchError } = await supabase
        .from('payments')
        .select('order_id, status')
        .eq('buy_order', buy_order)
        .single();

      if (fetchError || !paymentRecord) {
        return res.send(`<script>window.location.href="${frontendUrl}/api/payments/confirm/result?status=failed&reason=record_not_found"</script>`);
      }

      if (status === 'AUTHORIZED') {

        const uuidOriginal = paymentRecord.order_id;

        // ✅ 1. Actualizar pago
        await supabase.from('payments').update({
          status: 'paid',
          token: token,
          authorization_code: authorization_code,
          card_last4: card_detail?.card_number?.slice(-4),
          transaction_date: transaction_date,
          updated_at: new Date()
        }).eq('buy_order', buy_order);

        // ✅ 2. Detectar multi-tienda
        const { data: mainOrder } = await supabase
          .from('orders')
          .select('batch_id, shop_id, customer_id')
          .eq('id', uuidOriginal)
          .single();

        let ordersToProcess = [];

        if (mainOrder && mainOrder.batch_id) {
          console.log(`📦 Lote Multi-Tienda: ${mainOrder.batch_id}`);

          const { data: batchOrders } = await supabase
            .from('orders')
            .select('id, shop_id, customer_id')
            .eq('batch_id', mainOrder.batch_id);

          ordersToProcess = batchOrders || [];

        } else if (mainOrder) {
          ordersToProcess = [{
            id: uuidOriginal,
            shop_id: mainOrder.shop_id,
            customer_id: mainOrder.customer_id
          }];
        }

        // =====================================================
        // 🔥 3. PROCESAR ÓRDENES (CON NUEVOS ESTADOS)
        // =====================================================
        for (const order of ordersToProcess) {

          const currentOrderId = order.id;

          // ✅ A. ESTADO BASE (TIENDA + DRIVER + CLIENTE)
          await supabase.from('orders').update({
            status: 'paid',                // tienda
            driver_status: 'pending',     // repartidor
            customer_status: 'waiting',   // cliente
            updated_at: new Date()
          }).eq('id', currentOrderId);

          // ✅ B. GENERAR QR
          const qrSecret = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);

          await supabase.from('delivery_tokens').insert({
            order_id: currentOrderId,
            qr_secret: qrSecret
          });

          // ✅ C. DESCONTAR STOCK
          const { data: orderItems } = await supabase
            .from('order_items')
            .select('product_id, quantity, products(shop_id)')
            .eq('order_id', currentOrderId);

          if (orderItems && orderItems.length > 0) {
            for (const item of orderItems) {

              if (item.products) {

                const { data: currentProduct } = await supabase
                  .from('products')
                  .select('stock')
                  .eq('id', item.product_id)
                  .single();

                if (currentProduct) {
                  const newStock = Math.max(0, currentProduct.stock - item.quantity);

                  await supabase.from('products')
                    .update({ stock: newStock })
                    .eq('id', item.product_id)
                    .eq('shop_id', item.products.shop_id);

                  console.log(`➖ Stock: -${item.quantity} producto ${item.product_id}`);
                }
              }
            }
          }

          // ✅ D. SOCKETS (CLIENTE + TIENDA)
          io.emit(`new_paid_order_shop_${order.shop_id}`, {
            order_id: currentOrderId,
            status: 'paid'
          });

          io.emit(`order_update_user_${order.customer_id}`, {
            order_id: currentOrderId,
            customer_status: 'waiting'
          });

        }

        return res.send(`<script>window.location.href="${frontendUrl}/api/payments/confirm/result?status=paid&order=${uuidOriginal}"</script>`);

      } else {

        await supabase.from('payments')
          .update({ status: 'failed', updated_at: new Date() })
          .eq('buy_order', buy_order);

        return res.send(`<script>window.location.href="${frontendUrl}/api/payments/confirm/result?status=failed"</script>`);
      }

    } catch (error) {
      res.status(500).send(`Error interno: ${error.message}`);
    }
  });

  // =====================================================
  // 3️⃣ REEMBOLSO (CON RESET DE ESTADOS)
  // =====================================================
  app.post('/api/payments/refund', async (req, res) => {

    const { orderId, amount } = req.body;

    try {
      console.log(`⏪ Reembolso iniciado: ${orderId}`);

      const { data: payment, error: fetchError } = await supabase
        .from('payments')
        .select('id, token, amount, buy_order')
        .eq('order_id', orderId)
        .eq('status', 'paid')
        .single();

      if (fetchError || !payment) {
        return res.status(404).json({ error: "Pago no encontrado o ya reembolsado" });
      }

      const refundAmount = amount ? parseInt(amount) : payment.amount;

      const refundResponse = await new WebpayPlus.Transaction().refund(
        payment.token,
        refundAmount
      );

      if (refundResponse.type === 'REVERSED' || refundResponse.type === 'NULLIFIED') {

        // ✅ 1. actualizar pago
        await supabase.from('payments').update({
          status: 'refunded',
          updated_at: new Date()
        }).eq('order_id', orderId);

        await supabase.from('payment_events').insert({
          payment_id: payment.id,
          event_type: 'refund',
          raw_payload: refundResponse
        });

        // ✅ 2. detectar lote
        const { data: mainOrder } = await supabase
          .from('orders')
          .select('batch_id')
          .eq('id', orderId)
          .single();

        let ordersToRefund = [];

        if (mainOrder && mainOrder.batch_id) {
          const { data: batchOrders } = await supabase
            .from('orders')
            .select('id')
            .eq('batch_id', mainOrder.batch_id);

          ordersToRefund = batchOrders || [];
        } else {
          ordersToRefund = [{ id: orderId }];
        }

        // =====================================================
        // 🔥 RESET COMPLETO DE ESTADOS
        // =====================================================
        for (const order of ordersToRefund) {

          await supabase.from('orders').update({
            status: 'cancelled',
            driver_status: 'cancelled',
            customer_status: 'cancelled',
            updated_at: new Date()
          }).eq('id', order.id);

          const { data: orderItems } = await supabase
            .from('order_items')
            .select('product_id, quantity, products(shop_id, name, stock)')
            .eq('order_id', order.id);

          if (orderItems && orderItems.length > 0) {
            for (const item of orderItems) {

              if (item.products) {

                const newStock = item.products.stock + item.quantity;

                await supabase.from('products')
                  .update({ stock: newStock })
                  .eq('id', item.product_id)
                  .eq('shop_id', item.products.shop_id);

                console.log(`➕ Stock devuelto: ${item.products.name}`);
              }
            }
          }
        }

        res.json({
          success: true,
          message: "Reembolso completo con estados reseteados",
          details: refundResponse
        });

      } else {
        res.status(400).json({
          error: "Transbank rechazó el reembolso",
          details: refundResponse
        });
      }

    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

};