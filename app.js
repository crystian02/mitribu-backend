//!/usr/bin
'use strict';
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const logger = require('morgan');

// Importar el manejador de errores global
const errorHandler = require('./middleware/error_handler');

// Configuración Express
const app = express();
const port = process.env.PORT || 3000;

app.use(logger('dev'));
app.use(cors()); 
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Servidor HTTP + Sockets
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// --- CARGA DE CONTROLADORES ESENCIALES ---

// 1. Controlador de Pagos (Transbank)
const paymentController = require('./controllers/payment_controller');
paymentController.controller(app, io);

// 2. Controlador de Delivery (GPS en vivo + Persistencia)
const deliveryController = require('./controllers/delivery_controller');
deliveryController.controller(app, io);

// 3. Controlador de Avisos (Notificaciones Masivas + Estado Vendedor)
const adController = require('./controllers/ad_controller');
adController.controller(app, io);

// 4. Controlador de Soporte (Reclamos y Sugerencias con Notificación)
const supportController = require('./controllers/support_controller');
supportController.controller(app, io);

// Ruta de Salud
app.get('/', (req, res) => {
  res.send('🚀 MiTribu Backend Light (Pagos + GPS + Ads + Soporte) Online');
});

// --- MANEJO DE ERRORES GLOBAL ---
// Importante: Debe ir después de todos los controladores
app.use(errorHandler);

// Iniciar Servidor
server.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Backend corriendo en el puerto ${port}`);
});

module.exports = app;