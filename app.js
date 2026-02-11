//!/usr/bin
'use strict';
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const logger = require('morgan');

// Configuración Express
const app = express();
const port = process.env.PORT || 3000;

app.use(logger('dev'));
app.use(cors()); // Vital para que el Frontend (React) pueda llamar a los Pagos
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Servidor HTTP + Sockets
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// --- CARGA DE CONTROLADORES ESENCIALES ---

// 1. Controlador de Pagos (Transbank)
const paymentController = require('./controllers/payment_controller');
paymentController.controller(app, io);

// 2. Controlador de Delivery (GPS en vivo)
const deliveryController = require('./controllers/delivery_controller');
deliveryController.controller(app, io);

// Ruta de Salud (Para verificar que está vivo)
app.get('/', (req, res) => {
  res.send('🚀 MiTribu Backend Light (Pagos + GPS) Online');
});

// Iniciar Servidor
server.listen(port, () => {
  console.log(`🚀 Backend corriendo en http://localhost:${port}`);
});

module.exports = app;