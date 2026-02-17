// services/notification_service.js

const supabase = require('./supabase');
const admin = require('./firebase');

class NotificationService {

  // =====================================================
  // OBTENER TOKENS
  // =====================================================
  static async getTokens({ shopId = null }) {

    let query = supabase
      .from('fcm_tokens')
      .select('token');

    if (shopId) {
      query = query.eq('shop_id', shopId);
    }

    const { data, error } = await query;

    if (error) throw error;

    return data.map(t => t.token);
  }



  // =====================================================
  // ENVIAR MULTICAST SEGURO
  // =====================================================
  static async sendMulticast({ tokens, title, body, image = null, data = {} }) {

    if (!tokens.length) {
      return {
        success: 0,
        failed: 0,
        cleaned: 0
      };
    }

    let totalSuccess = 0;
    let totalFail = 0;
    const tokensToDelete = [];

    for (let i = 0; i < tokens.length; i += 500) {

      const chunk = tokens.slice(i, i + 500);

      const response = await admin.messaging().sendMulticast({
        tokens: chunk,
        notification: {
          title,
          body,
          image: image || undefined
        },
        data
      });

      totalSuccess += response.successCount;
      totalFail += response.failureCount;

      response.responses.forEach((resp, idx) => {

        if (!resp.success) {

          const errorCode = resp.error?.code;

          if (
            errorCode === 'messaging/registration-token-not-registered' ||
            errorCode === 'messaging/invalid-registration-token'
          ) {
            tokensToDelete.push(chunk[idx]);
          }
        }
      });
    }

    // Limpiar tokens inválidos
    if (tokensToDelete.length) {
      await supabase
        .from('fcm_tokens')
        .delete()
        .in('token', tokensToDelete);
    }

    return {
      success: totalSuccess,
      failed: totalFail,
      cleaned: tokensToDelete.length
    };
  }



  // =====================================================
  // BROADCAST (GLOBAL O POR TIENDA)
  // =====================================================
  static async sendBroadcast({
    shopId = null,
    title,
    body,
    image = null,
    data = {}
  }) {

    const tokens = await this.getTokens({ shopId });

    return await this.sendMulticast({
      tokens,
      title,
      body,
      image,
      data
    });
  }

}

module.exports = NotificationService;