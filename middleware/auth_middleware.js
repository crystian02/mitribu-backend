const supabase = require('../services/supabase');

const isAdmin = async (req, res, next) => {
  try {
    // 1. Obtener el token del header (Authorization: Bearer token_aqui)
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No se proporcionó un token' });

    const token = authHeader.split(' ')[1];

    // 2. Validar el usuario con Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) return res.status(401).json({ error: 'Token inválido o expirado' });

    // 3. Consultar el perfil para verificar el rol
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (profile?.role !== 'superadmin') {
      return res.status(403).json({ error: 'Acceso denegado: Se requiere rol de Superadmin' });
    }

    // Si todo está bien, pasamos al siguiente paso (el controlador)
    next();
  } catch (err) {
    res.status(500).json({ error: 'Error interno en autenticación' });
  }
};

module.exports = { isAdmin };