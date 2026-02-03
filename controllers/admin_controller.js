const supabase = require('../services/supabase');

module.exports.controller = (app, io) => {
  // Crear nuevo producto
  app.post('/api/admin/products', async (req, res) => {
    const { shop_id, name, price, aisle_id, image_url } = req.body;

    const { data, error } = await supabase
      .from('products')
      .insert([{ shop_id, name, price, aisle_id, image_url }])
      .select();

    if (error) return res.status(400).json({ ok: false, error });
    
    // Notificar por Socket que el inventario cambió (opcional)
    io.emit(`inventory_updated_${shop_id}`, data);
    
    res.json({ ok: true, data });
  });
};