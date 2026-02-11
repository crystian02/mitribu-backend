module.exports.controller = (app, io) => {
  // Almacén temporal en memoria RAM
  global.delivery_positions = {}; 

  io.on('connection', (socket) => {
    console.log('Cliente conectado al Socket:', socket.id);
    
    // Recibir ubicación del Repartidor
    socket.on('update_delivery_gps', (data) => {
      const { driver_id, lat, lon, order_id } = data;
      
      // Guardar en RAM
      global.delivery_positions[driver_id] = {
        driver_id,
        lat,
        lon,
        updated_at: new Date()
      };

      // Reenviar al Dashboard/Cliente que vigila esa orden
      io.emit(`tracking_order_${order_id}`, { lat, lon });
    });
  });

  // Endpoint REST para obtener la última posición (útil al cargar el mapa)
  app.get('/api/delivery/location/:driver_id', (req, res) => {
    const pos = global.delivery_positions[req.params.driver_id];
    res.json({ payload: pos || null });
  });
};