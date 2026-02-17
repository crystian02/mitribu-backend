// services/firebase.js
const admin = require('firebase-admin');
const path = require('path');

/**
 * En Render, los 'Secret Files' se depositan en la raíz del proyecto.
 * Usamos 'path.join' y '__dirname' para asegurar que la ruta sea absoluta 
 * y funcione tanto local como en el servidor.
 */
const serviceAccountPath = path.join(__dirname, '../serviceAccountKey.json');

if (!admin.apps.length) {
  try {
    const serviceAccount = require(serviceAccountPath);
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    
    console.log("✅ Firebase Admin SDK inicializado correctamente.");
  } catch (error) {
    console.error("❌ Error al cargar serviceAccountKey.json:", error.message);
  }
}

module.exports = admin;