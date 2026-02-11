const { WebpayPlus } = require('transbank-sdk');
const supabase = require('../services/supabase');

module.exports.controller = (app, io) => {
  
  // 1. INICIAR PAGO (El Frontend llama aquí)
  app.post('/api/payments/create', async (req, res) => {
    const { buyOrder, sessionId, amount } = req.body;
    
    // URL de retorno (Asegúrate que coincida con tu backend público o localhost)
    // En producción esto debe ser tu dominio real (ej: https://api.mitribu.com/api/payments/confirm)
    const host = process.env.API_URL || 'http://localhost:3000';
    const returnUrl = `${host}/api/payments/confirm`;

    console.log("Iniciando pago para orden:", buyOrder);

    try {
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

  // 2. CONFIRMAR PAGO (Transbank llama aquí)
  app.all('/api/payments/confirm', async (req, res) => {
    const token = req.body.token_ws || req.query.token_ws;
    
    if (!token) {
        return res.send(`<script>alert("Pago anulado por usuario"); window.location.href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment-failed"</script>`);
    }

    try {
        const tx = new WebpayPlus.Transaction();
        const commitResponse = await tx.commit(token);

        if (commitResponse.status === 'AUTHORIZED') {
            console.log("Pago Aprobado:", commitResponse.buy_order);

            // A. Actualizamos la Orden en Supabase
            const { data: order, error } = await supabase
                .from('orders')
                .update({ 
                    status: 'paid', 
                    payment_token: token,
                    updated_at: new Date()
                })
                .eq('id', commitResponse.buy_order)
                .select('shop_id')
                .single();

            if (error) console.error("Error actualizando orden Supabase:", error);

            // B. Notificamos al Dashboard en Tiempo Real (Socket)
            if (order) {
                io.emit(`new_paid_order_shop_${order.shop_id}`, { 
                    order_id: commitResponse.buy_order,
                    amount: commitResponse.amount,
                    status: 'paid'
                });
            }

            // C. Redirigir al usuario a la pantalla de éxito
            const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
            res.send(`<script>window.location.href="${frontendUrl}/payment-success?order=${commitResponse.buy_order}"</script>`);
        } else {
            // Pago rechazado
            const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
            res.send(`<script>window.location.href="${frontendUrl}/payment-failed"</script>`);
        }
    } catch (error) {
        console.error("Error Webpay Commit:", error);
        res.status(500).send("Error procesando la confirmación del pago.");
    }
  });
};