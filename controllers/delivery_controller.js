// controllers/delivery_controller.js
const supabase = require('../services/supabase');

module.exports.controller = (app, io) => {

  // ==========================================
  // ALMACÉN EN MEMORIA (Tiempo real)
  // ==========================================
  if (!global.delivery_positions) {
    global.delivery_positions = {};
  }

  // ==========================================
  // LIMPIEZA AUTOMÁTICA (evita memory leak)
  // ==========================================
  setInterval(() => {
    const now = Date.now();
    const TEN_MIN = 10 * 60 * 1000;

    Object.keys(global.delivery_positions).forEach(driverId => {
      const lastUpdate = new Date(global.delivery_positions[driverId].updated_at).getTime();

      if (now - lastUpdate > TEN_MIN) {
        delete global.delivery_positions[driverId];
        console.log(`🧹 Limpieza RAM: driver ${driverId} eliminado por inactividad`);
      }
    });

  }, 5 * 60 * 1000);


  // ==========================================
  // SOCKET.IO
  // ==========================================
  io.on('connection', (socket) => {
    console.log('✅ Dispositivo de tracking conectado:', socket.id);

    // 🔐 IMPORTANTE:
    // NO confiamos en driver_id enviado por cliente.
    // Usamos el usuario autenticado del socket.
    const driver_id = socket.user?.id;

    if (!driver_id) {
      console.log("❌ Socket sin autenticación válida");
      return socket.disconnect();
    }

    socket.on('update_delivery_gps', async (data) => {
      try {

        const { lat, lon, order_id, vehicle_id } = data;
        const now = new Date();

        if (!lat || !lon || !order_id || !vehicle_id) {
          return;
        }

        const lastPos = global.delivery_positions[driver_id];

        // 1️⃣ Actualizar RAM
        global.delivery_positions[driver_id] = {
          driver_id,
          vehicle_id,
          lat,
          lon,
          order_id,
          updated_at: now
        };

        // 2️⃣ Emitir SOLO a clientes que escuchan ese pedido
        io.to(`order_${order_id}`).emit('delivery_position_update', {
          lat,
          lon
        });

        // 3️⃣ Persistencia cada 5 minutos
        const shouldSaveInDB =
          !lastPos ||
          (now - new Date(lastPos.updated_at)) > 5 * 60 * 1000;

        if (shouldSaveInDB) {
          console.log(`💾 Guardando historial GPS para vehículo ${vehicle_id}`);

          const { error } = await supabase
            .from('delivery_route_history')
            .insert({
              vehicle_id: vehicle_id,
              location: `(${lat},${lon})`,
              recorded_at: now
            });

          if (error) {
            console.error("❌ Error guardando historial GPS:", error.message);
          }
        }

      } catch (err) {
        console.error("⚠️ Error en update_delivery_gps:", err.message);
      }
    });

    socket.on('join_order_tracking', (order_id) => {
      socket.join(`order_${order_id}`);
    });

    socket.on('disconnect', () => {
      console.log('❌ Dispositivo de tracking desconectado:', socket.id);
    });
  });


  // ==========================================
  // ENDPOINT REST (última ubicación)
  // ==========================================
  app.get('/api/delivery/location/:driver_id', (req, res) => {

    const pos = global.delivery_positions[req.params.driver_id];

    if (!pos) {
      return res.status(404).json({
        success: false,
        message: "No hay ubicación reciente"
      });
    }

    res.json({
      success: true,
      payload: pos
    });
  });

};