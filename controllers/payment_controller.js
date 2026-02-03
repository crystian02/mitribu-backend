const { WebpayPlus } = require('transbank-sdk');
const supabase = require('../services/supabase');

module.exports.controller = (app) => {
  app.post('/api/payments/create', async (req, res) => {
    try {
      const { order_id, amount } = req.body;
      const tx = new WebpayPlus.Transaction(); // Configura tus llaves en el constructor o env
      
      // El buyOrder es el ID de la orden de MiTribu
      const response = await tx.create(order_id, "session123", amount, process.env.PAYMENT_RETURN_URL);
      
      res.json({ ok: true, url: response.url, token: response.token });
    } catch (e) { res.status(500).send(e.message); }
  });

  app.all('/api/payments/confirm', async (req, res) => {
    const token = req.body.token_ws || req.query.token_ws;
    const tx = new WebpayPlus.Transaction();
    const commitResponse = await tx.commit(token);

    if (commitResponse.status === 'AUTHORIZED') {
      // ACTUALIZACIÓN CLAVE: Marcamos la orden como pagada
      await supabase
        .from('orders')
        .update({ status: 'paid' })
        .eq('id', commitResponse.buy_order);

      // Deep Link para la App MiTribu
      res.send(`<script>window.location.href="mitribu://payment?status=success&order=${commitResponse.buy_order}"</script>`);
    } else {
      res.send(`<script>window.location.href="mitribu://payment?status=failed"</script>`);
    }
  });
};