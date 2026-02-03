const supabase = require('../services/supabase');

// Esta función se llama desde otros controladores cuando pasa algo importante
const logEvent = async (type, payload) => {
  await supabase.from('payment_events').insert({
    event_type: type,
    raw_payload: payload
  });
};

module.exports = { logEvent };