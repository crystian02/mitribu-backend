const supabase = require('../services/supabase');

module.exports.controller = (app, io) => {
  // Obtener tiendas cercanas para el mapa
  app.get('/api/shops/nearby', async (req, res) => {
    const { lat, lon, radio = 5000 } = req.query;

    const { data, error } = await supabase.rpc('get_shops_in_range', {
      user_lat: parseFloat(lat),
      user_lon: parseFloat(lon),
      range_meters: parseFloat(radio)
    });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ status: "1", payload: data });
  });

  // Obtener detalles de una tienda (Categorías y Productos)
  app.get('/api/shops/:id/catalog', async (req, res) => {
    const { data, error } = await supabase
      .from('aisles')
      .select('*, products(*)')
      .eq('shop_id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ status: "1", payload: data });
  });
};