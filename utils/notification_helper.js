// utils/notification_helper.js
const supabase = require('../services/supabase');
const admin = require('../services/firebase');

async function notifyUser(userId, title, body, data = {}) {
  try {
    // 1. Buscamos los tokens FCM del usuario (puede tener varios: celular, tablet, etc.)
    const { data: tokens, error } = await supabase
      .from('fcm_tokens')
      .select('token')
      .eq('user_id', userId);

    if (error || !tokens || tokens.length === 0) {
      console.log(`⚠️ El usuario ${userId} no tiene tokens para notificar.`);
      return;
    }

    // 2. Extraemos la lista de tokens limpia
    const tokenList = tokens.map(t => t.token);

    // 3. Preparamos el mensaje Multicast (a múltiples dispositivos del mismo dueño)
    const message = {
      tokens: tokenList,
      notification: {
        title: title,
        body: body
      },
      // Datos extra para que la App sepa qué pantalla abrir al tocar
      data: {
        ...data,
        click_action: 'FLUTTER_NOTIFICATION_CLICK' 
      }
    };

    // 4. Enviar vía Firebase
    const response = await admin.messaging().sendMulticast(message);
    console.log(`✅ Notificación personal enviada. Éxitos: ${response.successCount}`);

  } catch (err) {
    console.error('Error enviando notificación personal:', err);
  }
}

module.exports = { notifyUser };