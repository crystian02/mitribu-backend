// middleware/auth.js
const supabase = require('../services/supabase');


// =====================================================
// 🔐 AUTHENTICATE USER
// =====================================================
const authenticate = async (req, res, next) => {
  try {

    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: 'Token requerido' });
    }

    const token = authHeader.split(' ')[1];

    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }

    // Adjuntamos el usuario al request
    req.user = user;

    next();

  } catch (err) {
    return res.status(500).json({ error: 'Error autenticando usuario' });
  }
};



// =====================================================
// 🛡 REQUIRE ROLE DINÁMICO
// =====================================================
const requireRole = (role) => {
  return async (req, res, next) => {

    try {

      if (!req.user) {
        return res.status(401).json({ error: 'No autenticado' });
      }

      const { data: profile, error } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', req.user.id)
        .single();

      if (error || !profile) {
        return res.status(403).json({ error: 'Perfil no encontrado' });
      }

      if (profile.role !== role) {
        return res.status(403).json({
          error: `Acceso denegado: requiere rol ${role}`
        });
      }

      next();

    } catch (err) {
      return res.status(500).json({ error: 'Error validando rol' });
    }
  };
};



// =====================================================
// 👑 ALIAS PARA SUPERADMIN
// =====================================================
const isAdmin = requireRole('superadmin');


module.exports = {
  authenticate,
  requireRole,
  isAdmin
};