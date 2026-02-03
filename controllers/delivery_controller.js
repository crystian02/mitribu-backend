module.exports.controller = (app, io) => {
  // Estado en RAM para máxima velocidad
  global.delivery_positions = {}; 

  io.on('connection', (socket) => {
    // Escuchar posición desde la App del Repartidor (Flutter)
    socket.on('update_delivery_gps', (data) => {
      const { driver_id, lat, lon, order_id } = data;
      
      const positionData = {
        driver_id,
        lat,
        lon,
        updated_at: new Date().toISOString()
      };

      // Guardamos en RAM
      global.delivery_positions[driver_id] = positionData;

      // Emitimos solo a los interesados (Cliente de esa orden específica)
      io.emit(`tracking_order_${order_id}`, positionData);
    });
  });

  // Endpoint para que la App del cliente pida la posición inicial
  app.get('/api/delivery/location/:driver_id', (req, res) => {
    const pos = global.delivery_positions[req.params.driver_id];
    res.json({ status: "1", payload: pos || null });
  });
};