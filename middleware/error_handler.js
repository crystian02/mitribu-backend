// middleware/error_handler.js
const errorHandler = (err, req, res, next) => {
  console.error(`[ERROR LOG]: ${err.stack}`);

  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    message: err.message || 'Error interno del servidor',
    // Solo enviamos el stack de error si no estamos en producción
    stack: process.env.NODE_ENV === 'production' ? null : err.stack,
  });
};

module.exports = errorHandler;