const supabase = require('../services/supabase');

module.exports.controller = (app, io) => {
  // Almacén temporal en memoria RAM para respuesta inmediata
  global.delivery_positions = {}; 

  io.on('connection', (socket) => {
    console.log('✅ Dispositivo de tracking conectado:', socket.id);
    
    // Recibir ubicación del Repartidor (desde Flutter o IoT)
    socket.on('update_delivery_gps', async (data) => {
      const { driver_id, lat, lon, order_id } = data;
      const now = new Date();

      // 1. Lógica de RAM (Tiempo Real)
      // Guardamos la posición anterior antes de actualizar para comparar el tiempo
      const lastPos = global.delivery_positions[driver_id];
      
      global.delivery_positions[driver_id] = {
        driver_id,
        lat,
        lon,
        updated_at: now
      };

      // 2. Emitir a Sockets (Movimiento fluido en el mapa del cliente)
      io.emit(`tracking_order_${order_id}`, { lat, lon });

      // 3. Persistencia en Supabase (Cada 5 minutos)
      // Solo insertamos en la BD si es la primera vez o si han pasado más de 300,000 ms (5 min)
      try {
        const shouldSaveInDB = !lastPos || (now - new Date(lastPos.updated_at)) > 5 * 60 * 1000;

        if (shouldSaveInDB) {
          console.log(`💾 Persistencia: Guardando historial GPS para conductor ${driver_id}`);
          
          const { error } = await supabase
            .from('delivery_route_history')
            .insert({
              vehicle_id: driver_id,
              // Usamos el formato de punto de Postgres (lat, lon) para tu tabla
              location: `(${lat},${lon})`, 
              recorded_at: now
            });

          if (error) console.error("❌ Error guardando historial GPS:", error.message);
        }
      } catch (err) {
        console.error("⚠️ Error crítico en lógica de persistencia GPS:", err.message);
      }
    });

    socket.on('disconnect', () => {
      console.log('❌ Dispositivo de tracking desconectado');
    });
  });

  // Endpoint REST para obtener la última posición (útil al cargar el mapa por primera vez)
  app.get('/api/delivery/location/:driver_id', (req, res) => {
    const pos = global.delivery_positions[req.params.driver_id];
    
    if (!pos) {
      return res.status(404).json({ 
        success: false, 
        message: "No hay una ubicación reciente para este repartidor" 
      });
    }

    res.json({ 
      success: true,
      payload: pos 
    });
  });
};